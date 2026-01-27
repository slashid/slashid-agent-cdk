import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { SlashidAgent } from '../../src';
import { RdsPostgresStack } from './rds-postgres-stack';
import { ActiveDirectoryStack } from './active-directory-stack';

export interface SlashIdAgentStackProps extends cdk.StackProps {
  /**
   * VPC to deploy into.
   * @default default VPC (looked up at synth time)
   */
  vpc?: ec2.IVpc;

  database: RdsPostgresStack;
  activeDirectory: ActiveDirectoryStack;
}

export class SlashIdAgentStack extends cdk.Stack {
  /** The RDS database instance */
  public readonly database: rds.DatabaseInstance;
  /** The VPC where the database is deployed */
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: SlashIdAgentStackProps) {
    const { vpc: vpcProp, ...stackProps } = props;
    super(scope, id, stackProps);

    this.vpc = vpcProp ?? ec2.Vpc.fromLookup(this, 'VPC', { isDefault: true });

    const agent = new SlashidAgent(this, 'SlashidAgent', {
      vpc: this.vpc,
      logLevel: 'DEBUG',
      logRetentionDays: 1,
      containerImage: "slashid/agent:latest",
    });

    // Add Postgres Database
    const postgresAuthToken = new secretsmanager.Secret(this, 'Postgres-AuthToken', {
      secretName: 'AWS-CDK-Test-Postgres-AuthToken',
      secretStringValue: cdk.SecretValue.unsafePlainText('7bf567cfce9431f62c354616c2b67d75b97f3de6bff7d2f9f556f1d33a06eb46'),
    });
    agent.addPostgres(props.database.database, {
      slashid_auth_token: postgresAuthToken,
    });

    // Add Active Directory
    const activeDirectoryAuthToken = new secretsmanager.Secret(this, 'ActiveDirectory-AuthToken', {
      secretName: "AWS-CDK-Test-ActiveDirectory-AuthToken",
      secretStringValue: cdk.SecretValue.unsafePlainText('8c038e9c448bdc7f1239048de9825f01bccd62b5ac84fcf232c50eae87764fa1'),
    });

    agent.addActiveDirectory(props.activeDirectory.activeDirectory.microsoftAD, {
      vpc: props.activeDirectory.vpc,
      snapshot: {
        credential: {
          username: {secret: props.activeDirectory.snapshotServiceAccount, field: "username"},
          password: {secret: props.activeDirectory.snapshotServiceAccount, field: "password"}
        },
        slashid_auth_token: activeDirectoryAuthToken,
        collect_adcs: false
      },
      wmi: {
        credential: {
          username: {secret: props.activeDirectory.snapshotServiceAccount, field: "username"},
          password: {secret: props.activeDirectory.snapshotServiceAccount, field: "password"}
        },
        slashid_auth_token: activeDirectoryAuthToken,
      },
    });
  }
}
