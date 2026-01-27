# SlashID Agent CDK Examples

Example CDK stacks demonstrating how to use the `SlashidAgent` construct.

## Available Stacks

### ActiveDirectoryStack

Creates an AWS Managed Microsoft AD for testing.

### PostgresStack

Creates an RDS Aurora PostgreSQL database for testing.

### SlashidAgentStack

Deploys the SlashID Agent connecting to both the AD and database.

## Usage

From the repository root:

```bash
npm install
npm run build

cd example
npx cdk synth
npx cdk deploy --all
```

## Configuration

Before deploying, update `app.ts` with your domain name and database settings as needed.
