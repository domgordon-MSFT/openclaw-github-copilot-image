param(
    [Parameter(Mandatory)][ValidateSet('runtime','private','install','owner')][string]$Mode,
    [Parameter(Mandatory)][string]$Path
)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = 'S-1-5-32-544'
$system = 'S-1-5-18'
$trustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
$operators = @($admin,$system,$trustedInstaller)
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if ($Mode -in 'install','owner') {
    if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run installation elevated' }
} elseif ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run the gateway without elevation'
}

function Assert-Protected($Item, $Allowed, [long]$Mask) {
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unexpected reparse point' }
    $acl = Get-Acl -LiteralPath $Item.FullName
    $sid = [Security.Principal.SecurityIdentifier]
    if ($acl.GetOwner($sid).Value -notin $Allowed) { throw 'Unexpected owner' }
    foreach ($rule in $acl.GetAccessRules($true,$true,$sid)) {
        if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $Allowed -and
            ([long]$rule.FileSystemRights -band $Mask) -ne 0) { throw 'Unexpected access rule' }
    }
}

$item = Get-Item -LiteralPath $Path -Force
$drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($item.FullName))
if ($drive.DriveType -ne [IO.DriveType]::Fixed) { throw 'Use a fixed local Windows volume' }
if ($Mode -eq 'owner') {
    $icacls = Join-Path ([Environment]::SystemDirectory) 'icacls.exe'
    & $icacls $item.FullName /setowner ('*' + $admin) /T /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not protect the runtime owner' }
    exit
}

# Generic write/all, data/metadata writes, deletion, ACL/owner changes.
$mutation = 0x500D0156
# Ancestors can permit unrelated creates, but not replacement of an existing child.
$ancestorMutation = 0x500D0150
if ($Mode -eq 'private') {
    $operators += $identity.User.Value
    # Check against all data and mutation rights, not just the write bits.
    Assert-Protected $item $operators 0xF00D01FF
} else {
    Assert-Protected $item $operators $mutation
}
if ($Mode -eq 'runtime') {
    Get-ChildItem -LiteralPath $item.FullName -Force -Recurse | ForEach-Object {
        Assert-Protected $_ $operators $mutation
    }
}
for ($parent = $item.Parent; $parent; $parent = $parent.Parent) {
    Assert-Protected $parent $operators $ancestorMutation
}
