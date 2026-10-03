[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $InstallRoot,
    [string] $ReportRoot,
    [string] $ReportRootFile,
    [string] $DataHome = (Join-Path $env:ProgramData 'Lizi'),
    [string] $BootstrapUserSid
)
. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-Administrator
try {
    Start-LiziOperation 'install'
    Set-LiziStage '[1/7] Checking packaged resources'
    if ($ReportRootFile) {
        if ($ReportRoot) { throw 'Specify ReportRoot or ReportRootFile, not both.' }
        $ReportRoot = Get-Content -LiteralPath $ReportRootFile -Raw
    }
    $InstallRoot = Get-LocalDirectory $InstallRoot
    $runtime = Join-Path $InstallRoot 'runtime'
    $backend = Join-Path $InstallRoot 'backend'
    $wrapper = Join-Path $runtime 'LiziService.exe'
    foreach ($path in @($wrapper, (Join-Path $runtime 'node.exe'), (Join-Path $backend 'packages/server/src/index.js'), (Join-Path $backend 'apps/web/dist/index.html'))) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Throw-LiziError "Missing packaged resource: $path. Run Prepare-Resources.ps1 before packaging." }
    }

    Set-LiziStage '[2/7] Stopping the previous service and preparing directories (user data is preserved)'
    Stop-LiziService
    $DataHome = Get-LocalDirectory $DataHome -Create
    $sid = Get-BootstrapSid $BootstrapUserSid
    Set-PrivateAcl $DataHome $sid
    $logs = Get-LocalDirectory (Join-Path $DataHome 'logs') -Create
    Set-PrivateAcl $logs
    $registryPath = 'HKLM:\SOFTWARE\Lizi'
    $roots = @()
    if (Test-Path -LiteralPath $registryPath) {
        $previous = Get-ItemProperty -LiteralPath $registryPath
        $roots = @(($previous.AllowedRoots | ConvertFrom-Json) | ForEach-Object { Get-LocalDirectory $_ })
    }
    if (-not $ReportRoot -and $roots.Count -eq 0) { $ReportRoot = Join-Path $DataHome 'reports' }
    if ($ReportRoot) {
        $ReportRoot = Get-LocalDirectory $ReportRoot -Create
        $roots = @($ReportRoot) + @($roots | Where-Object { $_ -ne $ReportRoot })
    }
    $roots = @($roots | Select-Object -Unique)
    foreach ($root in $roots) {
        if ($root.Equals($DataHome, [StringComparison]::OrdinalIgnoreCase)) { throw 'The report root cannot be the private data home.' }
    }

    Set-LiziStage '[3/7] Checking LocalService directory ACLs (existing report grants are reused; missing grants or private-directory isolation can take time; no total installation timeout)'
    $rootNumber = 0
    foreach ($root in $roots) {
        $rootNumber++
        Write-LiziProgress "Checking report directory ACL $rootNumber/$($roots.Count): $root"
        $aclWatch = [Diagnostics.Stopwatch]::StartNew()
        if ($root.Equals((Join-Path $DataHome 'reports'), [StringComparison]::OrdinalIgnoreCase)) {
            Set-PrivateAcl $root $sid -ReportDirectory
        } else { Grant-ReportRead $root }
        Write-LiziProgress ('Report directory {0} ACL policy checked ({1:N1}s); effective access is not verified.' -f $rootNumber, $aclWatch.Elapsed.TotalSeconds)
    }

    # Only the interactive installing user can read the local management credential.
    $tokenPath = Join-Path $DataHome 'lan-admin-token.txt'
    if (-not (Test-Path -LiteralPath $tokenPath)) {
        $bytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        Write-Utf8 $tokenPath ([Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_'))
    }
    Set-PrivateAcl $tokenPath $sid -Token

    # Service binaries/configuration must never be writable by its low-privilege account.
    Write-LiziProgress 'Protecting packaged programs and service configuration.'
    Set-ProgramAcl $InstallRoot
    $environment = [ordered]@{
        HOME = $DataHome; USERPROFILE = $DataHome; LIZI_HOME = $DataHome
        LIZI_HOST = '127.0.0.1'; LIZI_PORT = '3210'; LIZI_SERVICE = '1'
        LIZI_WEB_DIST = (Join-Path $backend 'apps/web/dist')
        LIZI_ALLOWED_ROOTS = (ConvertTo-Json -InputObject @($roots) -Compress)
        LIZI_MODE = 'client'
        NODE_ENV = 'production'
    }
    $xml = [xml]'<service />'
    function Add-Element([string] $Name, [string] $Value) {
        $element = $xml.CreateElement($Name)
        $element.InnerText = $Value
        [void]$xml.DocumentElement.AppendChild($element)
    }
    Add-Element 'id' 'LiziService'
    Add-Element 'name' 'Lizi Report Service'
    Add-Element 'description' 'Local report acquisition, LAN viewing and durable HTTPS uploads. Closing the desktop does not stop this service.'
    Add-Element 'executable' (Join-Path $runtime 'node.exe')
    Add-Element 'arguments' ('"' + (Join-Path $backend 'packages/server/src/index.js') + '"')
    Add-Element 'workingdirectory' $backend
    Add-Element 'startmode' 'Automatic'
    Add-Element 'delayedAutoStart' 'false'
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

    Set-LiziStage '[4/7] Registering the service (this explicit installation/upgrade enables normal Automatic startup, including a previously Disabled service)'
    if (Get-Service LiziService -ErrorAction SilentlyContinue) { Invoke-Native $wrapper @('uninstall') }
    Invoke-Native $wrapper @('install')
    Invoke-Native 'sc.exe' @('config', 'LiziService', 'start=', 'auto') -TimeoutSeconds 30
    Invoke-Native 'sc.exe' @('failureflag', 'LiziService', '1') -TimeoutSeconds 30
    New-Item -Path $registryPath -Force | Out-Null
    New-ItemProperty -LiteralPath $registryPath -Name 'InstallRoot' -Value $InstallRoot -PropertyType String -Force | Out-Null
    New-ItemProperty -LiteralPath $registryPath -Name 'DataHome' -Value $DataHome -PropertyType String -Force | Out-Null
    New-ItemProperty -LiteralPath $registryPath -Name 'AllowedRoots' -Value (ConvertTo-Json -InputObject @($roots) -Compress) -PropertyType String -Force | Out-Null

    Set-LiziStage '[5/7] Configuring LocalSubnet LAN firewall rules (TCP 3211 and UDP 3212 only)'
    Ensure-LiziLanFirewall (Join-Path $runtime 'node.exe')
    Set-LiziStage '[6/7] Starting LiziService as LocalService'
    Start-LiziService
    Set-LiziStage '[7/7] Checking local HTTP readiness (reports load on demand by selected date; readiness does not wait for historical indexing)'
    Wait-LiziHealth
    Set-LiziStage 'Installation complete. LAN firewall rules are limited to LocalSubnet TCP 3211 and UDP 3212; choose the dual-machine role in Settings. Reports are loaded on demand by date; accounts, settings and reports are preserved.'
    Write-LiziProgress "Service logs: $logs"
} catch {
    Write-LiziFailure $_
    exit 1
}
