# SlashID Agent CDK Examples

Example CDK stacks demonstrating how to use the `SlashidAgent` construct.

## Available Stacks

### SlashidAgentPostgresExample

Connects to PostgreSQL databases:
- RDS Aurora PostgreSQL with automatic credential handling
- External PostgreSQL with custom credentials from Secrets Manager

### SlashidAgentManagedAdExample

Connects to AWS Managed Microsoft AD:
- Configures snapshot collection with RustHound
- Configures WMI event streaming

### SlashidAgentCustomAdExample

Connects to on-premises/custom Active Directory with LDAPS.

## Usage

From the repository root:

```bash
npm install
npm run build

# Synthesize all stacks
npx cdk synth

# Deploy a specific stack
npx cdk deploy SlashidAgentPostgresExample
```

## Configuration

Before deploying, update `slashid-agent-example-stack.ts`:

1. Replace `'your-slashid-token-here'` with your SlashID API token
2. Update database hostnames and AD settings as needed
