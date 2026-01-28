import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { authentication } from '@paulo_raca/cdk-skylight';
import { Construct } from 'constructs';
import { SlashidAgent } from '../lib';

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
   * @default t4g.micro
   */
  databaseInstanceType?: ec2.InstanceType;
  /**
   * Instance type for the SlashID Agent ECS cluster.
   * @default t4g.micro
   */
  agentInstanceType?: ec2.InstanceType;
}

export class ExampleStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly activeDirectory: authentication.AwsManagedMicrosoftAdR53;
  public readonly database: rds.DatabaseInstance;
  public readonly agent: SlashidAgent;

  constructor(scope: Construct, id: string, props: ExampleStackProps) {
    super(scope, id, props);

    const {
      activeDirectoryDomain = 'corp.slashid.local',
      activeDirectoryEdition = 'Standard',
      databaseName = 'postgres',
      databaseInstanceType = ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      agentInstanceType = ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
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
    this.activeDirectory = new authentication.AwsManagedMicrosoftAdR53(this, 'ManagedAD', {
      vpc: this.vpc,
      domainName: activeDirectoryDomain,
      edition: activeDirectoryEdition,
      createWorker: false,
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
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      allocatedStorage: 20,
      maxAllocatedStorage: 20,
      databaseName,
      publiclyAccessible: true,
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
      containerImage: "paulocosta56/test-foobar:latest", //FIXME
    });

    this.agent.addPostgres(this.database, {
      slashid_auth_token: '7bf567cfce9431f62c354616c2b67d75b97f3de6bff7d2f9f556f1d33a06eb46', // AWS-CDK-Test-Postgres
    });

    const adCredential = {
      username: { secret: this.activeDirectory.secret, field: "UserID" },
      password: { secret: this.activeDirectory.secret, field: "Password" },
    };

    this.agent.addActiveDirectory(this.activeDirectory.microsoftAD, {
      vpc: this.vpc,
      snapshot: {
        credential: adCredential,
        slashid_auth_token: '8c038e9c448bdc7f1239048de9825f01bccd62b5ac84fcf232c50eae87764fa1', // AWS-CDK-Test-ActiveDirectory
        collect_adcs: false,
      },
      wmi: {
        credential: adCredential,
        slashid_auth_token: '8c038e9c448bdc7f1239048de9825f01bccd62b5ac84fcf232c50eae87764fa1', // AWS-CDK-Test-ActiveDirectory
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
      value: this.activeDirectory.microsoftAD.ref,
    });

    new cdk.CfnOutput(this, 'ActiveDirectoryDomainControllers', {
      value: cdk.Fn.join(',', this.activeDirectory.microsoftAD.attrDnsIpAddresses),
      description: 'DNS IP addresses for the Active Directory',
    });

    new cdk.CfnOutput(this, 'ActiveDirectoryAdminSecretArn', {
      value: this.activeDirectory.secret.secretArn,
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
