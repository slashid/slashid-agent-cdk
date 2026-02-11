import * as cdk from 'aws-cdk-lib/core';
import { CfnMicrosoftAD } from 'aws-cdk-lib/aws-directoryservice';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { stringify as stringifyEnv } from 'envfile';
import { stringify as stringifyYaml } from 'yaml';
import { ensureVpcConnectivity } from './vpc-peering';
import { writeFile } from './userdata-utils';
import { v5 as uuidv5 } from 'uuid';
import { StringOrSecret, Credential, credentialFromSecret } from './credentials';

/** Default URL for uploading snapshots */
const DEFAULT_UPLOAD_URL = 'https://api.slashid.com/nhi/snapshots';
const DEFAULT_STREAM_URL = 'https://api.slashid.com/nhi/events';

export interface SlashidAgentProps {
  logLevel?: 'CRITICAL' | 'FATAL' | 'ERROR' | 'WARNING' | 'INFO' | 'DEBUG';

  /**
   * Docker image to run.
   * @default 'slashid/agent'
   */
  containerImage?: string;
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
  /** The EC2 instance running the agent */
  public readonly server: ec2.Instance;

  private readonly containerEnv: Record<string, string> = {};
  private readonly securityGroup: ec2.SecurityGroup;
  private readonly role: iam.Role;
  private readonly fetchSecretsCommands: string[] = [];
  private readonly vpc: ec2.IVpc;
  private readonly peeredVpcIds = new Set<string>();
  private readonly envPrefixCounts = new Map<string, number>();

  constructor(scope: Construct, id: string, props: SlashidAgentProps = {}) {
    super(scope, id);

    const {
      logLevel = 'INFO',
      containerImage = 'slashid/agent',
      instanceType = ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.MICRO),
      logRetentionDays,
      vpc: vpcProp,
    } = props;

    const stack = cdk.Stack.of(this);

    const agentInstanceId = uuidv5(`slashid-agent-cdk/${stack.account}/${stack.region}/${this.node.path}`, uuidv5.DNS);

    this.addEnv('LOG_LEVEL', logLevel);
    this.addEnv('STORAGE_BACKEND', 'static');
    this.addEnv('STORAGE_STATIC_agent_instance_id', agentInstanceId);

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
    const buildComposeConfig = () => ({
      services: {
        "slashid-agent": {
          image: containerImage,
          container_name: 'slashid-agent',
          restart: 'unless-stopped',
          network_mode: 'host',
          env_file: ['slashid-agent.env', '/run/slashid-agent-secrets.env'],
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
    });

    // Shell script to start/update the container (pulls image, refreshes secrets, recreates if changed)
    const buildStartScript = () => {
      const lines = [
        '#!/bin/bash',
        'set -e',
        'cd /opt',
        '> /run/slashid-agent-secrets.env',
        ...this.fetchSecretsCommands,
        'docker compose up -d --pull always',
        'docker image prune -f',
      ];
      return lines.join('\n');
    };

    // User data to run the slashid/agent container
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      // Update system, install utilities, Docker, and start crond
      'dnf update -y',
      'dnf install -y cronie iputils telnet bind-utils jq docker',
      'systemctl enable crond',
      'systemctl start crond',
      'systemctl enable docker',
      'systemctl start docker',
      'usermod -a -G docker ec2-user',
      // Install Docker Compose plugin
      'mkdir -p /usr/local/lib/docker/cli-plugins',
      'curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m) -o /usr/local/lib/docker/cli-plugins/docker-compose',
      'chmod +x /usr/local/lib/docker/cli-plugins/docker-compose',
      // Create docker-compose.yml (uses Lazy to support addPostgres called after construction)
      cdk.Lazy.string({ produce: () => writeFile('/opt/docker-compose.yml', stringifyYaml(buildComposeConfig())) }),
      // Create slashid-agent.env (uses Lazy to support addPostgres called after construction)
      cdk.Lazy.string({ produce: () => writeFile('/opt/slashid-agent.env', stringifyEnv(this.containerEnv)) }),
      // Create start script and run it
      cdk.Lazy.string({ produce: () => writeFile('/opt/start-slashid-agent.sh', buildStartScript(), true) }),
      '/opt/start-slashid-agent.sh',
      // Add hourly cron job to check for updates
      'echo "0 * * * * root /opt/start-slashid-agent.sh" > /etc/cron.d/container-update'
    );

    // Use standard Amazon Linux 2023 AMI, Docker will be installed via user data
    const ami = ec2.MachineImage.latestAmazonLinux2023({
      cpuType: instanceType.architecture === ec2.InstanceArchitecture.X86_64
        ? ec2.AmazonLinuxCpuType.X86_64
        : ec2.AmazonLinuxCpuType.ARM_64,
      cachedInContext: true,
    });

    this.server = new ec2.Instance(this, "server", {
      vpc: this.vpc,
      instanceType: instanceType,
      machineImage: ami,
      securityGroup: this.securityGroup,
      role: this.role,
      userData: userData,
      userDataCausesReplacement: true,
    });

    new cdk.CfnOutput(this, 'agentEnv', {
      value: cdk.Lazy.string({ produce: () => stringifyEnv(this.containerEnv) }),
    });
  }

  private createEnvPrefix(prefix: string): string {
    const count = this.envPrefixCounts.get(prefix) ?? 0
    this.envPrefixCounts.set(prefix, count + 1)
    return `${prefix}_${count + 1}_`
  }

  /**
   * Add an environment variable to the container.
   *
   * @param name Environment variable name
   * @param value Plain string, ISecret (entire secret value), or { secret, field } for a JSON field
   */
  private addEnv(name: string, value: StringOrSecret): void {
    if (typeof value === 'string') {
      this.containerEnv[name] = value;
    } else {
      const isSecretRef = 'secret' in value;
      const secret = isSecretRef ? value.secret : value;
      const field = isSecretRef ? value.field : undefined;

      secret.grantRead(this.role);
      const stack = cdk.Stack.of(this);
      const fetchCmd = `aws secretsmanager get-secret-value --secret-id ${secret.secretArn} --query SecretString --output text --region ${stack.region}`;

      if (field) {
        this.containerEnv[name] = `secret(${secret.secretName}).${field}`;
        this.fetchSecretsCommands.push(
          `echo "${name}=$(${fetchCmd} | jq -r '.${field}')" >> /run/slashid-agent-secrets.env`
        );
      } else {
        this.containerEnv[name] = `secret(${secret.secretName})`;
        this.fetchSecretsCommands.push(
          `echo "${name}=$(${fetchCmd})" >> /run/slashid-agent-secrets.env`
        );
      }
    }
  }

  private setUploadConfig(envPrefix: string, config: UploadConfig): void {
    this.addEnv(`${envPrefix}SLASHID_AUTH_TOKEN`, config.slashid_auth_token);
    this.addEnv(`${envPrefix}UPLOAD_URL`, config.upload_url ?? DEFAULT_UPLOAD_URL);
    if (config.upload_interval !== undefined) {
      this.addEnv(`${envPrefix}UPLOAD_INTERVAL`, config.upload_interval.toString());
    }
    if (config.max_consecutive_failures !== undefined) {
      this.addEnv(`${envPrefix}MAX_CONSECUTIVE_FAILURES`, config.max_consecutive_failures.toString());
    }
    if (config.max_backoff_interval !== undefined) {
      this.addEnv(`${envPrefix}MAX_BACKOFF_INTERVAL`, config.max_backoff_interval.toString());
    }
    this.addEnv(`${envPrefix}OUTPUT_DIR`, `/tmp/slashid-agent/${envPrefix}OUTPUT`);
  }
  
  /**
   * Set up VPC peering so the agent can reach resources in another VPC.
   * Idempotent — calling multiple times with the same VPC is safe.
   *
   * @param vpc The target VPC to peer with
   */
  linkVpc(vpc: ec2.IVpc): this {
    ensureVpcConnectivity(this, this.vpc, vpc, `LinkVpc${this.peeredVpcIds.size}`, this.peeredVpcIds);
    return this;
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
      const engineType = database.engine?.engineType;
      if (engineType && !engineType.includes('postgres')) {
        throw new Error(`addPostgres requires a PostgreSQL database, got: ${engineType}`);
      }

      const endpoint = 'clusterEndpoint' in database ? database.clusterEndpoint : database.instanceEndpoint;

      // Set up VPC peering if needed
      this.linkVpc(database.vpc);

      // Allow the EC2 instance to connect to the database
      if (cdk.Stack.of(database) === stack) {
        // Same stack - safe to use security group reference
        database.connections.allowFrom(this.securityGroup, ec2.Port.tcp(endpoint.port), 'Allow PostgreSQL access from slashid-agent');
      } else {
        // Different stack - use CIDR to avoid cyclic dependency
        database.connections.allowFrom(ec2.Peer.ipv4(database.vpc.vpcCidrBlock), ec2.Port.tcp(endpoint.port), 'Allow PostgreSQL access from VPC');
      }

      // Fetch credentials from Secrets Manager at boot time
      const secret = database.secret;
      if (!secret) {
        throw new Error('RDS database must have a secret for credentials');
      }
      database = {
        host: endpoint.hostname,
        port: endpoint.port,
        dbname: { secret, field: 'dbname' },
        credential: credentialFromSecret(secret, 'username', 'password'),
        use_ssl: true,
      }
    }

    const db = database as PostgresDatabaseInfo;
    this.addEnv(`${envPrefix}HOST`, db.host);
    this.addEnv(`${envPrefix}PORT`, db.port.toString());
    this.addEnv(`${envPrefix}DBNAME`, db.dbname);
    this.addEnv(`${envPrefix}USERNAME`, db.credential.username);
    this.addEnv(`${envPrefix}PASSWORD`, db.credential.password);
    this.addEnv(`${envPrefix}USE_SSL`, db.use_ssl.toString());

    if (agentConfig.fetch_passwords !== undefined) {
      this.addEnv(`${envPrefix}FETCH_PASSWORDS`, agentConfig.fetch_passwords.toString());
    }
    this.setUploadConfig(envPrefix, agentConfig);

    return this;
  }

  /**
   * Connect to an Active Directory domain.
   *
   * If the AD is in a different VPC, call {@link linkVpc} first to set up peering.
   *
   * @param activeDirectory AWS Managed Microsoft AD (CfnMicrosoftAD) or ActiveDirectoryInfo
   * @param agentConfig the agent configuration including credentials
   */
  addActiveDirectory(activeDirectory: CfnMicrosoftAD | ActiveDirectoryInfo, agentConfig: ActiveDirectoryAgentConfig): this {
    if ('attrDnsIpAddresses' in activeDirectory) {
      // Convert AWS Managed Microsoft AD to ActiveDirectoryInfo
      // In AWS Managed AD, DNS servers are also the domain controllers
      // AWS Managed AD always has exactly 2 DCs (one per AZ)
      const dcIps = activeDirectory.attrDnsIpAddresses;
      const dc0 = cdk.Fn.select(0, dcIps);
      const dc1 = cdk.Fn.select(1, dcIps);
      activeDirectory = {
        domain: activeDirectory.name,
        domainControllers: [
          { host: dc0, port: 389, use_ssl: false },
          { host: dc1, port: 389, use_ssl: false },
        ],
        dnsServers: [dc0, dc1],
      };
    }

    if (agentConfig.snapshot) {
      const envPrefix = this.createEnvPrefix("AD_SNAPSHOT");
      const defaultDomainController = activeDirectory.domainControllers[0];
      const snapshotConfig = agentConfig.snapshot;

      this.addEnv(`${envPrefix}DOMAIN`, activeDirectory.domain);
      this.addEnv(`${envPrefix}TARGET_DC`, defaultDomainController.host);
      this.addEnv(`${envPrefix}LDAPS`, defaultDomainController.use_ssl.toString());
      this.addEnv(`${envPrefix}LDAP_PORT`, defaultDomainController.port.toString());
      this.addEnv(`${envPrefix}USERNAME`, snapshotConfig.credential.username);
      this.addEnv(`${envPrefix}PASSWORD`, snapshotConfig.credential.password);

      if (activeDirectory.dnsServers.length > 0) {
        this.addEnv(`${envPrefix}FQDN_RESOLVER`, activeDirectory.dnsServers[0]);
      }
      if (snapshotConfig.collect_adcs !== undefined) {
        this.addEnv(`${envPrefix}COLLECT_ADCS`, snapshotConfig.collect_adcs.toString());
      }
      if (snapshotConfig.collection_method !== undefined) {
        this.addEnv(`${envPrefix}COLLECTION_METHOD`, snapshotConfig.collection_method);
      }

      this.addEnv(`${envPrefix}RUSTHOUND_PATH`, "/usr/local/bin/rusthound-ce");
      this.setUploadConfig(envPrefix, snapshotConfig);
    }

    if (agentConfig.wmi) {
      for (const dc of activeDirectory.domainControllers) {
        const envPrefix = this.createEnvPrefix("WMI");
        const wmiConfig = agentConfig.wmi;

        this.addEnv(`${envPrefix}DOMAIN`, activeDirectory.domain);
        this.addEnv(`${envPrefix}TARGET_DC`, dc.host);
        this.addEnv(`${envPrefix}USERNAME`, wmiConfig.credential.username);
        this.addEnv(`${envPrefix}PASSWORD`, wmiConfig.credential.password);

        this.addEnv(`${envPrefix}SLASHID_AUTH_TOKEN`, wmiConfig.slashid_auth_token);
        this.addEnv(`${envPrefix}STREAM_URL`, wmiConfig.stream_url ?? DEFAULT_STREAM_URL);

        if (wmiConfig.namespace !== undefined) {
          this.addEnv(`${envPrefix}NAMESPACE`, wmiConfig.namespace);
        }
        if (wmiConfig.hashes !== undefined) {
          this.addEnv(`${envPrefix}HASHES`, wmiConfig.hashes);
        }
        if (wmiConfig.kerberos_auth !== undefined) {
          this.addEnv(`${envPrefix}KERBEROS_AUTH`, wmiConfig.kerberos_auth.toString());
        }
        if (wmiConfig.aes_key !== undefined) {
          this.addEnv(`${envPrefix}AES_KEY`, wmiConfig.aes_key);
        }
        if (wmiConfig.rpc_auth_level !== undefined) {
          this.addEnv(`${envPrefix}RPC_AUTH_LEVEL`, wmiConfig.rpc_auth_level);
        }
        if (wmiConfig.timeout !== undefined) {
          this.addEnv(`${envPrefix}TIMEOUT`, wmiConfig.timeout.toString());
        }
        if (wmiConfig.events_pull_interval !== undefined) {
          this.addEnv(`${envPrefix}EVENTS_PULL_INTERVAL`, wmiConfig.events_pull_interval.toString());
        }
        if (wmiConfig.max_events_per_pull !== undefined) {
          this.addEnv(`${envPrefix}MAX_EVENTS_PER_PULL`, wmiConfig.max_events_per_pull.toString());
        }
        if (wmiConfig.connection_error_delay !== undefined) {
          this.addEnv(`${envPrefix}CONNECTION_ERROR_DELAY`, wmiConfig.connection_error_delay.toString());
        }      
      }
    }

    return this;
  }
}





export interface UploadConfig {
  slashid_auth_token: StringOrSecret

  upload_url?: string;
  upload_interval?: number;

  max_consecutive_failures?: number;
  max_backoff_interval?: number;
}

export interface PostgresAgentConfig extends UploadConfig {
  fetch_passwords?: boolean;
}

/** Supported RDS database types for addPostgres (all have vpc and secret properties) */
type RdsDatabase = (rds.DatabaseCluster | rds.DatabaseInstance | rds.ServerlessCluster) & {
  vpc: ec2.IVpc;
  secret?: secretsmanager.ISecret;
};

export interface PostgresDatabaseInfo {
  host: string
  port: number
  dbname: StringOrSecret
  credential: Credential
  use_ssl: boolean;
}

// ActiveDirectory

export interface DomainControler {
  host: string
  port: number
  use_ssl: boolean;
}
export interface ActiveDirectoryInfo {
  domain: string
  domainControllers: DomainControler[]
  dnsServers: string[]
}

export interface ActiveDirectorySnapshotCollectorConfig extends UploadConfig {
  credential: Credential;
  collect_adcs?: boolean;
  collection_method?: "All" | "DCOnly"  // Apparently RustHound-CE only supports these (SharpHound supports more options)
}

export interface WMiCollectorConfig  {
  slashid_auth_token: StringOrSecret
  credential: Credential;
  
  /**
   *  @default "//./root/cimv2" 
   */
  namespace?: string
  /** @default ":" */
  hashes?: string
  /** @default false */
  kerberos_auth?: boolean
  /** @default "" */
  aes_key?: StringOrSecret
  /** @default "integrity" */
  rpc_auth_level?: "integrity"| "privacy"
    /** @default 300 */
  timeout?: number
    /** @default 30 */
  events_pull_interval?: number
  /** @default 300 */ 
  max_events_per_pull ?: number 
  /** @default DEFAULT_STREAM_URL */
  stream_url ?: string
  /** @default 180 */ 
  connection_error_delay ?: number 
}

export interface ActiveDirectoryAgentConfig {
  snapshot?: ActiveDirectorySnapshotCollectorConfig;
  wmi ?: WMiCollectorConfig
}
