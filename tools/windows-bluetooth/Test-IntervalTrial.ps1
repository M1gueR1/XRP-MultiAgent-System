#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'IntervalTrial.ps1')
$script:tests = 0

function Assert-Equal($Actual, $Expected, [string]$Message) {
    if ($Actual -ne $Expected) { throw "$Message -- expected '$Expected', got '$Actual'" }
}

function Test-Case([string]$Name, [scriptblock]$Body) {
    & $Body
    $script:tests++
    Write-Host "PASS: $Name"
}

function Invoke-FakeTrial {
    param(
        [double[]]$Before = @(60, 60, 60),
        [double[]]$During = @(15, 15, 15),
        [double[]]$After = @(60),
        [string]$Status = 'Success',
        [ValidateRange(3, 300)][int]$HoldSeconds = 3,
        [switch]$ThrowCreate, [switch]$ThrowRead, [switch]$ThrowClose, [switch]$ThrowAfter
    )
    $state = @{ before = 0; during = 0; after = 0; created = 0; closed = 0 }
    $report = New-XrpIntervalReport
    $read = {
        param($phase, $statusText)
        if ($phase -eq 'during' -and $ThrowRead) { throw 'Simulated read failure' }
        if ($phase -eq 'after' -and $ThrowAfter) { throw 'Simulated recovery failure' }
        $series = switch ($phase) { 'before' { $Before }; 'during' { $During }; 'after' { $After } }
        $index = $state[$phase]
        $state[$phase]++
        $interval = $series[[Math]::Min($index, $series.Count - 1)]
        $connection = if ($interval -lt 0) { 'Disconnected' } else { 'Connected' }
        $parameters = [pscustomobject]@{ ConnectionInterval = $interval / 1.25; ConnectionLatency = 0; LinkTimeout = 200 }
        ConvertTo-XrpLinkSample $parameters $connection $phase $statusText
    }.GetNewClosure()
    $create = {
        $state.created++
        if ($ThrowCreate) { throw 'Simulated create failure' }
        [pscustomobject]@{ Status = $Status }
    }.GetNewClosure()
    $close = {
        param($request)
        $state.closed++
        if ($ThrowClose) { throw 'Simulated close failure' }
    }.GetNewClosure()
    Invoke-XrpIntervalTrial -Report $report -ReadLink $read -CreateRequest $create -CloseRequest $close `
        -ReadRequestStatus { param($request) $request.Status } -Sleep {} -HoldSeconds $HoldSeconds -RecoverySeconds 1
    [pscustomobject]@{ Report = $report; State = $state }
}

Test-Case 'Windows interval/timeout units are converted, not assumed' {
    $sample = ConvertTo-XrpLinkSample ([pscustomobject]@{ ConnectionInterval = 48; ConnectionLatency = 2; LinkTimeout = 200 }) Connected before ''
    Assert-Equal $sample.interval_ms 60 'Interval'
    Assert-Equal $sample.supervision_timeout_ms 2000 'Timeout'
    Assert-Equal $sample.peripheral_latency_events 2 'Latency events'
}
Test-Case 'Disconnected and zero/invalid intervals are unknown, never 0 ms' {
    foreach ($units in @(0, 5, 3201)) {
        $parameters = [pscustomobject]@{ ConnectionInterval = $units; ConnectionLatency = 0; LinkTimeout = 200 }
        Assert-Equal (ConvertTo-XrpLinkSample $parameters Connected before '').interval_ms $null 'Invalid interval'
    }
    Assert-Equal (ConvertTo-XrpLinkSample $null Disconnected before '').interval_ms $null 'Disconnected'
}
Test-Case 'Stable lower interval is observed and the lease is closed exactly once' {
    $result = Invoke-FakeTrial
    Assert-Equal $result.Report.summary.outcome interval_reduction_observed 'Outcome'
    Assert-Equal $result.Report.summary.minimum_during_interval_ms 15 'Actual minimum'
    Assert-Equal $result.State.closed 1 'Close count'
    Assert-Equal $result.Report.request_released $true 'Released'
    Assert-Equal $result.Report.summary.baseline_observed_again_after_release $true 'Restored observation'
    Assert-Equal $result.Report.samples.Count 7 'All observations kept'
}
Test-Case 'Accepted request with unchanged interval is not a successful optimization' {
    $result = Invoke-FakeTrial -During @(60, 60, 60)
    Assert-Equal $result.Report.summary.outcome no_interval_reduction_observed 'Outcome'
}
Test-Case 'Three-minute RTT window keeps observing the lease and releases it once' {
    $result = Invoke-FakeTrial -HoldSeconds 180
    Assert-Equal $result.State.during 180 'Full observation window'
    Assert-Equal $result.State.created 1 'Only one request'
    Assert-Equal $result.State.closed 1 'Close count'
    Assert-Equal $result.Report.samples.Count 184 'Baseline, window and recovery retained'
    Assert-Equal $result.Report.summary.outcome interval_reduction_observed 'Observed interval, not a measured RTT'
    Assert-Equal $result.Report.summary.baseline_observed_again_after_release $true 'Recovery observed'
}
Test-Case 'One transient lower observation is not reported as sustained' {
    $result = Invoke-FakeTrial -During @(15, 60, 60)
    Assert-Equal $result.Report.summary.outcome transient_interval_reduction_observed 'Outcome'
}
Test-Case 'Unstable baseline prevents creating a request' {
    $result = Invoke-FakeTrial -Before @(60, 30, 60)
    Assert-Equal $result.State.created 0 'Create count'
    Assert-Equal $result.Report.summary.outcome trial_incomplete 'Outcome'
}
Test-Case 'Missing baseline prevents creating a request' {
    $result = Invoke-FakeTrial -Before @(0, 0, 0)
    Assert-Equal $result.State.created 0 'Create count'
}
Test-Case 'AccessDenied is recorded as rejected and its request is still released' {
    $result = Invoke-FakeTrial -Status AccessDenied
    Assert-Equal $result.Report.summary.outcome request_rejected 'Outcome'
    Assert-Equal $result.State.closed 1 'Close count'
}
Test-Case 'DeviceNotAvailable is rejected without polling the link under a failed request' {
    $result = Invoke-FakeTrial -Status DeviceNotAvailable
    Assert-Equal $result.Report.summary.outcome request_rejected 'Outcome'
    Assert-Equal $result.State.during 0 'During count'
    Assert-Equal $result.State.closed 1 'Close count'
}
Test-Case 'Unspecified request status does not confirm success even with lower intervals' {
    $result = Invoke-FakeTrial -Status Unspecified
    Assert-Equal $result.Report.summary.outcome request_not_confirmed 'Outcome'
}
Test-Case 'Disconnect during observation stops and releases the request' {
    $result = Invoke-FakeTrial -During @(-1, 15, 15)
    Assert-Equal $result.Report.summary.outcome trial_incomplete 'Outcome'
    Assert-Equal $result.State.during 1 'Stops on disconnect'
    Assert-Equal $result.State.closed 1 'Close count'
}
Test-Case 'Read failure releases the request' {
    $result = Invoke-FakeTrial -ThrowRead
    Assert-Equal $result.State.closed 1 'Close count'
    Assert-Equal $result.Report.summary.outcome trial_incomplete 'Outcome'
}
Test-Case 'Failed request creation does not attempt to close a nonexistent lease' {
    $result = Invoke-FakeTrial -ThrowCreate
    Assert-Equal $result.State.closed 0 'Close count'
    Assert-Equal $result.Report.request_created $false 'Not created'
}
Test-Case 'Close failure is explicit, not falsely reported as released' {
    $result = Invoke-FakeTrial -ThrowClose
    Assert-Equal $result.Report.request_released $false 'Not released'
    Assert-Equal $result.State.after 0 'No misleading recovery observation'
    Assert-Equal $result.Report.release_error 'Simulated close failure' 'Error retained'
}
Test-Case 'Recovery failure cannot undo the completed lease release' {
    $result = Invoke-FakeTrial -ThrowAfter
    Assert-Equal $result.Report.request_released $true 'Released first'
    Assert-Equal $result.Report.recovery_error 'Simulated recovery failure' 'Error retained'
}
Test-Case 'Release does not assert a return to the baseline if it was not observed' {
    $result = Invoke-FakeTrial -After @(15)
    Assert-Equal $result.Report.summary.baseline_observed_again_after_release $false 'Actual post-release result'
}
Test-Case 'JSON retains null unknown intervals and serializes every observation' {
    $result = Invoke-FakeTrial -During @(-1)
    $roundTrip = $result.Report | ConvertTo-Json -Depth 8 | ConvertFrom-Json
    Assert-Equal $roundTrip.samples.Count $result.Report.samples.Count 'Sample count'
    Assert-Equal $roundTrip.samples[3].interval_ms $null 'Unknown remains null'
}
Write-Host "All $script:tests tests passed. No Bluetooth device was accessed."
