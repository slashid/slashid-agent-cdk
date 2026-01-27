# SlashID Agent CDK Construct

A CDK construct library for deploying [SlashID](https://www.slashid.com/) agents on AWS.

## Installation

```bash
npm install slashid-agent-cdk
```

## Usage

```typescript
import { SlashidAgent } from 'slashid-agent-cdk';

const agent = new SlashidAgent(this, 'Agent', {
  vpc: myVpc,
  logRetentionDays: logs.RetentionDays.ONE_WEEK,
});

// Connect to an RDS PostgreSQL database
agent.addPostgres(myRdsCluster, {
  slashid_auth_token: mySlashIdToken,
});

// Connect to AWS Managed Microsoft AD
agent.addActiveDirectory(myManagedAD, {
  vpc: adVpc,
  snapshot: {
    credential: { username: 'admin', password: adminPassword },
    slashid_auth_token: mySlashIdToken,
  },
});
```

## Features

- Deploys SlashID agent as a Docker container on EC2
- Connects to PostgreSQL databases (RDS or external)
- Connects to Active Directory (AWS Managed AD or custom LDAP)
- Automatic VPC peering when databases are in different VPCs
- Secrets Manager integration for credentials
- Optional CloudWatch logging

## Examples

See the [example/](example/) directory for complete stack examples.

```bash
cd example
cdk synth
cdk deploy --all
```
