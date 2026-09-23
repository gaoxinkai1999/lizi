[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string[]] $ReportRoots
)
. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-Administrator
$registryPath = 'HKLM:\SOFTWARE\Lizi'
$metadata = Get-ItemProperty -LiteralPath $registryPath
$DataHome = Get-LocalDirectory $metadata.DataHome
$roots = @($ReportRoots | ForEach-Object {
    $root = Get-LocalDirectory $_
    if ($root.Equals($DataHome, [StringComparison]::OrdinalIgnoreCase)) { throw 'The report root cannot be the private data home.' }
    Grant-ReportRead $root
    $root
} | Select-Object -Unique)
if ($roots.Count -eq 0) { throw 'At least one report root is required.' }
$xmlPath = Join-Path (Get-LocalDirectory $metadata.InstallRoot) 'runtime/LiziService.xml'
[xml]$xml = Get-Content -LiteralPath $xmlPath -Raw
$entry = $xml.service.env | Where-Object { $_.name -eq 'LIZI_ALLOWED_ROOTS' }
if (-not $entry) { throw 'Installed service configuration does not contain LIZI_ALLOWED_ROOTS.' }
Stop-LiziService
$entry.SetAttribute('value', (ConvertTo-Json -InputObject @($roots) -Compress))
$xml.Save($xmlPath)
New-ItemProperty -LiteralPath $registryPath -Name 'AllowedRoots' -Value (ConvertTo-Json -InputObject @($roots) -Compress) -PropertyType String -Force | Out-Null
Start-Service -Name LiziService
(Get-Service LiziService).WaitForStatus('Running', [TimeSpan]::FromSeconds(45))
Write-Host 'Allowed roots updated. Select an authorized report directory in the application settings.'
