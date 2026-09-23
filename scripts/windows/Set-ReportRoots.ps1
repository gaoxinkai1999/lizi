[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string[]] $ReportRoots
)
. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-Administrator
try {
    Start-LiziOperation 'report-roots'
    Set-LiziStage '[1/4] Checking installed configuration and report directories'
    $registryPath = 'HKLM:\SOFTWARE\Lizi'
    $metadata = Get-ItemProperty -LiteralPath $registryPath
    $DataHome = Get-LocalDirectory $metadata.DataHome
    $roots = @($ReportRoots | ForEach-Object {
        $root = Get-LocalDirectory $_
        if ($root.Equals($DataHome, [StringComparison]::OrdinalIgnoreCase)) { throw 'The report root cannot be the private data home.' }
        $root
    } | Select-Object -Unique)
    if ($roots.Count -eq 0) { throw 'At least one report root is required.' }
    $xmlPath = Join-Path (Get-LocalDirectory $metadata.InstallRoot) 'runtime/LiziService.xml'
    [xml]$xml = Get-Content -LiteralPath $xmlPath -Raw
    $entry = $xml.service.env | Where-Object { $_.name -eq 'LIZI_ALLOWED_ROOTS' }
    if (-not $entry) { throw 'Installed service configuration does not contain LIZI_ALLOWED_ROOTS.' }
    Set-LiziStage '[2/4] Checking LocalService report-root ACLs (existing grants are reused; missing grants can take time to inherit)'
    $rootNumber = 0
    foreach ($root in $roots) {
        $rootNumber++
        Write-LiziProgress "Checking report directory ACL $rootNumber/$($roots.Count): $root"
        $aclWatch = [Diagnostics.Stopwatch]::StartNew()
        Grant-ReportRead $root
        Write-LiziProgress ('Report directory {0} ACL policy checked ({1:N1}s); effective access is not verified.' -f $rootNumber, $aclWatch.Elapsed.TotalSeconds)
    }
    Set-LiziStage '[3/4] Restarting the service with the authorized directories'
    Stop-LiziService
    $entry.SetAttribute('value', (ConvertTo-Json -InputObject @($roots) -Compress))
    $xml.Save($xmlPath)
    New-ItemProperty -LiteralPath $registryPath -Name 'AllowedRoots' -Value (ConvertTo-Json -InputObject @($roots) -Compress) -PropertyType String -Force | Out-Null
    # Changing roots must not override an administrator's Disabled startup setting.
    Start-LiziService
    Set-LiziStage '[4/4] Checking local HTTP readiness (reports load on demand by selected date)'
    Wait-LiziHealth
    Set-LiziStage 'Allowed roots updated. Select an authorized report directory in settings; historical reports load on demand by date.'
} catch {
    Write-LiziFailure $_
    exit 1
}
