#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { RdsPostgresStack } from './rds-postgres-stack';
import { SlashIdAgentStack } from './slashid-agent-stack';
import { ActiveDirectoryStack as ActiveDirectoryStack } from './active-directory-stack';

const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };

const activeDirectory = new ActiveDirectoryStack(app, 'ActiveDirectorydStack', {
  env,
  domainName: 'active-directory.example.com',
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

