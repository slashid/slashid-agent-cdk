#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { SlashidAgentStack } from '../lib/slashid-agent-stack';
import { RdsPostgresStack } from '../lib/rds-postgres-stack';

const app = new cdk.App();

const db = new RdsPostgresStack(app, 'PostgresStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

const agent = new SlashidAgentStack(app, 'SlashidAgentStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  logLevel: 'DEBUG',
});

agent.addPostgres(db.database, {
  slashid_auth_token: '98b11f633ec41c95008a6804aa541f35f72ff8f36db885df998732922df33c82'
});
