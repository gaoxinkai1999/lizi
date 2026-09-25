Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-Administrator {
    if (-not [Environment]::Is64BitProcess) { throw 'Use 64-bit Windows PowerShell for this x64 service.' }
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this script from an elevated PowerShell (Run as administrator).'
    }
}

function Invoke-Native([string] $Executable, [string[]] $Arguments, [int] $TimeoutSeconds = 60) {
    $name = [IO.Path]::GetFileName($Executable)
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Executable
    # Quote arguments using the Windows command-line backslash/quote rules.
    $start.Arguments = (($Arguments | ForEach-Object {
        '"' + [regex]::Replace([regex]::Replace($_, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
    }) -join ' ')
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        [void]$process.Start()
        # Drain without retaining or printing wrapper output: it can contain configuration.
        $process.BeginOutputReadLine()
        $process.BeginErrorReadLine()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            try { $process.Kill() } catch { }
            Throw-LiziError "$name exceeded ${TimeoutSeconds}s. Inspect LiziService in Services and Windows Event Viewer before retrying; its state may have changed."
        }
        if ($process.ExitCode -ne 0) {
            Throw-LiziError "$name failed with exit code $($process.ExitCode). Inspect LiziService in Services and Windows Event Viewer."
        }
    } finally { $process.Dispose() }
}

function Throw-LiziError([string] $Message) {
    $exception = [InvalidOperationException]::new($Message)
    $exception.Data['LiziReason'] = $Message
    throw $exception
}

function Start-LiziOperation([ValidateSet('install', 'uninstall', 'report-roots')][string] $Name) {
    $script:LiziOperationWatch = [Diagnostics.Stopwatch]::StartNew()
    $script:LiziStageWatch = $null
    $script:LiziStage = 'Preparing protected installation log'
    $script:LiziLogPath = $null
    $directory = Get-LocalDirectory (Join-Path $env:ProgramData 'LiziInstaller') -Create
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $directory -AclObject $acl
    $path = Join-Path $directory "$Name.log"
    if (Test-Path -LiteralPath $path) {
        $item = Get-Item -LiteralPath $path -Force
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe installation log path.' }
        $fileAcl = [Security.AccessControl.FileSecurity]::new()
        $fileAcl.SetAccessRuleProtection($true, $false)
        $fileAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
        foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
            $fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'Allow'))
        }
        Set-Acl -LiteralPath $path -AclObject $fileAcl
    }
    $script:LiziLogPath = $path
    Write-LiziProgress "Starting $Name. Log: $path"
}

function Write-LiziProgress([string] $Message) {
    $line = '{0:u} [+{1:N1}s] {2}' -f [DateTime]::UtcNow, $script:LiziOperationWatch.Elapsed.TotalSeconds, $Message
    Write-Host $line
    if ($script:LiziLogPath) { [IO.File]::AppendAllText($script:LiziLogPath, $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false)) }
}

function Set-LiziStage([string] $Message) {
    if ($script:LiziStageWatch) { Write-LiziProgress ('Completed {0} ({1:N1}s).' -f $script:LiziStage, $script:LiziStageWatch.Elapsed.TotalSeconds) }
    $script:LiziStage = $Message
    $script:LiziStageWatch = [Diagnostics.Stopwatch]::StartNew()
    Write-LiziProgress $Message
}

function Write-LiziFailure($Failure) {
    $reason = $Failure.Exception.Data['LiziReason']
    if (-not $reason) {
        # Do not print exception messages/source text: XML/HTTP errors can echo secrets.
        $reason = '{0}, HRESULT {1}; {2}:{3}. Check the resource/path permissions for this stage.' -f $Failure.Exception.GetType().Name, $Failure.Exception.HResult, [IO.Path]::GetFileName($Failure.InvocationInfo.ScriptName), $Failure.InvocationInfo.ScriptLineNumber
    }
    $location = if ($script:LiziLogPath) { "Log: $($script:LiziLogPath)" } else { "Log unavailable. Check administrator access and free disk space under $(Join-Path $env:ProgramData 'LiziInstaller')." }
    $message = "FAILED during $($script:LiziStage): $reason $location"
    try { Write-LiziProgress $message } catch { Write-Host $message; Write-Host 'Could not write the installation log. Check administrator access and free disk space.' }
}

function Wait-LiziHealth {
    $reason = 'No healthy response received.'
    for ($attempt = 1; $attempt -le 30; $attempt++) {
        try {
            $state = Invoke-RestMethod 'http://127.0.0.1:3210/api/health' -TimeoutSec 2
            if ($state.ok) { return }
            $reason = 'The local health endpoint returned ok=false.'
        } catch {
            $reason = $_.Exception.GetType().Name
            if ($_.Exception -is [Net.WebException]) {
                $reason += ': ' + $_.Exception.Status
                if ($_.Exception.Response -is [Net.HttpWebResponse]) { $reason += ' (HTTP ' + [int]$_.Exception.Response.StatusCode + ')' }
            }
        }
        if ($attempt -eq 1 -or $attempt % 10 -eq 0) { Write-LiziProgress "Health attempt $attempt/30: $reason" }
        Start-Sleep -Seconds 1
    }
    Throw-LiziError "Local HTTP health check failed after 30 bounded attempts: $reason Inspect the service logs under DataHome/logs and Windows Event Viewer."
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
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $serviceSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-19')
    $requiredRights = [Security.AccessControl.FileSystemRights]::ReadAndExecute
    $readAccessRights = $requiredRights -bor [Security.AccessControl.FileSystemRights]::Synchronize
    $rootRights = 0
    $directoryRights = 0
    $fileRights = 0
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.IdentityReference.Value -ne $serviceSid.Value) { continue }
        # This checks the service grant, not effective access through other groups.
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny) {
            if (($rule.FileSystemRights -band $readAccessRights) -ne 0) {
                Throw-LiziError "Report root '$Path' explicitly denies LocalService required read access ($($rule.FileSystemRights)). No ACL changes were made. Review the conflicting rule manually."
            }
            continue
        }
        if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0) {
            $rootRights = $rootRights -bor $rule.FileSystemRights
        }
        # NoPropagate covers at most one generation, not arbitrary report depth.
        if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::NoPropagateInherit) -ne 0) { continue }
        if (($rule.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ContainerInherit) -ne 0) {
            $directoryRights = $directoryRights -bor $rule.FileSystemRights
        }
        if (($rule.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0) {
            $fileRights = $fileRights -bor $rule.FileSystemRights
        }
    }
    if (($rootRights -band $requiredRights) -eq $requiredRights -and
        ($directoryRights -band $requiredRights) -eq $requiredRights -and
        ($fileRights -band $requiredRights) -eq $requiredRights) {
        Write-LiziProgress "Skipping report ACL update: '$Path' already grants LocalService ReadAndExecute on this directory with inheritance for subdirectories and files. Set-Acl was not called; descendant ACLs and effective access were not checked."
        return
    }
    Write-LiziProgress "Adding missing inheritable LocalService ReadAndExecute grant to '$Path'; existing ACL entries are preserved. Descendant ACLs and effective access are not checked."
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($serviceSid, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
}

function Write-Utf8([string] $Path, [string] $Content) {
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Ensure-LiziLanFirewall([string] $NodePath) {
    if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
        Throw-LiziError 'Packaged node.exe is required before configuring the LAN firewall rules.'
    }
    if (-not (Get-Command New-NetFirewallRule -ErrorAction SilentlyContinue)) {
        Throw-LiziError 'Windows Firewall cmdlets are unavailable; LAN firewall rules were not configured.'
    }
    $rules = @(
        @{ Name = 'Lizi-LAN-TCP-3211'; DisplayName = 'Lizi LAN pair/data TCP 3211'; Protocol = 'TCP'; Port = '3211' },
        @{ Name = 'Lizi-LAN-UDP-3212'; DisplayName = 'Lizi LAN discovery UDP 3212'; Protocol = 'UDP'; Port = '3212' }
    )
    foreach ($rule in $rules) {
        Get-NetFirewallRule -Name $rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction Stop
        New-NetFirewallRule -Name $rule.Name -DisplayName $rule.DisplayName -Description 'Lizi local-subnet LAN direct-link traffic only.' -Direction Inbound -Action Allow -Enabled True -Profile Any -Program $NodePath -Protocol $rule.Protocol -LocalPort $rule.Port -RemoteAddress LocalSubnet -EdgeTraversalPolicy Block | Out-Null
    }
}

function Remove-LiziLanFirewall {
    if (-not (Get-Command Get-NetFirewallRule -ErrorAction SilentlyContinue)) { Throw-LiziError 'Windows Firewall cmdlets are unavailable; Lizi LAN firewall rules could not be removed.' }
    foreach ($name in @('Lizi-LAN-TCP-3211', 'Lizi-LAN-UDP-3212')) {
        Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction Stop
    }
}

function Stop-LiziService {
    $service = Get-Service -Name LiziService -ErrorAction SilentlyContinue
    if ($service -and $service.Status -ne 'Stopped') {
        if ($service.Status -ne 'StopPending') { Invoke-Native 'sc.exe' @('stop', 'LiziService') -TimeoutSeconds 30 }
        try { $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(45)) }
        catch { Throw-LiziError 'LiziService did not stop within 45s. Inspect Services and Windows Event Viewer; no user data was deleted.' }
    }
}

function Start-LiziService {
    Invoke-Native 'sc.exe' @('start', 'LiziService') -TimeoutSeconds 30
    $service = Get-Service -Name LiziService
    try { $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(45)) }
    catch { Throw-LiziError 'LiziService did not reach Running within 45s. Inspect the service logs and Windows Event Viewer.' }
}
