import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as directoryservice from 'aws-cdk-lib/aws-directoryservice';
import { Construct } from 'constructs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { SlashidAgent, Credential } from '../lib';

export interface ExampleStackProps extends cdk.StackProps {
  /**
   * Domain name for the AWS Managed Microsoft AD.
   * @example 'corp.example.com'
   * @default 'corp.slashid.local'
   */
  activeDirectoryDomain?: string;
  /**
   * Edition of AWS Managed Microsoft AD.
   * @default 'Standard'
   */
  activeDirectoryEdition?: 'Standard' | 'Enterprise';
  /**
   * Name of the PostgreSQL database to create.
   * @default 'postgres'
   */
  databaseName?: string;
  /**
   * Instance type for the RDS PostgreSQL database.
   * @default db.t4g.micro
   */
  databaseInstanceType?: ec2.InstanceType;
  /**
   * Instance type for the SlashID Agent EC2 instance.
   * @default t3a.micro
   */
  agentInstanceType?: ec2.InstanceType;
}

export class ExampleStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly activeDirectory: directoryservice.CfnMicrosoftAD;
  public readonly database: rds.DatabaseInstance;
  public readonly agent: SlashidAgent;

  constructor(scope: Construct, id: string, props: ExampleStackProps) {
    super(scope, id, props);

    const {
      activeDirectoryDomain = 'corp.slashid.local',
      activeDirectoryEdition = 'Standard',
      databaseName = 'postgres',
      databaseInstanceType = ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      agentInstanceType = ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.MICRO),
    } = props;

    // ========================================
    // VPC
    // ========================================
    this.vpc = new ec2.Vpc(this, 'VPC', {
      maxAzs: 2,
    });

    // ========================================
    // Active Directory
    // ========================================
    // Create a secret for the AD admin password
    const adAdminPassword = new secretsmanager.Secret(this, 'AdAdminPassword', {
      generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true,
      },
    });

    this.activeDirectory = new directoryservice.CfnMicrosoftAD(this, 'ManagedAD', {
      name: activeDirectoryDomain,
      edition: activeDirectoryEdition,
      vpcSettings: {
        vpcId: this.vpc.vpcId,
        subnetIds: this.vpc.privateSubnets.map(subnet => subnet.subnetId),
      },
      password: adAdminPassword.secretValue.unsafeUnwrap(), // Pass the generated password
    });

    // ========================================
    // RDS Postgres
    // ========================================
    this.database = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: databaseInstanceType,
      vpc: this.vpc,
      allocatedStorage: 20,
      maxAllocatedStorage: 20,
      databaseName,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
    });

    // ========================================
    // SlashID Agent
    // ========================================
    this.agent = new SlashidAgent(this, 'SlashidAgent', {
      vpc: this.vpc,
      instanceType: agentInstanceType,
      logLevel: 'DEBUG',
      logRetentionDays: 1,
    });

    this.agent.addPostgres(this.database, {
      slashid_auth_token: secretsmanager.Secret.fromSecretNameV2(this, 'PostgresSlashidAuthToken', 'AWS-CDK-Test-Postgres'),
    });

    // NOTE: These are the AD's default Admin credentials. In production, you would
    // create a dedicated service account with appropriate read permissions.
    // The Admin account won't have the correct permissions for snapshot/WMI collection
    // out of the box — configuring AD accounts is outside the scope of this example.
    const adCredential: Credential = {
      username: 'Admin',
      password: adAdminPassword,
    };

    this.agent.addActiveDirectory(this.activeDirectory, { // Use this.activeDirectory directly
      slashid_auth_token: secretsmanager.Secret.fromSecretNameV2(this, 'ActiveDirectorySlashidAuthToken', 'AWS-CDK-Test-ActiveDirectory'),
      snapshot: {
        credential: adCredential,
      },
      wmi: {
        credential: adCredential,
      },
    });

    // ========================================
    // Outputs
    // ========================================

    // VPC
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
    });

    // Active Directory
    new cdk.CfnOutput(this, 'ActiveDirectoryId', {
      value: this.activeDirectory.ref,
    });

    new cdk.CfnOutput(this, 'ActiveDirectoryDomainControllers', {
      value: cdk.Fn.join(',', this.activeDirectory.attrDnsIpAddresses),
      description: 'DNS IP addresses for the Active Directory',
    });

    new cdk.CfnOutput(this, 'ActiveDirectoryAdminSecretArn', {
      value: adAdminPassword.secretArn,
      description: 'ARN of the Active Directory admin secret',
    });

    // Database
    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: this.database.dbInstanceEndpointAddress,
    });

    new cdk.CfnOutput(this, 'DatabasePort', {
      value: this.database.dbInstanceEndpointPort,
    });

    new cdk.CfnOutput(this, 'DatabaseSecretArn', {
      value: this.database.secret!.secretArn,
    });

    // Agent
    new cdk.CfnOutput(this, 'AgentServerInstanceId', {
      value: this.agent.server.instanceId,
    });
  }
}
