import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { authentication } from 'cdk-skylight';
import { Construct } from 'constructs';

export interface ActiveDirectoryStackProps extends cdk.StackProps {
  domainName: string;           // e.g., 'corp.slashid.local'
  edition: 'Standard' | 'Enterprise';
  vpc?: ec2.IVpc;
  serviceAccountName: string;
  serviceAccountPassword: string;
}

export class AdStack extends cdk.Stack {
  public readonly activeDirectory: authentication.AwsManagedMicrosoftAdR53;
  public readonly vpc: ec2.IVpc;
  public readonly serviceAccountName: string;
  public readonly serviceAccountPassword: string;

  constructor(scope: Construct, id: string, props: ActiveDirectoryStackProps) {
    super(scope, id, props);

    this.serviceAccountName = props.serviceAccountName;
    this.serviceAccountPassword = props.serviceAccountPassword;

    // Create or use provided VPC
    this.vpc = props.vpc ?? new ec2.Vpc(this, 'VPC', {
      maxAzs: 2,
    });

    // Create Managed AD with Route 53 DNS forwarding
    this.activeDirectory = new authentication.AwsManagedMicrosoftAdR53(this, 'ManagedAD', {
      vpc: this.vpc,
      domainName: props.domainName,
      edition: props.edition,
    });

    // Set up SlashID read-only service account and permissions
    this.setupSlashIdReadOnlyAccess();
  }

  private setupSlashIdReadOnlyAccess(): void {
    const groupName = 'SlashID-Readers';

    const setupScript = `
$ErrorActionPreference = "Stop"
Import-Module ActiveDirectory

$DomainName = (Get-ADDomain).DistinguishedName
$ServiceAccountName = "${this.serviceAccountName}"
$GroupName = "${groupName}"
$UserPrincipalName = "$ServiceAccountName@$((Get-ADDomain).DNSRoot)"
$securePassword = ConvertTo-SecureString -String "${this.serviceAccountPassword}" -AsPlainText -Force

# Create service account
New-ADUser -Name $ServiceAccountName \`
    -GivenName "SlashID" \`
    -Surname "Reader" \`
    -SamAccountName $ServiceAccountName \`
    -UserPrincipalName $UserPrincipalName \`
    -Enabled $true \`
    -PasswordNeverExpires $true \`
    -AccountPassword $securePassword \`
    -Description "Service account for SlashID AD integration"

# Create security group
New-ADGroup -Name $GroupName \`
    -SamAccountName $GroupName \`
    -GroupCategory Security \`
    -GroupScope DomainLocal \`
    -DisplayName $GroupName \`
    -Description "Group for SlashID AD integration (read-only)"

Add-ADGroupMember -Identity $GroupName -Members $ServiceAccountName

# Set permissions
$GroupSID = (Get-ADGroup $GroupName).SID
$ACL = Get-ACL "AD:$DomainName"

$ReadPropGUID = [GUID]"00000000-0000-0000-0000-000000000000"
$PropType = [System.DirectoryServices.ActiveDirectorySecurityInheritance]::Descendents

$ACE = New-Object System.DirectoryServices.ActiveDirectoryAccessRule(
    $GroupSID,
    [System.DirectoryServices.ActiveDirectoryRights]::ReadProperty,
    [System.Security.AccessControl.AccessControlType]::Allow,
    $ReadPropGUID,
    $PropType
)
$ACL.AddAccessRule($ACE)

$ACE = New-Object System.DirectoryServices.ActiveDirectoryAccessRule(
    $GroupSID,
    [System.DirectoryServices.ActiveDirectoryRights]::ListChildren,
    [System.Security.AccessControl.AccessControlType]::Allow
)
$ACL.AddAccessRule($ACE)

$ACE = New-Object System.DirectoryServices.ActiveDirectoryAccessRule(
    $GroupSID,
    [System.DirectoryServices.ActiveDirectoryRights]::ReadControl,
    [System.Security.AccessControl.AccessControlType]::Allow
)
$ACL.AddAccessRule($ACE)

$ACE = New-Object System.DirectoryServices.ActiveDirectoryAccessRule(
    $GroupSID,
    [System.DirectoryServices.ActiveDirectoryRights]::ListObject,
    [System.Security.AccessControl.AccessControlType]::Allow,
    $ReadPropGUID,
    $PropType
)
$ACL.AddAccessRule($ACE)

Set-ACL -AclObject $ACL -Path "AD:$DomainName"
`;

    this.activeDirectory.domainWindowsNode?.runPSwithDomainAdmin(
      [setupScript, 'Stop-Computer -ComputerName localhost'],
      'setupSlashIdReadOnlyAccess',
    );
  }
}
