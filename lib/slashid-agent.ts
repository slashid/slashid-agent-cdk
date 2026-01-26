import * as cdk from 'aws-cdk-lib/core';
import * as directoryservice from 'aws-cdk-lib/aws-directoryservice';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { stringify as stringifyEnv } from 'envfile';
import { ensureVpcConnectivity } from './vpc-peering';
import { writeFile } from './userdata-utils';

/** Supported RDS database types for addPostgres (all have vpc and secret properties) */
type RdsDatabase = (rds.DatabaseCluster | rds.DatabaseInstance | rds.ServerlessCluster) & {
  vpc: ec2.IVpc;
  secret?: secretsmanager.ISecret;
};

/** Placeholder for credentials fetched from Secrets Manager at runtime */
const SECRET_PLACEHOLDER = '<secret>';

/** Default URL for uploading snapshots */
const DEFAULT_UPLOAD_URL = 'https://api.slashid.com/nhi/snapshots';

export interface SlashidAgentProps {
  logLevel?: 'CRITICAL' | 'FATAL' | 'ERROR' | 'WARNING' | 'INFO' | 'DEBUG';

  /**
   * Docker image to run.
   * @default 'slashid/agent'
   */
  containerImage?: string;
  /**
   * Name for the Docker container.
   * @default 'slashid-agent'
   */
  containerName?: string;
  /**
   * EC2 instance type.
   * @default t3a.micro
   */
  instanceType?: ec2.InstanceType;
  /**
   * CloudWatch log retention. If unset, logging to CloudWatch is disabled.
   * @default disabled
   */
  logRetentionDays?: logs.RetentionDays;
  /**
   * VPC to deploy into.
   * @default default VPC (looked up at synth time)
   */
  vpc?: ec2.IVpc;
}

/**
 * L3 construct that deploys a SlashID agent on an EC2 instance.
 *
 * The agent runs as a Docker container and can connect to PostgreSQL databases
 * and Active Directory domains to collect identity snapshots.
 */
export class SlashidAgent extends Construct {
  private readonly containerEnv: Record<string, string> = {};
  private readonly securityGroup: ec2.SecurityGroup;
  private readonly role: iam.Role;
  private readonly fetchSecretsScript: string[] = [
    '#!/bin/bash',
    '> /run/secrets.env',
  ];
  private readonly vpc: ec2.IVpc;
  private readonly peeredVpcIds = new Set<string>();
  private readonly envPrefixCounts = new Map<string, number>();

  constructor(scope: Construct, id: string, props: SlashidAgentProps = {}) {
    super(scope, id);

    const {
      logLevel = 'INFO',
      containerImage = 'slashid/agent',
      containerName = 'slashid-agent',
      instanceType = ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.MICRO),
      logRetentionDays,
      vpc: vpcProp,
    } = props;

    const stack = cdk.Stack.of(this);

    this.containerEnv['LOG_LEVEL'] = logLevel;

    // Use provided VPC or look up the default
    this.vpc = vpcProp ?? ec2.Vpc.fromLookup(this, "VPC", { isDefault: true });

    this.securityGroup = new ec2.SecurityGroup(this, "SecurityGroup", {
      vpc: this.vpc,
      description: "Allow Outbound traffic",
      allowAllOutbound: true,
      allowAllIpv6Outbound: true,
    });

    // IAM role to allow access to other AWS services
    this.role = new iam.Role(this, "EC2 Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
    });
    this.role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")
    );

    // CloudWatch log group for container logs (optional)
    if (logRetentionDays) {
      const logGroup = new logs.LogGroup(this, 'LogGroup', {
        logGroupName: `/ec2/slashid-agent`,
        retention: logRetentionDays,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      logGroup.grantWrite(this.role);
    }

    // Docker Compose configuration
    const composeConfig: Record<string, unknown> = {
      services: {
        [containerName]: {
          image: containerImage,
          container_name: containerName,
          restart: 'unless-stopped',
          network_mode: 'host',
          env_file: ['docker.env', '/run/secrets.env'],
          ...(logRetentionDays ? {
            logging: {
              driver: 'awslogs',
              options: {
                'awslogs-region': stack.region,
                'awslogs-group': `/ec2/slashid-agent`,
              },
            },
          } : {}),
        },
      },
    };

    // Shell script to start/update the container (pulls image, refreshes secrets, recreates if changed)
    const startContainerScript = `#!/bin/bash
cd /opt
./fetch_secrets.sh
docker compose up -d --pull always
docker image prune -f`;

    // User data to run the slashid/agent container
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      // Install Docker Compose plugin (not included in ECS-optimized AMI)
      'mkdir -p /usr/local/lib/docker/cli-plugins',
      'curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m) -o /usr/local/lib/docker/cli-plugins/docker-compose',
      'chmod +x /usr/local/lib/docker/cli-plugins/docker-compose',
      // Create docker-compose.yml
      cdk.Lazy.string({ produce: () => writeFile('/opt/docker-compose.yml', JSON.stringify(composeConfig, null, 2)) }),
      // Create environment file (uses Lazy to support addPostgres called after construction)
      cdk.Lazy.string({ produce: () => writeFile('/opt/docker.env', stringifyEnv(this.containerEnv)) }),
      // Create secrets fetch script
      cdk.Lazy.string({ produce: () => writeFile('/opt/fetch_secrets.sh', this.fetchSecretsScript.join('\n'), true) }),
      // Create start script and run it
      writeFile('/opt/start-container.sh', startContainerScript, true),
      '/opt/start-container.sh',
      // Install utilities and start crond, then add hourly cron job to check for updates
      'dnf install -y cronie iputils telnet bind-utils',
      'systemctl enable crond',
      'systemctl start crond',
      'echo "* * * * * root /opt/start-container.sh" > /etc/cron.d/container-update'
    );

    // ECS-optimized AMI comes with Docker pre-installed
    const ami = ecs.EcsOptimizedImage.amazonLinux2023(instanceType.architecture === ec2.InstanceArchitecture.X86_64
      ? ecs.AmiHardwareType.STANDARD
      : ecs.AmiHardwareType.ARM);

    const instance = new ec2.Instance(this, "server", {
      vpc: this.vpc,
      instanceType: instanceType,
      machineImage: ami,
      securityGroup: this.securityGroup,
      role: this.role,
      userData: userData,
      userDataCausesReplacement: true,
    });

    new cdk.CfnOutput(this, 'serverInstanceId', {
      value: instance.instanceId,
    });
  }

  private createEnvPrefix(prefix: string): string {
    const count = this.envPrefixCounts.get(prefix) ?? 0
    this.envPrefixCounts.set(prefix, count + 1)
    return `${prefix}_${count + 1}_`
  }

  private setUploadConfig(envPrefix: string, config: UploadConfig): void {
    this.containerEnv[`${envPrefix}SLASHID_AUTH_TOKEN`] = config.slashid_auth_token;
    this.containerEnv[`${envPrefix}UPLOAD_URL`] = config.upload_url ?? DEFAULT_UPLOAD_URL;
    if (config.upload_interval !== undefined) {
      this.containerEnv[`${envPrefix}UPLOAD_INTERVAL`] = config.upload_interval.toString();
    }
    if (config.max_consecutive_failures !== undefined) {
      this.containerEnv[`${envPrefix}MAX_CONSECUTIVE_FAILURES`] = config.max_consecutive_failures.toString();
    }
    if (config.max_backoff_interval !== undefined) {
      this.containerEnv[`${envPrefix}MAX_BACKOFF_INTERVAL`] = config.max_backoff_interval.toString();
    }
    this.containerEnv[`${envPrefix}OUTPUT_DIR`] = `/tmp/slashid-agent/${envPrefix}OUTPUT`;
  }

  /**
   * Connect to an PostgreSQL database.
   * 
   * It can either be an RDS database or a full set of credentials.
   * 
   * Connectivity is taken care of with RDS databases, otherwise this will need to be setup manually.
   * 
   * @param database The Postgres database to connect to
   * @param agentConfig the agent configuration
   */
  addPostgres(database: RdsDatabase | PostgresDatabaseInfo, agentConfig: PostgresAgentConfig): this {
    const envPrefix = this.createEnvPrefix("PSQL")
    const stack = cdk.Stack.of(this);

    if ('vpc' in database) { // Is an RDS Database
      const endpoint = 'clusterEndpoint' in database ? database.clusterEndpoint : database.instanceEndpoint;

      // Set up VPC peering if needed
      ensureVpcConnectivity(this, this.vpc, database.vpc, envPrefix, this.peeredVpcIds);

      // Allow the EC2 instance to connect to the database
      if (cdk.Stack.of(database) === stack) {
        // Same stack - safe to use security group reference
        database.connections.allowFrom(this.securityGroup, ec2.Port.tcp(endpoint.port), 'Allow PostgreSQL access from slashid-agent');
      } else {
        // Different stack - use CIDR to avoid cyclic dependency
        database.connections.allowFrom(ec2.Peer.ipv4(database.vpc.vpcCidrBlock), ec2.Port.tcp(endpoint.port), 'Allow PostgreSQL access from VPC');
      }

      // Grant access to the database secret and fetch credentials at boot time
      const secret = database.secret;
      if (secret) {
        secret.grantRead(this.role);
        // Fetch credentials from Secrets Manager and write to secrets file
        this.fetchSecretsScript.push(
          `SECRET=$(aws secretsmanager get-secret-value --secret-id ${secret.secretArn} --query SecretString --output text --region ${stack.region})`,
          `echo "${envPrefix}HOST=$(echo $SECRET | jq -r .host)" >> /run/secrets.env`,
          `echo "${envPrefix}PORT=$(echo $SECRET | jq -r .port)" >> /run/secrets.env`,
          `echo "${envPrefix}DBNAME=$(echo $SECRET | jq -r .dbname)" >> /run/secrets.env`,
          `echo "${envPrefix}USERNAME=$(echo $SECRET | jq -r .username)" >> /run/secrets.env`,
          `echo "${envPrefix}PASSWORD=$(echo $SECRET | jq -r .password)" >> /run/secrets.env`,
        );
      }

      database = {
        host: SECRET_PLACEHOLDER,
        port: 0,
        dbname: SECRET_PLACEHOLDER,
        username: SECRET_PLACEHOLDER,
        password: SECRET_PLACEHOLDER,
        use_ssl: false, // true,
      }
    }

    // Add database connection info to environment
    this.containerEnv[`${envPrefix}HOST`] = database.host
    this.containerEnv[`${envPrefix}PORT`] = database.port.toString();
    this.containerEnv[`${envPrefix}USE_SSL`] = database.use_ssl ? 'true' : 'false';
    this.containerEnv[`${envPrefix}DBNAME`] = database.dbname;
    this.containerEnv[`${envPrefix}USERNAME`] = database.username;
    this.containerEnv[`${envPrefix}PASSWORD`] = database.password;

    if (agentConfig.fetch_passwords !== undefined) {
      this.containerEnv[`${envPrefix}FETCH_PASSWORDS`] = agentConfig.fetch_passwords ? 'true' : 'false';
    }
    this.setUploadConfig(envPrefix, agentConfig);

    return this;
  }

  /**
   * Connect to an Active Directory domain.
   *
   * @param ad The AWS Managed Microsoft AD (CfnMicrosoftAD)
   * @param agentConfig the agent configuration including credentials
   */
  addActiveDirectory(ad: directoryservice.CfnMicrosoftAD, agentConfig: ActiveDirectoryAgentConfig): this {
    const envPrefix = this.createEnvPrefix("AD_SNAPSHOT");
    const stack = cdk.Stack.of(this);

    // FIXME: Currently doesn't work from a separate VPC

    // Set up VPC connectivity
    ensureVpcConnectivity(this, this.vpc, agentConfig.vpc, envPrefix, this.peeredVpcIds);

    // Note: AWS Managed Microsoft AD creates its own security group that allows
    // necessary traffic (LDAP, LDAPS, Kerberos, DNS) from within the VPC automatically.
    // No additional security group rules are needed when the agent is in the same VPC
    // or a peered VPC.

    // Grant access to the credentials secret and fetch password at boot time
    const secret = agentConfig.credentialsSecret;
    secret.grantRead(this.role);
    
    this.fetchSecretsScript.push(
      `SECRET=$(aws secretsmanager get-secret-value --secret-id ${secret.secretArn} --query SecretString --output text --region ${stack.region})`,
      `echo "${envPrefix}PASSWORD=$(echo $SECRET | jq -r .Password)" >> /run/secrets.env`,
    );

    // Add AD connection info to environment
    this.containerEnv[`${envPrefix}DOMAIN`] = ad.name;
    this.containerEnv[`${envPrefix}USERNAME`] = "Admin";
    this.containerEnv[`${envPrefix}PASSWORD`] = SECRET_PLACEHOLDER;

    // In AWS Managed Microsoft AD, the DNS servers are the domain controllers.
    // Use the first DNS IP address as the target DC.
    this.containerEnv[`${envPrefix}TARGET_DC`] = cdk.Fn.select(0, ad.attrDnsIpAddresses);
    // Use the first DNS IP address for FQDN resolution
    this.containerEnv[`${envPrefix}FQDN_RESOLVER`] = cdk.Fn.select(0, ad.attrDnsIpAddresses);

    // AWS Managed Microsoft AD uses LDAP on port 389 by default.
    // LDAPS (port 636) requires additional certificate configuration via
    // AWS Console or AWS::DirectoryService::SimpleLDAPS resource.
    this.containerEnv[`${envPrefix}LDAPS`] = 'false';
    this.containerEnv[`${envPrefix}LDAP_PORT`] = '389';

    if (agentConfig.collect_adcs !== undefined) {
      this.containerEnv[`${envPrefix}COLLECT_ADCS`] = agentConfig.collect_adcs ? 'true' : 'false';
    }
    if (agentConfig.collection_method !== undefined) {
      this.containerEnv[`${envPrefix}COLLECTION_METHOD`] = agentConfig.collection_method;
    }

    this.containerEnv[`${envPrefix}RUSTHOUND_PATH`] = "/usr/local/bin/rusthound-ce";
    this.containerEnv[`${envPrefix}OUTPUT_DIR`] = `/tmp/slashid-agent/${envPrefix}OUTPUT`;
    this.setUploadConfig(envPrefix, agentConfig);

    return this;
  }
}


export interface UploadConfig {
  slashid_auth_token: string

  upload_url?: string;
  upload_interval?: number;

  max_consecutive_failures?: number;
  max_backoff_interval?: number;
}

export interface PostgresAgentConfig extends UploadConfig {
  fetch_passwords?: boolean;
}

export interface PostgresDatabaseInfo {
  host: string
  port: number
  dbname: string
  username: string
  password: string
  use_ssl: boolean;
}

export interface ActiveDirectoryAgentConfig extends UploadConfig {
  /** VPC where the AD resides (for VPC peering if needed) */
  vpc: ec2.IVpc;
  /** Secret containing AD credentials (must have 'Password' key) */
  credentialsSecret: secretsmanager.ISecret;
  collect_adcs?: boolean;
  collection_method?: "All" | "DCOnly"  // Apparently RustHound-CE only supports these (SharpHound supports more options)
}