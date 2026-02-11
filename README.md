# SlashID Agent CDK Construct

A CDK construct library for deploying [SlashID](https://www.slashid.com/) agents on AWS.

- Deploys SlashID agent as a Docker container on EC2
- Connects to PostgreSQL databases (RDS or custom)
- Connects to Active Directory (AWS Managed AD or custom)
- Automatic VPC peering for RDS databases in different VPCs
- `linkVpc()` for manual VPC peering (e.g., ActiveDirectory or database in a separate VPC)
- Secrets Manager integration for credentials
- Optional CloudWatch logging

## Getting started

If you're new to AWS CDK, you'll need:

1. [Node.js](https://nodejs.org/) (v18+) and npm
2. [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) configured with credentials (`aws configure`)
3. [AWS CDK CLI](https://docs.aws.amazon.com/cdk/v2/guide/cli.html): `npm install -g aws-cdk`
4. Bootstrap CDK in your AWS account (one-time): `cdk bootstrap`

If you don't have a CDK project yet, create one:

```bash
cdk init app --language typescript
```

Then add the construct:

```bash
npm install @slashid/agent-cdk
```

Next:

1. Edit `lib/<your-stack>.ts` to use the `SlashidAgent` construct (see [Usage](#usage) below)
2. Store your credentials and SlashID auth tokens in [AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/userguide/create_secret.html)
3. Deploy with `cdk deploy`

## Usage

```typescript
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import { CfnMicrosoftAD } from 'aws-cdk-lib/aws-directoryservice';
import { Construct } from 'constructs';
import { SlashidAgent, Credential, credentialFromSecret } from '@slashid/agent-cdk';

export class MyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create the agent
    const myVpc: ec2.IVpc = ...;
    const agent = new SlashidAgent(this, 'Agent', {
      vpc: myVpc,
      logRetentionDays: logs.RetentionDays.ONE_WEEK,
    });

    // Connect to an RDS PostgreSQL database (VPC peering is automatic)
    const myRdsInstance: rds.DatabaseInstance = ...;
    const myRdsSlashIdToken: secretsmanager.ISecret = ...;
    agent.addPostgres(myRdsInstance, {
      slashid_auth_token: myRdsSlashIdToken,
    });

    // Connect to an external PostgreSQL database
    const myExternalPostgresSlashIdToken: secretsmanager.ISecret = ...;
    const myExternalPostgresPassword: secretsmanager.ISecret = ...;
    agent.addPostgres(
      {
        host: 'external.postgres.example.com',
        port: 5432,
        use_ssl: true,
        dbname: 'my_external_db',
        credential: {
          username: 'external_user',
          password: myExternalPostgresPassword, // Can be an ISecret
        },
      },
      { slashid_auth_token: myExternalPostgresSlashIdToken },
    );

    // If the Active Directory is in a different VPC, set up peering first
    const activeDirectoryVpc: ec2.IVpc = ...;
    agent.linkVpc(activeDirectoryVpc);

    // Connect to AWS Managed Microsoft Active Directory
    const myManagedActiveDirectory: CfnMicrosoftAD = ...;
    const myManagedActiveDirectorySlashIdToken: secretsmanager.ISecret = ...;
    const myManagedActiveDirectorySnapshotCredential: Credential = ...;
    const myManagedActiveDirectoryWmiCredential: Credential = ...;
    agent.addActiveDirectory(myManagedActiveDirectory, {
      slashid_auth_token: myManagedActiveDirectorySlashIdToken,
      snapshot: {
        credential: myManagedActiveDirectorySnapshotCredential,
      },
      wmi: {
        credential: myManagedActiveDirectoryWmiCredential,
      },
    });

    // Connect to a custom Active Directory deployment
    const myCustomActiveDirectorySlashIdToken: secretsmanager.ISecret = ...;
    const myCustomActiveDirectorySnapshotCredential: Credential = ...;
    const myCustomActiveDirectoryWmiCredential: Credential = ...;
    agent.addActiveDirectory(
      {
        domain: 'custom.example.com',
        domainControllers: [
          { host: 'dc1.custom.example.com', port: 389, use_ssl: false },
          { host: 'dc2.custom.example.com', port: 389, use_ssl: false },
        ],
        dnsServers: ['10.0.0.10', '10.0.0.11'],
      },
      {
        slashid_auth_token: myCustomActiveDirectorySlashIdToken,
        snapshot: {
          credential: myCustomActiveDirectorySnapshotCredential,
        },
        wmi: {
          credential: myCustomActiveDirectoryWmiCredential,
        },
      },
    );
  }
}
```

## Credentials and secrets

Anywhere the library accepts a credential or secret value, you can use:

- **Plain string** — hardcoded value (useful for usernames, not recommended for passwords and tokens)
- **`ISecret`** — an entire Secrets Manager secret value
- **`{ secret, field }`** — a single field from a JSON-structured secret

These can be mixed freely. For example:

```typescript
const credential: Credential = {
  username: 'admin',                                    // plain string
  password: mySecret,                                   // entire secret value
};

const credential: Credential = {
  username: 'admin',                                    // plain string
  password: { secret: mySecret, field: 'password' },    // field inside JSON-encoded secret
};

// Or extract fields from a single JSON secret, where the fields for username and password are 'username' and 'password'
const credential = credentialFromSecret(mySecret, 'username', 'password');
```

The library automatically grants read access to the EC2 role and fetches secret values at boot time.

## Examples

See the [example/](example/) directory for a complete stack example.

```bash
cd example
cdk synth
cdk deploy
```
