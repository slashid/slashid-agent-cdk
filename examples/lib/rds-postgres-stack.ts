import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';

export interface RdsPostgresStackProps extends cdk.StackProps {
  /**
   * VPC to deploy into.
   * @default default VPC (looked up at synth time)
   */
  vpc?: ec2.IVpc;
  /**
   * Database name.
   * @default 'postgres'
   */
  databaseName?: string;
}

export class RdsPostgresStack extends cdk.Stack {
  /** The RDS database instance */
  public readonly database: rds.DatabaseInstance;
  /** The VPC where the database is deployed */
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: RdsPostgresStackProps) {
    const { vpc: vpcProp, databaseName = 'postgres', ...stackProps } = props;
    super(scope, id, stackProps);

    this.vpc = vpcProp ?? ec2.Vpc.fromLookup(this, 'VPC', { isDefault: true });

    this.database = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      allocatedStorage: 20,
      maxAllocatedStorage: 20,
      databaseName,
      publiclyAccessible: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
    });

    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: this.database.dbInstanceEndpointAddress,
    });

    new cdk.CfnOutput(this, 'DatabasePort', {
      value: this.database.dbInstanceEndpointPort,
    });

    new cdk.CfnOutput(this, 'DatabaseSecretArn', {
      value: this.database.secret!.secretArn,
    });
  }
}
