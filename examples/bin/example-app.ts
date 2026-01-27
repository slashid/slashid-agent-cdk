#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { SlashidAgent } from '../../src';
import { RdsPostgresStack } from '../lib/rds-postgres-stack';
import { SlashIdAgentStack } from '../lib/slashid-agent-stack';
import { ActiveDirectoryStack as ActiveDirectoryStack } from '../lib/active-directory-stack';

const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };

const activeDirectory = new ActiveDirectoryStack(app, 'ActiveDirectorydStack', {
  env,
  domainName: 'active-directory.aws-cdk.example.com',
  edition: 'Standard',
});

const db = new RdsPostgresStack(app, 'PostgresStack', { 
  env,
  databaseName: 'my_postgres_db',
});

const agentStack = new SlashIdAgentStack(app, 'SlashidAgentStack', {
  env,
  database: db,
  activeDirectory: activeDirectory,
})

