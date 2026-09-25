[CmdletBinding()]
param([Parameter(Mandatory = $true)][string] $InstallRoot)
. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-Administrator
try {
    Start-LiziOperation 'uninstall'
    Set-LiziStage '[1/4] Checking installed resources'
    $InstallRoot = Get-LocalDirectory $InstallRoot
    Set-LiziStage '[2/4] Stopping LiziService'
    Stop-LiziService
    Set-LiziStage '[3/4] Removing the service registration (user data is preserved)'
    if (Get-Service -Name LiziService -ErrorAction SilentlyContinue) {
        $wrapper = Join-Path $InstallRoot 'runtime/LiziService.exe'
        if (Test-Path -LiteralPath $wrapper -PathType Leaf) { Invoke-Native $wrapper @('uninstall') }
        else { Invoke-Native 'sc.exe' @('delete', 'LiziService') -TimeoutSeconds 30 }
    }
    Set-LiziStage '[4/4] Removing only Lizi LocalSubnet LAN firewall rules'
    Remove-LiziLanFirewall
    # The uninstaller intentionally never removes ProgramData/Lizi or source reports.
    Set-LiziStage 'Uninstallation complete. Accounts, settings, cache, reports and unrelated firewall rules were preserved.'
} catch {
    Write-LiziFailure $_
    exit 1
}
