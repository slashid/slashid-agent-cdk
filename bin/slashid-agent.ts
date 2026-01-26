#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { SlashidAgent } from '../lib/slashid-agent';
import { RdsPostgresStack } from '../lib/rds-postgres-stack';
import { AdStack as ActiveDirectoryStack } from '../lib/active-directory-stack';

const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };

const db = new RdsPostgresStack(app, 'PostgresStack', { env });

const service_account = {
  username: 'svc-slashid-reader',
  password: 'SlashID-Reader-P@ssw0rd!2024',
}

const activeDirectory = new ActiveDirectoryStack(app, 'ActiveDirectorydStack', {
  env,
  domainName: 'active-directory.aws-cdk.example.com',
  edition: 'Standard',
  serviceAccountName: service_account.username,
  serviceAccountPassword: service_account.password,
});

const agentStack = new cdk.Stack(app, 'SlashidAgentStack', { env });
const agent = new SlashidAgent(agentStack, 'SlashidAgent', {
  vpc: activeDirectory.vpc,
  logLevel: 'DEBUG',
  logRetentionDays: 1,
  containerImage: "paulocosta56/test-foobar:latest",
});

agent.addPostgres(db.database, {
  slashid_auth_token: '7bf567cfce9431f62c354616c2b67d75b97f3de6bff7d2f9f556f1d33a06eb46', //AWS-CDK-Test-Postgres
});

agent.addActiveDirectory(activeDirectory.activeDirectory.microsoftAD, {
  vpc: activeDirectory.vpc,
  credentialsSecret: activeDirectory.activeDirectory.secret,
  slashid_auth_token: '8c038e9c448bdc7f1239048de9825f01bccd62b5ac84fcf232c50eae87764fa1', //AWS-CDK-Test-ActiveDirectory
  collect_adcs: false
});
