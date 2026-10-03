[CmdletBinding()]
param([switch] $SkipBackend)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path $PSScriptRoot -Parent
$versions = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-versions.json') -Raw | ConvertFrom-Json
$resources = Join-Path $root 'apps/desktop/resources'
$cache = Join-Path $resources '.downloads'
$runtime = Join-Path $resources 'runtime'
[IO.Directory]::CreateDirectory($cache) | Out-Null
[IO.Directory]::CreateDirectory($runtime) | Out-Null

function Get-VerifiedResource($Entry, [string] $Name) {
    $destination = Join-Path $cache $Name
    if (Test-Path -LiteralPath $destination) {
        if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $Entry.sha256) { Remove-Item -LiteralPath $destination -Force }
    }
    if (-not (Test-Path -LiteralPath $destination)) {
        $partial = "$destination.part"
        try {
            Invoke-WebRequest -Uri $Entry.url -OutFile $partial -UseBasicParsing
            $actual = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash
            if ($actual -ne $Entry.sha256) { throw "SHA256 mismatch for $Name. Expected $($Entry.sha256), received $actual" }
            Move-Item -LiteralPath $partial -Destination $destination -Force
        } finally { if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force } }
    }
    return $destination
}

$nodeArchive = Get-VerifiedResource $versions.node "node-$($versions.node.version).zip"
$winSw = Get-VerifiedResource $versions.winsw "winsw-$($versions.winsw.version).exe"
Expand-Archive -LiteralPath $nodeArchive -DestinationPath $cache -Force
$nodeDirectory = Join-Path $cache "node-v$($versions.node.version)-win-x64"
Copy-Item -LiteralPath (Join-Path $nodeDirectory 'node.exe') -Destination (Join-Path $runtime 'node.exe') -Force
Copy-Item -LiteralPath (Join-Path $nodeDirectory 'LICENSE') -Destination (Join-Path $runtime 'NODE-LICENSE.txt') -Force
# Older generated resources must not leak the removed tunnel into a new installer.
foreach ($obsolete in @('frpc.exe', 'FRP-LICENSE.txt', 'trusted-frp-ca.pem')) {
    $obsoletePath = Join-Path $runtime $obsolete
    if (Test-Path -LiteralPath $obsoletePath) { Remove-Item -LiteralPath $obsoletePath -Force }
}
Copy-Item -LiteralPath $winSw -Destination (Join-Path $runtime 'LiziService.exe') -Force
Copy-Item -LiteralPath (Join-Path $root 'apps/desktop/build/WINSW-LICENSE.txt') -Destination $runtime -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'runtime-versions.json') -Destination $runtime -Force
if (-not $SkipBackend) {
    & (Join-Path $nodeDirectory 'node.exe') (Join-Path $PSScriptRoot 'prepare-backend.js') (Join-Path $nodeDirectory 'node_modules/npm/bin/npm-cli.js')
    if ($LASTEXITCODE -ne 0) { throw 'Backend resource preparation failed.' }
}
Write-Host "Verified standalone runtime resources prepared in $resources"
