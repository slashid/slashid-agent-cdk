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

  constructor(scope: Construct, id: string, props: RdsPostgresStackProps = {}) {
    const { vpc: vpcProp, databaseName = 'postgres', ...stackProps } = props;
    super(scope, id, stackProps);

    const vpc = vpcProp ?? ec2.Vpc.fromLookup(this, 'VPC', { isDefault: true });

    const engine = rds.DatabaseInstanceEngine.postgres({
      version: rds.PostgresEngineVersion.VER_16,
    });

    // Allow non-SSL connections (not recommended for production)
    const parameterGroup = new rds.ParameterGroup(this, 'ParameterGroup', {
      engine,
      parameters: {
        'rds.force_ssl': '0',
      },
    });

    this.database = new rds.DatabaseInstance(this, 'Database', {
      engine,
      parameterGroup,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
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
  }
}
