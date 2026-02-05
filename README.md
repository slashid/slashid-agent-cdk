# SlashID Agent CDK Construct

A CDK construct library for deploying [SlashID](https://www.slashid.com/) agents on AWS.

## Installation

```bash
npm install slashid-agent-cdk
```

## Usage

```typescript
import { SlashidAgent, StringOrSecret, Credential, credentialFromSecret } from 'slashid-agent-cdk';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'; // Required for StringOrSecret/Credential
import * as ec2 from 'aws-cdk-lib/aws-ec2'; // Required for IVpc
import * as rds from 'aws-cdk-lib/aws-rds'; // Required for DatabaseCluster
import * as cdk from 'aws-cdk-lib/core'; // Required for SecretValue
import { CfnMicrosoftAD } from 'aws-cdk-lib/aws-directoryservice'; // Required for CfnMicrosoftAD
import * as logs from 'aws-cdk-lib/aws-logs'; // Required for LogRetentionDays

// --- Placeholder Variable Declarations ---
// Replace these with your actual CDK resource definitions or fetched values.

const myVpc: ec2.IVpc = ...;

const myRdsCluster: rds.DatabaseCluster = ...;
const mySlashIdToken: secretsmanager.ISecret = ...;
const myExternalPostgresToken: secretsmanager.ISecret = ...;
const myManagedAdSnapshotToken: secretsmanager.ISecret = ...;
const myManagedAdWmiToken: secretsmanager.ISecret = ...;
const myCustomAdSnapshotToken: secretsmanager.ISecret = ...;
const myCustomAdWmiToken: secretsmanager.ISecret = ...;

const externalPostgresPassword: secretsmanager.ISecret = ...;
const myManagedAdSnapshotPassword: string = ...;
const myManagedAdWmiPassword: secretsmanager.ISecret = ...;
const myCustomAdSnapshotPassword: secretsmanager.ISecret = ...;
const myCustomAdWmiCredential: secretsmanager.ISecret = ...;

const myManagedAD: CfnMicrosoftAD = ...;

// --- End Placeholder Variable Declarations ---

// Create our SlashID agent
const agent = new SlashidAgent(this, 'Agent', {
  vpc: myVpc,
  logRetentionDays: logs.RetentionDays.ONE_WEEK,
});

// Connect to an RDS PostgreSQL database
agent.addPostgres(
  myRdsCluster,
  { slashid_auth_token: mySlashIdToken },
);

// Connect to an external PostgreSQL database
agent.addPostgres(
  {
    host: 'external.postgres.example.com',
    port: 5432,
    use_ssl: true,
    dbname: 'my_external_db',
    credential: {
      username: 'external_user',
      password: externalPostgresPassword, // Can be an ISecret
    },
  },
  { slashid_auth_token: myExternalPostgresToken }
);

// Connect to AWS Managed Microsoft AD
agent.addActiveDirectory(myManagedAD, {
  snapshot: {
    credential: {
      username: 'svc-slashid-reader',
      password: myManagedAdSnapshotPassword,
    },
    slashid_auth_token: myManagedAdSnapshotToken,
  },
  wmi: { // Enable WMI
    credential: {
      username: 'svc-slashid-logger',
      password: myManagedAdWmiPassword ,
    },
    slashid_auth_token: myManagedAdWmiToken,
    namespace: "//./root/cimv2",
  },
});

// Connect to a custom Active Directory using ActiveDirectoryInfo
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
    snapshot: {
      credential: {
        username: 'svc-slashid-reader',
        password: myCustomAdSnapshotPassword,
      },
      slashid_auth_token: myCustomAdSnapshotToken,
    },
    wmi: {
      credential: credentialFromSecret(myCustomAdWmiCredential, "user", "password"),
      slashid_auth_token: myCustomAdWmiToken,
      namespace: "//./root/directory/ldap", // Example WMI config
    },  
  },
);

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
