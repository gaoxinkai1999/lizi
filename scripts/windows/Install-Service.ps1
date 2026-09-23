[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $InstallRoot,
    [string] $ReportRoot,
    [string] $ReportRootFile,
    [string] $DataHome = (Join-Path $env:ProgramData 'Lizi'),
    [string] $BootstrapUserSid,
    [string] $TrustedCaFile
)
. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-Administrator
if ($ReportRootFile) {
    if ($ReportRoot) { throw 'Specify ReportRoot or ReportRootFile, not both.' }
    $ReportRoot = Get-Content -LiteralPath $ReportRootFile -Raw
}
$InstallRoot = Get-LocalDirectory $InstallRoot
$runtime = Join-Path $InstallRoot 'runtime'
$backend = Join-Path $InstallRoot 'backend'
$wrapper = Join-Path $runtime 'LiziService.exe'
foreach ($path in @($wrapper, (Join-Path $runtime 'node.exe'), (Join-Path $runtime 'frpc.exe'), (Join-Path $backend 'packages/server/src/index.js'), (Join-Path $backend 'apps/web/dist/index.html'), (Join-Path $backend 'scripts/runtime/remote.js'))) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing packaged resource: $path. Run Prepare-Resources.ps1 before packaging." }
}
Stop-LiziService
$DataHome = Get-LocalDirectory $DataHome -Create
$sid = Get-BootstrapSid $BootstrapUserSid
Set-PrivateAcl $DataHome $sid
$logs = Get-LocalDirectory (Join-Path $DataHome 'logs') -Create
Set-PrivateAcl $logs
$remote = Get-LocalDirectory (Join-Path $DataHome 'remote') -Create
Set-PrivateAcl $remote
$registryPath = 'HKLM:\SOFTWARE\Lizi'
$roots = @()
if (Test-Path -LiteralPath $registryPath) {
    $previous = Get-ItemProperty -LiteralPath $registryPath
    $roots = @(($previous.AllowedRoots | ConvertFrom-Json) | ForEach-Object { Get-LocalDirectory $_ })
}
if (-not $ReportRoot -and $roots.Count -eq 0) { $ReportRoot = Join-Path $DataHome 'reports' }
if ($ReportRoot) {
    $ReportRoot = Get-LocalDirectory $ReportRoot -Create
    if ($ReportRoot.Equals($DataHome, [StringComparison]::OrdinalIgnoreCase)) { throw 'The report root cannot be the private data home.' }
    if ($ReportRoot.Equals((Join-Path $DataHome 'reports'), [StringComparison]::OrdinalIgnoreCase)) {
        Set-PrivateAcl $ReportRoot $sid -ReportDirectory
    } else { Grant-ReportRead $ReportRoot }
    $roots = @($ReportRoot) + @($roots | Where-Object { $_ -ne $ReportRoot })
}
foreach ($root in $roots) { Grant-ReportRead $root }

# Only the interactive installing user can read this one file. No access to SQLite or FRP secrets.
$tokenPath = Join-Path $DataHome 'setup-token.txt'
if (-not (Test-Path -LiteralPath $tokenPath)) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    Write-Utf8 $tokenPath ([Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_'))
}
Set-PrivateAcl $tokenPath $sid -Token

# Service binaries/configuration must never be writable by its low-privilege account.
Set-ProgramAcl $InstallRoot
$environment = [ordered]@{
    HOME = $DataHome; USERPROFILE = $DataHome; LIZI_HOME = $DataHome
    LIZI_HOST = '127.0.0.1'; LIZI_PORT = '3210'; LIZI_SERVICE = '1'
    LIZI_WEB_DIST = (Join-Path $backend 'apps/web/dist')
    LIZI_ALLOWED_ROOTS = (ConvertTo-Json -InputObject @($roots) -Compress)
    LIZI_FRPC_PATH = (Join-Path $runtime 'frpc.exe')
    NODE_ENV = 'production'
}
if ($TrustedCaFile) {
    $caTarget = Join-Path $runtime 'trusted-frp-ca.pem'
    Copy-Item -LiteralPath $TrustedCaFile -Destination $caTarget -Force
    $environment.LIZI_FRP_CA_FILE = $caTarget
}
$xml = [xml]'<service />'
function Add-Element([string] $Name, [string] $Value) {
    $element = $xml.CreateElement($Name)
    $element.InnerText = $Value
    [void]$xml.DocumentElement.AppendChild($element)
}
Add-Element 'id' 'LiziService'
Add-Element 'name' 'Lizi Report Service'
Add-Element 'description' 'Local report indexing and authenticated HTTPS tunnel. Closing the desktop does not stop this service.'
Add-Element 'executable' (Join-Path $runtime 'node.exe')
Add-Element 'arguments' ('"' + (Join-Path $backend 'packages/server/src/index.js') + '"')
Add-Element 'workingdirectory' $backend
Add-Element 'startmode' 'Automatic'
Add-Element 'delayedAutoStart' 'true'
Add-Element 'stoptimeout' '30 sec'
Add-Element 'stopparentprocessfirst' 'true'
Add-Element 'logpath' $logs
Add-Element 'resetfailure' '1 hour'
$account = $xml.CreateElement('serviceaccount')
foreach ($entry in @{ domain = 'NT AUTHORITY'; user = 'LocalService' }.GetEnumerator()) {
    $element = $xml.CreateElement($entry.Key); $element.InnerText = $entry.Value; [void]$account.AppendChild($element)
}
[void]$xml.DocumentElement.AppendChild($account)
foreach ($delay in @('5 sec', '15 sec', '60 sec')) {
    $element = $xml.CreateElement('onfailure'); $element.SetAttribute('action', 'restart'); $element.SetAttribute('delay', $delay); [void]$xml.DocumentElement.AppendChild($element)
}
$log = $xml.CreateElement('log'); $log.SetAttribute('mode', 'roll-by-size')
foreach ($entry in @{ sizeThreshold = '10240'; keepFiles = '5' }.GetEnumerator()) {
    $element = $xml.CreateElement($entry.Key); $element.InnerText = $entry.Value; [void]$log.AppendChild($element)
}
[void]$xml.DocumentElement.AppendChild($log)
foreach ($entry in $environment.GetEnumerator()) {
    $element = $xml.CreateElement('env'); $element.SetAttribute('name', $entry.Key); $element.SetAttribute('value', $entry.Value); [void]$xml.DocumentElement.AppendChild($element)
}
$xml.Save((Join-Path $runtime 'LiziService.xml'))
if (Get-Service LiziService -ErrorAction SilentlyContinue) { Invoke-Native $wrapper @('uninstall') }
Invoke-Native $wrapper @('install')
Invoke-Native 'sc.exe' @('failureflag', 'LiziService', '1')
New-Item -Path $registryPath -Force | Out-Null
New-ItemProperty -LiteralPath $registryPath -Name 'InstallRoot' -Value $InstallRoot -PropertyType String -Force | Out-Null
New-ItemProperty -LiteralPath $registryPath -Name 'DataHome' -Value $DataHome -PropertyType String -Force | Out-Null
New-ItemProperty -LiteralPath $registryPath -Name 'AllowedRoots' -Value (ConvertTo-Json -InputObject @($roots) -Compress) -PropertyType String -Force | Out-Null
Invoke-Native $wrapper @('start')
$service = Get-Service LiziService
$service.WaitForStatus('Running', [TimeSpan]::FromSeconds(45))
$healthy = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try { $state = Invoke-RestMethod 'http://127.0.0.1:3210/api/health' -TimeoutSec 2; if ($state.ok) { $healthy = $true; break } } catch { }
    Start-Sleep -Seconds 1
}
if (-not $healthy) { throw "Service started but HTTP health check failed. Inspect $logs" }
Write-Host "LiziService installed as LocalService. Data: $DataHome. Report roots: $($roots -join ', ')"
