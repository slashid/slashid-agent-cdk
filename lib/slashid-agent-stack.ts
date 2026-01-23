import * as cdk from 'aws-cdk-lib/core';
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

export interface SlashidAgentStackProps extends cdk.StackProps {
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
   * @default t2.micro
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

export class SlashidAgentStack extends cdk.Stack {
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

  constructor(scope: Construct, id: string, props: SlashidAgentStackProps = {}) {
    const {
      logLevel = 'INFO',
      containerImage = 'slashid/agent',
      containerName = 'slashid-agent',
      instanceType = ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.MICRO),
      logRetentionDays,
      vpc: vpcProp,
      ...stackProps
    } = props;
    super(scope, id, stackProps);

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
                'awslogs-region': this.region,
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
      // Hourly cron job to check for updates
      'echo "0 * * * * root /opt/start-container.sh" > /etc/cron.d/container-update'
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

    new cdk.CfnOutput(this, 'ec2Ip', {
      value: instance.instancePublicIp,
    });
    new cdk.CfnOutput(this, 'ec2InstanceId', {
      value: instance.instanceId,
    });
  }

  private createEnvPrefix(prefix: string): string {
    const count = this.envPrefixCounts.get(prefix) ?? 0
    this.envPrefixCounts.set(prefix, count + 1)
    return `${prefix}_${count + 1}_`
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

    if ('vpc' in database) { // Is an RDS Database
      const endpoint = 'clusterEndpoint' in database ? database.clusterEndpoint : database.instanceEndpoint;

      // Set up VPC peering if needed
      ensureVpcConnectivity(this, this.vpc, database.vpc, 'Postgres', this.peeredVpcIds);

      // Allow the EC2 instance to connect to the database
      if (cdk.Stack.of(database) === this) {
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
          `SECRET=$(aws secretsmanager get-secret-value --secret-id ${secret.secretArn} --query SecretString --output text --region ${this.region})`,
          `echo "${envPrefix}HOST=$(echo $SECRET | jq -r .host)" >> /run/secrets.env`,
          `echo "${envPrefix}PORT=$(echo $SECRET | jq -r .port)" >> /run/secrets.env`,
          `echo "${envPrefix}DBNAME=$(echo $SECRET | jq -r .dbname)" >> /run/secrets.env`,
          `echo "${envPrefix}USERNAME=$(echo $SECRET | jq -r .username)" >> /run/secrets.env`,
          `echo "${envPrefix}PASSWORD=$(echo $SECRET | jq -r .password)" >> /run/secrets.env`,
        );
        console.log(this.fetchSecretsScript)
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
    if (database.use_ssl !== undefined) {
      this.containerEnv[`${envPrefix}USE_SSL`] = database.use_ssl ? 'true' : 'false';
    }
    this.containerEnv[`${envPrefix}DBNAME`] = database.dbname;
    this.containerEnv[`${envPrefix}USERNAME`] = database.username;
    this.containerEnv[`${envPrefix}PASSWORD`] = database.password;

    this.containerEnv[`${envPrefix}SLASHID_AUTH_TOKEN`] = agentConfig.slashid_auth_token;
    this.containerEnv[`${envPrefix}UPLOAD_URL`] = agentConfig.upload_url ?? DEFAULT_UPLOAD_URL;
    if (agentConfig.fetch_passwords !== undefined) {
      this.containerEnv[`${envPrefix}FETCH_PASSWORDS`] = agentConfig.fetch_passwords ? 'true' : 'false';
    }
    if (agentConfig.upload_interval !== undefined) {
      this.containerEnv[`${envPrefix}UPLOAD_INTERVAL`] = agentConfig.upload_interval.toString();
    }
    if (agentConfig.max_consecutive_failures !== undefined) {
      this.containerEnv[`${envPrefix}MAX_CONSECUTIVE_FAILURES`] = agentConfig.max_consecutive_failures.toString();
    }
    if (agentConfig.max_backoff_interval !== undefined) {
      this.containerEnv[`${envPrefix}MAX_BACKOFF_INTERVAL`] = agentConfig.max_backoff_interval.toString();
    }
    this.containerEnv[`${envPrefix}OUTPUT_DIR`] = `/tmp/slashid-agent/${envPrefix}OUTPUT`


    return this;
  }
}


export interface AgentConfig {
  slashid_auth_token: string
}

export interface PostgresAgentConfig extends AgentConfig {
  fetch_passwords?: boolean;
  upload_url?: string;
  upload_interval?: number;
  max_consecutive_failures?: number;
  max_backoff_interval?: number;
}

export interface PostgresDatabaseInfo {
  host: string
  port: number
  dbname: string
  username: string
  password: string
  use_ssl?: boolean;
}