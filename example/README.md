# SlashID Agent CDK Example

Example CDK stack demonstrating how to use the `SlashidAgent` construct.

## What it deploys

- A VPC with 2 availability zones
- An AWS Managed Microsoft AD (`CfnMicrosoftAD`)
- An RDS PostgreSQL 16 database (`db.t4g.micro`) in a private subnet
- A SlashID Agent on EC2 (`t3a.micro`) connected to both the AD and database

## Prerequisites

- Secrets Manager secrets for the SlashID auth tokens:
  - `AWS-CDK-Test-Postgres` — token for the PostgreSQL collector
  - `AWS-CDK-Test-ActiveDirectory` — token for the AD snapshot and WMI collectors

## Usage

From the repository root:

```bash
npm install
npm run build

cd example
cdk synth
cdk deploy
```

## Configuration

Edit `app.ts` to customize the AD domain name, database name, or other settings:

```typescript
new ExampleStack(app, 'SlashidAgentExampleStack', {
  env,
  activeDirectoryDomain: 'active-directory.example.com',
  activeDirectoryEdition: 'Standard',
  databaseName: 'my_postgres_db',
});
```

The database defaults to `db.t4g.micro` and the agent EC2 instance to `t3a.micro`. Both can be overridden via `databaseInstanceType` and `agentInstanceType`.
