#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Check', 'List', 'Probe')][string]$Mode = 'Probe',
    [string]$DeviceName,
    [ValidateRange(3, 300)][int]$HoldSeconds = 30,
    [ValidateRange(1, 30)][int]$RecoverySeconds = 10,
    [switch]$RttTest,
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { $OutputDirectory = Join-Path $PSScriptRoot 'reports' }
. (Join-Path $PSScriptRoot 'IntervalTrial.ps1')
. (Join-Path $PSScriptRoot 'DeviceDiscovery.ps1')

function Initialize-XrpWinRt {
    if ($PSVersionTable.PSEdition -ne 'Desktop') {
        throw 'Use Windows PowerShell 5.1 (powershell.exe), not PowerShell 7 (pwsh.exe).'
    }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    [void][Windows.Devices.Bluetooth.BluetoothLEDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
    [void][Windows.Devices.Bluetooth.BluetoothLEPreferredConnectionParameters, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
    [void][Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType = WindowsRuntime]
    [void][Windows.Foundation.Metadata.ApiInformation, Windows.Foundation, ContentType = WindowsRuntime]
    if (-not [Windows.Foundation.Metadata.ApiInformation]::IsMethodPresent(
        'Windows.Devices.Bluetooth.BluetoothLEDevice', 'RequestPreferredConnectionParameters')) {
        throw 'Windows 11 build 22000 or later and the BLE connection-parameters API are required.'
    }
}

function Wait-XrpWinRt {
    param($Operation, [type]$ResultType)
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and
        $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    try {
        if (-not $task.Wait(15000)) {
            throw 'Windows device access timed out after 15 seconds. No profile was requested.'
        }
        return $task.GetAwaiter().GetResult()
    } catch {
        # No profile is created before the device-access operation completes.
        try { $Operation.Cancel() } catch { Write-Warning 'Windows could not cancel the failed device-access operation.' }
        throw
    }
}

function Get-XrpConnectedDevices {
    $selector = [Windows.Devices.Bluetooth.BluetoothLEDevice]::GetDeviceSelectorFromConnectionStatus(
        [Windows.Devices.Bluetooth.BluetoothConnectionStatus]::Connected)
    $operation = [Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync(
        $selector, [string[]]@(), [Windows.Devices.Enumeration.DeviceInformationKind]::AssociationEndpoint)
    $devices = @(Wait-XrpWinRt $operation ([Windows.Devices.Enumeration.DeviceInformationCollection]))
    Write-Host "Windows BLE entries: $($devices.Count). These names can differ from the IDE."
    foreach ($entry in $devices) {
        $kind = Get-XrpBleNameKind $entry.Name
        $name = if ([string]::IsNullOrWhiteSpace($entry.Name)) { '<unnamed>' } else { $entry.Name }
        Write-Host "WINDOWS_BLE_NAME: $name; classification=$kind"
    }
    Get-XrpBleCandidates $devices
}

function Save-XrpIntervalReport {
    param($Report)
    [void][System.IO.Directory]::CreateDirectory($OutputDirectory)
    $name = 'xrp-ble-interval-{0}-{1}.json' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), ([guid]::NewGuid().ToString('N').Substring(0, 8))
    $path = Join-Path $OutputDirectory $name
    $json = $Report | ConvertTo-Json -Depth 8
    $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
    try {
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
    Write-Host "REPORT: $path" -ForegroundColor Cyan
}

$native = @{ profile = $null; observation = $null }
$report = $null
$mutex = $null
$locked = $false
$exitCode = 0
try {
    Initialize-XrpWinRt
    if ($Mode -eq 'Check') {
        Write-Host 'CHECK_OK: Windows BLE interval API is available. No devices opened and no profile requested.'
        $preferred = [Windows.Devices.Bluetooth.BluetoothLEPreferredConnectionParameters]::ThroughputOptimized
        Write-Host ('Profile requests {0}-{1} ms; this is not a negotiated interval.' -f
            ($preferred.MinConnectionInterval * 1.25), ($preferred.MaxConnectionInterval * 1.25))
        exit 0
    }
    $devices = @(Get-XrpConnectedDevices)
    foreach ($entry in $devices) { Write-Host "BLE_CANDIDATE: $($entry.Name); classification=$($entry.NameKind)" }
    if ($Mode -eq 'List') {
        Write-Host "Eligible BLE candidate count: $($devices.Count). No devices opened and no profile requested."
        exit 0
    }
    if ($devices.Count -ne 1) {
        throw "Found $($devices.Count) eligible BLE candidates in Windows. This is not proof that the IDE is disconnected. Check the Windows names above; the single-robot probe requires one XRP-named or explicitly confirmed MPY BTSTACK candidate. No profile requested."
    }
    $selected = $devices[0]
    if ($DeviceName -and -not [string]::Equals($selected.Name, $DeviceName, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Windows reports $($selected.Name), not $DeviceName. The DeviceName option matches the Windows name, not a dashboard alias. No profile requested."
    }
    $mutex = [System.Threading.Mutex]::new($false, 'Local\XrpBleIntervalProbe')
    try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another interval probe is running. Close it before retrying.' }
    Write-Host "Selected Windows name: $($selected.Name). Keep the IDE connected and do not run another program during this probe."
    if ($selected.NameKind -eq 'generic_micropython') {
        Write-Warning 'MPY BTSTACK is a generic MicroPython name, not a verified XRP identity. Continue only if this is your XRP and no other MicroPython board is connected. Otherwise cancel.'
    }
    Write-Host "The request lasts $HoldSeconds seconds; it can affect other Bluetooth devices."
    if ($RttTest) {
        Write-Host 'RTT TEST: the robot RTT program must already be running. Do not press Run again.'
        Write-Host 'Wait for THREE consecutive DURING readings at 15 ms with request=Success, then start ONE 30-sample RTT series in the IDE.' -ForegroundColor Cyan
        Write-Host 'Keep this window open. Finish the series before AFTER starts. If the interval changes or an error appears, stop the series and share both reports.'
    } else {
        Write-Host 'No RTT samples are needed yet.'
    }
    $confirmation = Get-XrpProbeConfirmationToken $selected.NameKind
    $answer = Read-Host "Type $confirmation to confirm this is your XRP and request the temporary profile, or Enter to cancel"
    if ($answer -cne $confirmation) { Write-Host 'Cancelled. No profile requested.'; exit 0 }

    $report = New-XrpIntervalReport
    $report.device_name = $selected.Name
    $report.selection_name_kind = $selected.NameKind
    $report.operator_confirmed_xrp = $true
    $report.windows_version = [Environment]::OSVersion.Version.ToString()
    $native.profile = Wait-XrpWinRt ([Windows.Devices.Bluetooth.BluetoothLEDevice]::FromIdAsync($selected.Id)) ([Windows.Devices.Bluetooth.BluetoothLEDevice])
    if ($null -eq $native.profile) { throw 'Windows denied device access or the robot is unavailable. No profile requested.' }
    $preferred = [Windows.Devices.Bluetooth.BluetoothLEPreferredConnectionParameters]::ThroughputOptimized
    $report.requested_min_interval_ms = $preferred.MinConnectionInterval * 1.25
    $report.requested_max_interval_ms = $preferred.MaxConnectionInterval * 1.25
    $report.requested_peripheral_latency_events = [int]$preferred.ConnectionLatency
    Invoke-XrpIntervalTrial -Report $report -HoldSeconds $HoldSeconds -RecoverySeconds $RecoverySeconds `
        -ReadLink {
            param($phase, $status)
            $readDevice = $native.profile
            if ($phase -eq 'after') {
                # The requesting device was disposed; this reference only observes.
                if ($null -eq $native.observation) {
                    $native.observation = Wait-XrpWinRt ([Windows.Devices.Bluetooth.BluetoothLEDevice]::FromIdAsync($selected.Id)) ([Windows.Devices.Bluetooth.BluetoothLEDevice])
                }
                if ($null -eq $native.observation) { throw 'Windows denied access to post-release observations.' }
                $readDevice = $native.observation
            }
            $connection = [string]$readDevice.ConnectionStatus
            $parameters = $null
            if ($connection -eq 'Connected') { $parameters = $readDevice.GetConnectionParameters() }
            ConvertTo-XrpLinkSample $parameters $connection $phase $status
        } -CreateRequest { $native.profile.RequestPreferredConnectionParameters($preferred) } `
        -ReadRequestStatus { param($request) [string]$request.Status } `
        -CloseRequest {
            param($request)
            try { ([System.IDisposable]$request).Dispose() } finally {
                # Device disposal is Microsoft's documented default-restoration path.
                ([System.IDisposable]$native.profile).Dispose()
                $native.profile = $null
                $report.device_reference_released = $true
                if ($RttTest) { Write-Host 'RTT_WINDOW_CLOSED: temporary profile released. Do not collect more optimized RTT samples.' -ForegroundColor Yellow }
            }
        } `
        -OnSample {
            param($sample)
            $interval = 'unknown'
            if ($null -ne $sample.interval_ms) { $interval = "$($sample.interval_ms) ms" }
            Write-Host ('{0,-6} interval={1}; connected={2}; request={3}' -f
                $sample.phase.ToUpperInvariant(), $interval, $sample.connected, $sample.request_status)
        }
    Write-Host ''
    Write-Host "RESULT: $($report.summary.outcome)" -ForegroundColor Cyan
    Write-Host ('Before: {0} ms | Minimum during: {1} ms | Last after: {2} ms' -f
        $report.summary.baseline_interval_ms, $report.summary.minimum_during_interval_ms, $report.summary.last_after_interval_ms)
    Write-Host 'Request acceptance is not proof of a lower interval or a lower RTT.'
    if ($report.request_released) { Write-Host 'Temporary request released. Windows and the IDE control the resulting default parameters.' }
    if ($report.summary.baseline_observed_again_after_release -eq $false) {
        Write-Warning 'The original interval was not observed again yet. After this utility exits, reconnect Bluetooth in the IDE to start a fresh default session.'
    }
    if ($report.error -or $report.release_error -or $report.recovery_error) { $exitCode = 1 }
} catch {
    $exitCode = 1
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    if ($null -ne $report -and $null -eq $report.error) { $report.error = $_.Exception.Message }
} finally {
    foreach ($reference in @('profile', 'observation')) {
        if ($null -ne $native[$reference]) {
            try {
                ([System.IDisposable]$native[$reference]).Dispose()
                if ($null -ne $report) {
                    if ($reference -eq 'profile') { $report.device_reference_released = $true }
                    else { $report.observation_reference_released = $true }
                }
            } catch {
                $exitCode = 1
                if ($null -ne $report) { $report.device_release_error = $_.Exception.Message }
                Write-Warning 'Could not release a device reference normally. Close this utility and reconnect Bluetooth in the IDE.'
            }
        }
    }
    if ($locked) { $mutex.ReleaseMutex() }
    if ($null -ne $mutex) { $mutex.Dispose() }
    if ($null -ne $report) {
        $report.finished_utc = [DateTime]::UtcNow.ToString('o')
        try { Save-XrpIntervalReport $report } catch {
            $exitCode = 1
            Write-Warning "Could not save report: $($_.Exception.Message)"
        }
        foreach ($field in @('error', 'release_error', 'recovery_error', 'device_release_error')) {
            if ($report.$field) { Write-Host "${field}: $($report.$field)" -ForegroundColor Red }
        }
    }
}
exit $exitCode
