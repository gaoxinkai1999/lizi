[CmdletBinding()]
param(
    [ValidateSet('List', 'Configure', 'Restore')][string] $Action = 'List',
    [ValidateRange(1, 2147483647)][int] $InterfaceIndex,
    [ValidateSet('host', 'collector')][string] $Role
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$stateRoot = 'HKLM:\SOFTWARE\Lizi\LanAdapters'

function Fail([int] $Code) { $exception = [InvalidOperationException]::new('LAN operation rejected.'); $exception.Data['LanExitCode'] = $Code; throw $exception }

function Get-PhysicalEthernet([int] $Index = 0) {
    # Ethernet (802.3) only; excludes Wi-Fi, tunnels and virtual adapters.
    return @(Get-NetAdapter -Physical | Where-Object {
        [string]$_.PhysicalMediaType -eq '802.3' -and ($Index -eq 0 -or [int]$_.ifIndex -eq $Index)
    })
}

function Get-StatePath($Adapter) { return Join-Path $stateRoot ([guid]$Adapter.InterfaceGuid).ToString('D') }

function Get-ManualDns($Adapter) {
    $key = 'HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\{' + ([guid]$Adapter.InterfaceGuid).ToString('D') + '}'
    $value = Get-ItemProperty -LiteralPath $key -Name NameServer -ErrorAction SilentlyContinue
    return ($value -and $value.NameServer)
}

function Get-Addresses([int] $Index) { return @(Get-NetIPAddress -InterfaceIndex $Index -AddressFamily IPv4 -ErrorAction SilentlyContinue) }
function Has-DefaultRoute([int] $Index) {
    return @(Get-NetRoute -InterfaceIndex $Index -ErrorAction SilentlyContinue | Where-Object { $_.DestinationPrefix -in @('0.0.0.0/0', '::/0') }).Count -gt 0
}

function Get-AdapterList {
    $items = @(foreach ($adapter in @(Get-PhysicalEthernet)) {
        $index = [int]$adapter.ifIndex
        $ipInterface = Get-NetIPInterface -InterfaceIndex $index -AddressFamily IPv4
        $addresses = @(Get-Addresses $index | ForEach-Object { [string]$_.IPAddress })
        [ordered]@{
            interfaceIndex = $index
            name = [string]$adapter.Name
            status = [string]$adapter.Status
            macAddress = [string]$adapter.MacAddress
            dhcpEnabled = ([string]$ipInterface.Dhcp -eq 'Enabled')
            hasDefaultRoute = (Has-DefaultRoute $index)
            ipv4Addresses = @($addresses)
            hasNonApipaIPv4 = @($addresses | Where-Object { $_ -notmatch '^169\.254\.' }).Count -gt 0
            canRestore = (Test-Path -LiteralPath (Get-StatePath $adapter))
        }
    })
    ConvertTo-Json -InputObject $items -Depth 5 -Compress
}

function Convert-IPv4([string] $Address) {
    $bytes = [Net.IPAddress]::Parse($Address).GetAddressBytes()
    [Array]::Reverse($bytes)
    return [uint32][BitConverter]::ToUInt32($bytes, 0)
}

function Test-Overlap([string] $Address, [int] $PrefixLength) {
    $prefix = [Math]::Min($PrefixLength, 24)
    $mask = if ($prefix -eq 0) { [uint32]0 } else { [uint32](([uint64]4294967295 -shl (32 - $prefix)) -band [uint64]4294967295) }
    return (((Convert-IPv4 $Address) -band $mask) -eq ((Convert-IPv4 '192.168.250.0') -band $mask))
}

function Assert-Isolated($Adapter) {
    $index = [int]$Adapter.ifIndex
    if (Has-DefaultRoute $index) { Fail 11 }
    $ipInterface = Get-NetIPInterface -InterfaceIndex $index -AddressFamily IPv4
    if ([string]$ipInterface.Dhcp -ne 'Enabled') { Fail 12 }
    if (@(Get-Addresses $index | Where-Object { $_.IPAddress -notmatch '^169\.254\.' -or [string]$_.PrefixOrigin -eq 'Manual' }).Count) { Fail 13 }
    if (@(Get-NetIPAddress -InterfaceIndex $index -AddressFamily IPv4 -PolicyStore PersistentStore -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^169\.254\.' -or [string]$_.PrefixOrigin -eq 'Manual' }).Count) { Fail 13 }
    # Never alter existing manual DNS. An unused DHCP adapter must have no DNS leases either.
    if (Get-ManualDns $Adapter) { Fail 14 }
    if (@(Get-DnsClientServerAddress -InterfaceIndex $index -AddressFamily IPv4 | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ }).Count) { Fail 14 }
    foreach ($address in @(Get-NetIPAddress -AddressFamily IPv4)) {
        if ($address.InterfaceIndex -ne $index -and (Test-Overlap $address.IPAddress ([int]$address.PrefixLength))) { Fail 15 }
    }
    foreach ($route in @(Get-NetRoute -AddressFamily IPv4)) {
        if ($route.InterfaceIndex -eq $index -or $route.DestinationPrefix -eq '0.0.0.0/0') { continue }
        $parts = $route.DestinationPrefix.Split('/')
        if (Test-Overlap $parts[0] ([int]$parts[1])) { Fail 15 }
    }
}

function Restore-State($Adapter, $State) {
    $index = [int]$Adapter.ifIndex
    if ([string]$State.guid -ne ([guid]$Adapter.InterfaceGuid).ToString('D') -or $State.dhcp -ne 'Enabled' -or $State.target -notin @('192.168.250.1', '192.168.250.2')) { Fail 16 }
    if (Has-DefaultRoute $index) { Fail 11 }
    if (Get-ManualDns $Adapter) { Fail 14 }
    # Check both stores before deleting only the exact address created by this wizard.
    $addresses = @(foreach ($store in @('ActiveStore', 'PersistentStore')) {
        Get-NetIPAddress -InterfaceIndex $index -AddressFamily IPv4 -PolicyStore $store -ErrorAction SilentlyContinue
    })
    if (@($addresses | Where-Object { ($_.IPAddress -ne $State.target -and ($_.IPAddress -notmatch '^169\.254\.' -or [string]$_.PrefixOrigin -eq 'Manual')) -or ($_.IPAddress -eq $State.target -and $_.PrefixLength -ne 24) }).Count) { Fail 13 }
    foreach ($store in @('PersistentStore', 'ActiveStore')) {
        $owned = @(Get-NetIPAddress -InterfaceIndex $index -AddressFamily IPv4 -PolicyStore $store -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -eq $State.target })
        if ($owned.Count) { Remove-NetIPAddress -InterfaceIndex $index -IPAddress $State.target -AddressFamily IPv4 -PolicyStore $store -Confirm:$false }
    }
    Set-NetIPInterface -InterfaceIndex $index -AddressFamily IPv4 -Dhcp Enabled
    # No DNS or gateway was changed. Windows regenerates APIPA when no DHCP server answers.
}

function Configure-DirectLink($Adapter, [string] $SelectedRole) {
    $index = [int]$Adapter.ifIndex
    $statePath = Get-StatePath $Adapter
    if (Test-Path -LiteralPath $statePath) { Fail 17 }
    Assert-Isolated $Adapter
    $target = if ($SelectedRole -eq 'host') { '192.168.250.1' } else { '192.168.250.2' }
    $snapshot = [pscustomobject]@{
        guid = ([guid]$Adapter.InterfaceGuid).ToString('D')
        interfaceIndex = $index
        dhcp = 'Enabled'
        apipa = @(Get-Addresses $index | ForEach-Object { [ordered]@{ address = $_.IPAddress; prefixLength = $_.PrefixLength } })
        target = $target
    }
    # HKLM persists across desktop restarts and is not writable by the renderer/user account.
    New-Item -Path $statePath -Force | Out-Null
    New-ItemProperty -LiteralPath $statePath -Name Snapshot -PropertyType String -Value (ConvertTo-Json $snapshot -Depth 5 -Compress) -Force | Out-Null
    $mutationStarted = $false
    try {
        # Recheck after persisting state, before the first mutation.
        Assert-Isolated $Adapter
        $mutationStarted = $true
        Set-NetIPInterface -InterfaceIndex $index -AddressFamily IPv4 -Dhcp Disabled
        foreach ($address in @(Get-Addresses $index | Where-Object { $_.IPAddress -match '^169\.254\.' -and [string]$_.PrefixOrigin -ne 'Manual' })) {
            $address | Remove-NetIPAddress -Confirm:$false
        }
        New-NetIPAddress -InterfaceIndex $index -IPAddress $target -PrefixLength 24 -AddressFamily IPv4 -Type Unicast | Out-Null
        # DAD must settle before success is reported; a conflicting peer address triggers rollback.
        $ready = $false
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            $assigned = Get-NetIPAddress -InterfaceIndex $index -AddressFamily IPv4 -IPAddress $target
            if ([string]$assigned.AddressState -eq 'Duplicate') { Fail 18 }
            if ([string]$assigned.AddressState -eq 'Preferred') { $ready = $true; break }
            Start-Sleep -Milliseconds 500
        }
        if (-not $ready) { Fail 18 }
    } catch {
        $failure = $_
        if (-not $mutationStarted) {
            Remove-Item -LiteralPath $statePath -Recurse -Force
            throw $failure
        }
        try {
            Restore-State $Adapter $snapshot
            Remove-Item -LiteralPath $statePath -Recurse -Force
        } catch { Fail 20 }
        throw $failure
    }
}

function Restore-DirectLink($Adapter) {
    $statePath = Get-StatePath $Adapter
    if (-not (Test-Path -LiteralPath $statePath)) { Fail 16 }
    $snapshot = (Get-ItemProperty -LiteralPath $statePath -Name Snapshot).Snapshot | ConvertFrom-Json
    Restore-State $Adapter $snapshot
    Remove-Item -LiteralPath $statePath -Recurse -Force
}

$lock = $null
$locked = $false
try {
    if ($Action -eq 'List') { Get-AdapterList; exit 0 }
    if (-not $InterfaceIndex -or ($Action -eq 'Configure' -and -not $Role) -or ($Action -eq 'Restore' -and $Role)) { Fail 10 }
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 10 }
    $lock = [Threading.Mutex]::new($false, 'Global\LiziLanAdapterConfiguration')
    $locked = $lock.WaitOne(0)
    if (-not $locked) { Fail 19 }
    $adapters = @(Get-PhysicalEthernet $InterfaceIndex)
    if ($adapters.Count -ne 1) { Fail 10 }
    if ($Action -eq 'Configure') { Configure-DirectLink $adapters[0] $Role }
    else { Restore-DirectLink $adapters[0] }
    exit 0
} catch {
    $code = $_.Exception.Data['LanExitCode']
    if (-not $code) { $code = 1 }
    # Exit codes convey safe fixed messages; do not print privileged command output.
    exit ([int]$code)
} finally {
    if ($lock) {
        if ($locked) { $lock.ReleaseMutex() }
        $lock.Dispose()
    }
}
