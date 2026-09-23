Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-Administrator {
    if (-not [Environment]::Is64BitProcess) { throw 'Use 64-bit Windows PowerShell for this x64 service.' }
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this script from an elevated PowerShell (Run as administrator).'
    }
}

function Invoke-Native([string] $Executable, [string[]] $Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Executable failed with exit code $LASTEXITCODE" }
}

function Get-LocalDirectory([string] $Path, [switch] $Create) {
    if ($Path -notmatch '^[A-Za-z]:[\\/]') { throw 'A local absolute drive path is required; LocalService cannot access network shares.' }
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -match '[%\x00-\x1f]') { throw 'Percent signs and control characters are not supported in service paths.' }
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse points are not allowed in installation paths: $cursor" }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
    if ($Create) { [IO.Directory]::CreateDirectory($full) | Out-Null }
    if (-not (Test-Path -LiteralPath $full -PathType Container)) { throw "Directory not found: $full" }
    return $full
}

function Get-BootstrapSid([string] $Requested) {
    if ($Requested) { return [Security.Principal.SecurityIdentifier]::new($Requested).Value }
    $interactive = (Get-CimInstance Win32_ComputerSystem).UserName
    if ($interactive) { return [Security.Principal.NTAccount]::new($interactive).Translate([Security.Principal.SecurityIdentifier]).Value }
    return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}

function Set-PrivateAcl([string] $Path, [string] $BootstrapSid = '', [switch] $Token, [switch] $ReportDirectory) {
    $isDirectory = (Get-Item -LiteralPath $Path -Force).PSIsContainer
    if ($isDirectory) { $acl = [Security.AccessControl.DirectorySecurity]::new() }
    else { $acl = [Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    $inheritance = if ($isDirectory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-19')) {
        $rights = if ($ReportDirectory -and $sid -eq 'S-1-5-19') { 'ReadAndExecute' } else { 'FullControl' }
        $rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), $rights, $inheritance, 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    if ($BootstrapSid) {
        $rights = if ($Token) { 'Read' } elseif ($ReportDirectory) { 'Modify' } else { 'Traverse' }
        $userInheritance = if ($ReportDirectory) { $inheritance } else { [Security.AccessControl.InheritanceFlags]::None }
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($BootstrapSid), $rights, $userInheritance, 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Set-ProgramAcl([string] $Path) {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-32-545', 'S-1-5-19')) {
        $rights = if ($sid -in @('S-1-5-18', 'S-1-5-32-544')) { 'FullControl' } else { 'ReadAndExecute' }
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), $rights, 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Grant-ReportRead([string] $Path) {
    $acl = Get-Acl -LiteralPath $Path
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-19'), 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Write-Utf8([string] $Path, [string] $Content) {
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Stop-LiziService {
    $service = Get-Service -Name LiziService -ErrorAction SilentlyContinue
    if ($service -and $service.Status -ne 'Stopped') {
        Stop-Service -Name LiziService -ErrorAction Stop
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(45))
    }
}
