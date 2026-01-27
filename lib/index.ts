// import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export interface SlashidAgentCdk2Props {
  // Define construct properties here
}

export class SlashidAgentCdk2 extends Construct {

  constructor(scope: Construct, id: string, props: SlashidAgentCdk2Props = {}) {
    super(scope, id);

    // Define construct contents here

    // example resource
    // const queue = new sqs.Queue(this, 'SlashidAgentCdk2Queue', {
    //   visibilityTimeout: cdk.Duration.seconds(300)
    // });
  }
}
