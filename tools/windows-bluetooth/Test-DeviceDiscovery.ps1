#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'DeviceDiscovery.ps1')
$script:tests = 0

function Assert-Equal($Actual, $Expected, [string]$Message) {
    if ($Actual -ne $Expected) { throw "$Message -- expected '$Expected', got '$Actual'" }
}
function Test-Case([string]$Name, [scriptblock]$Body) {
    & $Body
    $script:tests++
    Write-Host "PASS: $Name"
}

Test-Case 'Standard XRP names retain their normal confirmation' {
    foreach ($name in @('XRP-724e7', 'xrp-f6a2a', 'XRP USB 1', 'XRP_test')) {
        Assert-Equal (Get-XrpBleNameKind $name) xrp_name $name
    }
    Assert-Equal (Get-XrpProbeConfirmationToken xrp_name) YES 'Confirmation'
}
Test-Case 'Windows MPY BTSTACK name is eligible but never called a verified XRP' {
    Assert-Equal (Get-XrpBleNameKind 'MPY BTSTACK') generic_micropython 'Classification'
    Assert-Equal (Get-XrpBleNameKind ' mpy btstack ') generic_micropython 'Case and whitespace'
    Assert-Equal (Get-XrpProbeConfirmationToken generic_micropython) 'YES XRP' 'Explicit confirmation'
}
Test-Case 'Other BLE peripherals and unrelated MPY names remain excluded' {
    foreach ($name in @('Keyboard', 'Headphones', 'MPY', 'MPY UART', 'MPY BTSTACK Other', 'My XRP', 'XRPretender')) {
        Assert-Equal (Get-XrpBleNameKind $name) unsupported $name
    }
}
Test-Case 'Missing names do not crash discovery or match every device' {
    Assert-Equal (Get-XrpBleNameKind $null) unsupported 'Null'
    Assert-Equal (Get-XrpBleNameKind '') unsupported 'Empty'
    Assert-Equal (Get-XrpBleNameKind '  ') unsupported 'Whitespace'
}
Test-Case 'Previously filtered MPY BTSTACK device becomes one explicit candidate' {
    $devices = @([pscustomobject]@{Name='MPY BTSTACK'; Id='ble-one'})
    $candidates = @(Get-XrpBleCandidates $devices)
    Assert-Equal $candidates.Count 1 'Count'
    Assert-Equal $candidates[0].NameKind generic_micropython 'Classification retained'
    Assert-Equal $candidates[0].Id ble-one 'Native endpoint retained'
}
Test-Case 'Deduplicate the same endpoint without merging distinct same-name boards' {
    $devices = @(
        [pscustomobject]@{Name='MPY BTSTACK'; Id='ble-one'},
        [pscustomobject]@{Name='MPY BTSTACK'; Id='ble-one'},
        [pscustomobject]@{Name='MPY BTSTACK'; Id='ble-two'})
    Assert-Equal @(Get-XrpBleCandidates $devices).Count 2 'Count must preserve ambiguity'
}
Test-Case 'Unknown devices and missing endpoint IDs cannot be selected' {
    $devices = @($null, [pscustomobject]@{Name='Keyboard'; Id='other'},
        [pscustomobject]@{Name='XRP-724e7'; Id=''}, [pscustomobject]@{Name=$null; Id='unnamed'})
    Assert-Equal @(Get-XrpBleCandidates $devices).Count 0 'Count'
    Assert-Equal @(Get-XrpBleCandidates @()).Count 0 'Empty list'
}
Test-Case 'An unsupported classification cannot obtain a confirmation token' {
    $failed = $false
    try { Get-XrpProbeConfirmationToken unsupported } catch { $failed = $true }
    Assert-Equal $failed $true 'Must refuse'
}
Write-Host "All $script:tests discovery tests passed. No Bluetooth device was accessed."
