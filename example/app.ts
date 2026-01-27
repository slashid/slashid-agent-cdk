#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { ExampleStack } from './example-stack';

const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };

new ExampleStack(app, 'SlashidAgentExampleStack', {
  env,
  activeDirectoryDomain: 'active-directory.example.com',
  activeDirectoryEdition: 'Standard',
  databaseName: 'my_postgres_db',
});
