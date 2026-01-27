import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { authentication } from '@paulo_raca/cdk-skylight';
import { Construct } from 'constructs';

export interface ActiveDirectoryStackProps extends cdk.StackProps {
  domainName: string;           // e.g., 'corp.slashid.local'
  edition: 'Standard' | 'Enterprise';
  vpc?: ec2.IVpc;
}

export class ActiveDirectoryStack extends cdk.Stack {
  public readonly activeDirectory: authentication.AwsManagedMicrosoftAdR53;
  public readonly vpc: ec2.IVpc;
  public readonly snapshotServiceAccount: secretsmanager.ISecret;
  public readonly loggerServiceAccount: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: ActiveDirectoryStackProps) {
    super(scope, id, props);

    this.snapshotServiceAccount = new secretsmanager.Secret(this, 'SnapshotServiceAccountSecret', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          group: 'SlashID-Readers',
          username: 'svc-slashid-reader',
        }),
        generateStringKey: 'password',
        excludeCharacters: '"\'\\',
        passwordLength: 32,
      },
    });

    this.loggerServiceAccount = new secretsmanager.Secret(this, 'LoggerServiceAccountSecret', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          group: 'SlashID-Loggers',
          username: 'svc-slashid-logger',
        }),
        generateStringKey: 'password',
        excludeCharacters: '"\'\\',
        passwordLength: 32,
      },
    });

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
    this.setupReaderAccount(this.snapshotServiceAccount);

    // Set up SlashID logger service account for WMI access
    this.setupLoggerAccount(this.loggerServiceAccount);

    // Output secret ARNs for SlashID agent to reference
    new cdk.CfnOutput(this, 'SnapshotServiceAccountSecretArn', {
      value: this.snapshotServiceAccount.secretArn,
      description: 'ARN of the SlashID AD snapshot service account secret',
    });

    new cdk.CfnOutput(this, 'LoggerServiceAccountSecretArn', {
      value: this.loggerServiceAccount.secretArn,
      description: 'ARN of the SlashID AD logger service account secret',
    });
  }

  private setupReaderAccount(accountSecret: secretsmanager.ISecret): void {
    const setupScript = `
$ErrorActionPreference = "Stop"
Import-Module ActiveDirectory

$secret = (Get-SECSecretValue -SecretId "${accountSecret.secretArn}" -Region "${cdk.Stack.of(this).region}").SecretString | ConvertFrom-Json

$DomainName = (Get-ADDomain).DistinguishedName
$ServiceAccountName = $secret.username
$GroupName = $secret.group
$UserPrincipalName = "$ServiceAccountName@$((Get-ADDomain).DNSRoot)"
$securePassword = $secret.password | ConvertTo-SecureString -AsPlainText -Force

# Create service account (idempotent)
$existingUser = Get-ADUser -Filter "SamAccountName -eq '$ServiceAccountName'" -ErrorAction SilentlyContinue
if (-not $existingUser) {
    Write-Host "Creating service account: $ServiceAccountName"
    New-ADUser -Name $ServiceAccountName \`
        -GivenName "SlashID" \`
        -Surname "Reader" \`
        -SamAccountName $ServiceAccountName \`
        -UserPrincipalName $UserPrincipalName \`
        -Enabled $true \`
        -PasswordNeverExpires $true \`
        -AccountPassword $securePassword \`
        -Description "Service account for SlashID AD integration"
} else {
    Write-Host "Service account already exists: $ServiceAccountName"
}

# Create security group (idempotent)
$existingGroup = Get-ADGroup -Filter "SamAccountName -eq '$GroupName'" -ErrorAction SilentlyContinue
if (-not $existingGroup) {
    Write-Host "Creating security group: $GroupName"
    New-ADGroup -Name $GroupName \`
        -SamAccountName $GroupName \`
        -GroupCategory Security \`
        -GroupScope DomainLocal \`
        -DisplayName $GroupName \`
        -Description "Group for SlashID AD integration (read-only)"
} else {
    Write-Host "Security group already exists: $GroupName"
}

# Add user to group (idempotent - Add-ADGroupMember ignores if already a member)
$groupMembers = Get-ADGroupMember -Identity $GroupName -ErrorAction SilentlyContinue | Select-Object -ExpandProperty SamAccountName
if ($groupMembers -notcontains $ServiceAccountName) {
    Write-Host "Adding $ServiceAccountName to group $GroupName"
    Add-ADGroupMember -Identity $GroupName -Members $ServiceAccountName
} else {
    Write-Host "$ServiceAccountName is already a member of $GroupName"
}

# Set permissions (idempotent)
$GroupSID = (Get-ADGroup $GroupName).SID
$ACL = Get-ACL "AD:$DomainName"

$ReadPropGUID = [GUID]"00000000-0000-0000-0000-000000000000"
$PropType = [System.DirectoryServices.ActiveDirectorySecurityInheritance]::Descendents

# Helper function to add ACE only if it doesn't exist
function Add-IdempotentACE {
    param($ACL, $ACE)
    $existingRule = $ACL.Access | Where-Object {
        $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $ACE.IdentityReference.Value -and
        $_.ActiveDirectoryRights -eq $ACE.ActiveDirectoryRights -and
        $_.AccessControlType -eq $ACE.AccessControlType
    }
    if (-not $existingRule) {
        Write-Host "Adding ACE: $($ACE.ActiveDirectoryRights)"
        $ACL.AddAccessRule($ACE)
        return $true
    } else {
        Write-Host "ACE already exists: $($ACE.ActiveDirectoryRights)"
        return $false
    }
}

$aclModified = $false

$ACE = New-Object System.DirectoryServices.ActiveDirectoryAccessRule(
    $GroupSID,
    [System.DirectoryServices.ActiveDirectoryRights]::ReadProperty,
    [System.Security.AccessControl.AccessControlType]::Allow,
    $ReadPropGUID,
    $PropType
)
if (Add-IdempotentACE $ACL $ACE) { $aclModified = $true }

$ACE = New-Object System.DirectoryServices.ActiveDirectoryAccessRule(
    $GroupSID,
    [System.DirectoryServices.ActiveDirectoryRights]::ListChildren,
    [System.Security.AccessControl.AccessControlType]::Allow
)
if (Add-IdempotentACE $ACL $ACE) { $aclModified = $true }

$ACE = New-Object System.DirectoryServices.ActiveDirectoryAccessRule(
    $GroupSID,
    [System.DirectoryServices.ActiveDirectoryRights]::ReadControl,
    [System.Security.AccessControl.AccessControlType]::Allow
)
if (Add-IdempotentACE $ACL $ACE) { $aclModified = $true }

$ACE = New-Object System.DirectoryServices.ActiveDirectoryAccessRule(
    $GroupSID,
    [System.DirectoryServices.ActiveDirectoryRights]::ListObject,
    [System.Security.AccessControl.AccessControlType]::Allow,
    $ReadPropGUID,
    $PropType
)
if (Add-IdempotentACE $ACL $ACE) { $aclModified = $true }

if ($aclModified) {
    Write-Host "Applying ACL changes to AD:$DomainName"
    Set-ACL -AclObject $ACL -Path "AD:$DomainName"
} else {
    Write-Host "No ACL changes needed"
}
`;

    if (this.activeDirectory.domainWindowsNode) {
      accountSecret.grantRead(this.activeDirectory.domainWindowsNode.nodeRole);
    }
    this.activeDirectory.runPSwithDomainAdmin([setupScript], 'setup-reader-account')
  }

  private setupLoggerAccount(accountSecret: secretsmanager.ISecret): void {
    const setupScript = `
$ErrorActionPreference = "Stop"
Import-Module ActiveDirectory

$secret = (Get-SECSecretValue -SecretId "${accountSecret.secretArn}" -Region "${cdk.Stack.of(this).region}").SecretString | ConvertFrom-Json

$DomainName = (Get-ADDomain).DistinguishedName
$ServiceAccountName = $secret.username
$GroupName = $secret.group
$UserPrincipalName = "$ServiceAccountName@$((Get-ADDomain).DNSRoot)"
$securePassword = $secret.password | ConvertTo-SecureString -AsPlainText -Force

# Create service account (idempotent)
$existingUser = Get-ADUser -Filter "SamAccountName -eq '$ServiceAccountName'" -ErrorAction SilentlyContinue
if (-not $existingUser) {
    Write-Host "Creating service account: $ServiceAccountName"
    New-ADUser -Name $ServiceAccountName \`
        -GivenName "SlashID" \`
        -Surname "Logger" \`
        -SamAccountName $ServiceAccountName \`
        -UserPrincipalName $UserPrincipalName \`
        -Enabled $true \`
        -PasswordNeverExpires $true \`
        -AccountPassword $securePassword \`
        -Description "Service account for SlashID AD WMI logging"
} else {
    Write-Host "Service account already exists: $ServiceAccountName"
}

# Create security group (idempotent)
$existingGroup = Get-ADGroup -Filter "SamAccountName -eq '$GroupName'" -ErrorAction SilentlyContinue
if (-not $existingGroup) {
    Write-Host "Creating security group: $GroupName"
    New-ADGroup -Name $GroupName \`
        -SamAccountName $GroupName \`
        -GroupCategory Security \`
        -GroupScope DomainLocal \`
        -DisplayName $GroupName \`
        -Description "Group for SlashID AD WMI logging (read-only)"
} else {
    Write-Host "Security group already exists: $GroupName"
}

# Helper function to add user to group idempotently
function Add-IdempotentGroupMember {
    param($GroupName, $MemberName)
    $groupMembers = Get-ADGroupMember -Identity $GroupName -ErrorAction SilentlyContinue | Select-Object -ExpandProperty SamAccountName
    if ($groupMembers -notcontains $MemberName) {
        Write-Host "Adding $MemberName to group $GroupName"
        Add-ADGroupMember -Identity $GroupName -Members $MemberName
    } else {
        Write-Host "$MemberName is already a member of $GroupName"
    }
}

# Add user to groups
Add-IdempotentGroupMember $GroupName $ServiceAccountName
Add-IdempotentGroupMember "Event Log Readers" $ServiceAccountName
Add-IdempotentGroupMember "Performance Monitor Users" $ServiceAccountName
Add-IdempotentGroupMember "Distributed COM Users" $ServiceAccountName
Add-IdempotentGroupMember "Remote Management Users" $ServiceAccountName

# Enable WMI firewall rules (idempotent - Enable-NetFirewallRule is safe to run multiple times)
Write-Host "Enabling WMI firewall rules"
Enable-NetFirewallRule -DisplayGroup "Windows Management Instrumentation (WMI)"

# Set WMI namespace permissions (idempotent)
$Namespace = "Root\\CIMV2"
$GroupSID = (Get-ADGroup $GroupName).SID

$Permissions = 0x1 -bor 0x2 -bor 0x20 -bor 0x20000  # Enable Account | Execute Methods | Remote Enable | Read Security
$NewACE = "(A;;0x$($Permissions.ToString('X'));;;$($GroupSID.Value))"

$Security = Get-WmiObject -Namespace $Namespace -Class __SystemSecurity
$BinarySD = $(Invoke-WmiMethod -InputObject $Security -Name GetSD).SD
$SDDL = ([wmiclass]"Win32_SecurityDescriptorHelper").BinarySDToSDDL($BinarySD).SDDL

# Check if ACE already exists
if ($SDDL -match [regex]::Escape($GroupSID.Value)) {
    Write-Host "WMI permissions already set for $GroupName on namespace $Namespace"
} else {
    Write-Host "Setting WMI permissions for $GroupName on namespace $Namespace"
    if ($SDDL -match "(.*?D:.*?)(\\(.*\\))(.*)") {
        $NewSDDL = $matches[1] + $NewACE + $matches[2] + $matches[3]
    } else {
        Write-Error "Failed to parse SDDL"
        return
    }
    $NewBinarySD = ([wmiclass]"Win32_SecurityDescriptorHelper").SDDLToBinarySD($NewSDDL).BinarySD

    $result = Invoke-WmiMethod -InputObject $Security -Name SetSD -ArgumentList $NewBinarySD, $null
    if ($result.ReturnValue -eq 0) {
        Write-Host "WMI permissions set successfully"
        Write-Host "Restarting WMI service..."
        Restart-Service WinMgmt -Force
    } else {
        Write-Error "Failed to set WMI permissions. Error code: $($result.ReturnValue)"
    }
}
`;

    if (this.activeDirectory.domainWindowsNode) {
      accountSecret.grantRead(this.activeDirectory.domainWindowsNode.nodeRole);
    }
    this.activeDirectory.runPSwithDomainAdmin([setupScript], 'setup-logger-account')
  }
}
