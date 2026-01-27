import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

/** Reference to a secret value with a specific JSON field */
interface SecretField {
  secret: secretsmanager.ISecret;
  field: string;
}

/** Value for an environment variable: plain string, entire secret, or secret field */
export type StringOrSecret = string | secretsmanager.ISecret | SecretField;

export interface Credential {
  username: StringOrSecret
  password: StringOrSecret
}
