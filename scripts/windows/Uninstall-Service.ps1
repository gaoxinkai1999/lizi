[CmdletBinding()]
param([Parameter(Mandatory = $true)][string] $InstallRoot)
. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-Administrator
$InstallRoot = Get-LocalDirectory $InstallRoot
Stop-LiziService
if (Get-Service -Name LiziService -ErrorAction SilentlyContinue) {
    $wrapper = Join-Path $InstallRoot 'runtime/LiziService.exe'
    if (Test-Path -LiteralPath $wrapper -PathType Leaf) { Invoke-Native $wrapper @('uninstall') }
    else { Invoke-Native 'sc.exe' @('delete', 'LiziService') }
}
# The uninstaller intentionally never removes ProgramData/Lizi or source reports.
Write-Host 'LiziService removed. Accounts, settings, cache and reports were preserved.'
