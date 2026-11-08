Set-StrictMode -Version Latest

function ConvertTo-XrpLinkSample {
    param($Parameters, [string]$ConnectionStatus, [string]$Phase, [string]$RequestStatus)

    $connected = $ConnectionStatus -eq 'Connected'
    $valid = $connected -and $null -ne $Parameters -and
        $Parameters.ConnectionInterval -ge 6 -and $Parameters.ConnectionInterval -le 3200
    [pscustomobject]@{
        timestamp_utc = [DateTime]::UtcNow.ToString('o')
        phase = $Phase
        connected = $connected
        interval_ms = $(if ($valid) { [double]$Parameters.ConnectionInterval * 1.25 } else { $null })
        peripheral_latency_events = $(if ($valid) { [int]$Parameters.ConnectionLatency } else { $null })
        supervision_timeout_ms = $(if ($valid) { [int]$Parameters.LinkTimeout * 10 } else { $null })
        request_status = $RequestStatus
    }
}

function Get-XrpIntervalSummary {
    param([object[]]$Samples)

    $baseline = @($Samples | Where-Object { $_.phase -eq 'before' -and $null -ne $_.interval_ms })
    $during = @($Samples | Where-Object { $_.phase -eq 'during' -and $null -ne $_.interval_ms })
    $after = @($Samples | Where-Object { $_.phase -eq 'after' -and $null -ne $_.interval_ms })
    $baselineValues = @($baseline | Select-Object -ExpandProperty interval_ms -Unique)
    $baselineMs = $null
    if ($baseline.Count -ge 3 -and $baselineValues.Count -eq 1) { $baselineMs = $baselineValues[0] }
    $run = 0
    $longestRun = 0
    foreach ($sample in $Samples) {
        if ($sample.phase -ne 'during') { continue }
        if ($null -ne $baselineMs -and $null -ne $sample.interval_ms -and $sample.interval_ms -lt $baselineMs) {
            $run++
            $longestRun = [Math]::Max($run, $longestRun)
        } else { $run = 0 }
    }
    $minimum = $null
    if ($during.Count -gt 0) { $minimum = ($during | Measure-Object interval_ms -Minimum).Minimum }
    $outcome = 'baseline_unknown_or_unstable'
    if ($null -ne $baselineMs) {
        $outcome = 'no_interval_reduction_observed'
        if ($null -ne $minimum -and $minimum -lt $baselineMs) { $outcome = 'transient_interval_reduction_observed' }
        if ($longestRun -ge 3) { $outcome = 'interval_reduction_observed' }
    }
    [pscustomobject]@{
        outcome = $outcome
        baseline_interval_ms = $baselineMs
        minimum_during_interval_ms = $minimum
        last_during_interval_ms = $(if ($during.Count) { $during[-1].interval_ms } else { $null })
        consecutive_lower_observations = $longestRun
        last_after_interval_ms = $(if ($after.Count) { $after[-1].interval_ms } else { $null })
        baseline_observed_again_after_release = $(if ($after.Count -and $null -ne $baselineMs) {
            $after[-1].interval_ms -eq $baselineMs
        } else { $null })
    }
}

function Invoke-XrpIntervalTrial {
    param(
        [Parameter(Mandatory)]$Report,
        [Parameter(Mandatory)][scriptblock]$ReadLink,
        [Parameter(Mandatory)][scriptblock]$CreateRequest,
        [Parameter(Mandatory)][scriptblock]$CloseRequest,
        [Parameter(Mandatory)][scriptblock]$ReadRequestStatus,
        [scriptblock]$Sleep = { Start-Sleep -Milliseconds 1000 },
        [scriptblock]$OnSample = { param($Sample) },
        [ValidateRange(3, 300)][int]$HoldSeconds = 30,
        [ValidateRange(1, 30)][int]$RecoverySeconds = 10
    )

    $request = $null
    try {
        foreach ($index in 1..3) {
            $sample = & $ReadLink 'before' $null
            $Report.samples.Add($sample)
            & $OnSample $sample
            if (-not $sample.connected -or $null -eq $sample.interval_ms) {
                throw 'No valid connected baseline. No profile was requested; reconnect in the IDE first.'
            }
            & $Sleep
        }
        $summary = Get-XrpIntervalSummary $Report.samples.ToArray()
        if ($null -eq $summary.baseline_interval_ms) {
            throw 'Baseline changed during observation. No profile was requested; retry once the link is stable.'
        }
        $request = & $CreateRequest
        if ($null -eq $request) { throw 'Windows returned no request object.' }
        $Report.request_created = $true
        for ($index = 0; $index -lt $HoldSeconds; $index++) {
            $status = [string](& $ReadRequestStatus $request)
            $Report.request_status = $status
            if ($status -in @('AccessDenied', 'DeviceNotAvailable')) {
                throw "Windows rejected the request: $status. No improvement is confirmed."
            }
            $sample = & $ReadLink 'during' $status
            $Report.samples.Add($sample)
            & $OnSample $sample
            if (-not $sample.connected) { throw 'Bluetooth disconnected; the temporary request is being released.' }
            & $Sleep
        }
    } catch {
        $Report.error = $_.Exception.Message
    } finally {
        if ($null -ne $request) {
            try {
                & $CloseRequest $request
                $Report.request_released = $true
            } catch {
                $Report.release_error = $_.Exception.Message
            }
        }
    }
    if ($Report.request_released) {
        try {
            for ($index = 0; $index -lt $RecoverySeconds; $index++) {
                $sample = & $ReadLink 'after' $null
                $Report.samples.Add($sample)
                & $OnSample $sample
                if (-not $sample.connected) { break }
                & $Sleep
            }
        } catch { $Report.recovery_error = $_.Exception.Message }
    }
    $Report.summary = Get-XrpIntervalSummary $Report.samples.ToArray()
    if ($Report.request_status -in @('AccessDenied', 'DeviceNotAvailable')) {
        $Report.summary.outcome = 'request_rejected'
    } elseif ($null -ne $Report.error) {
        $Report.summary.outcome = 'trial_incomplete'
    } elseif ($Report.request_status -ne 'Success') {
        $Report.summary.outcome = 'request_not_confirmed'
    }
}

function New-XrpIntervalReport {
    [pscustomobject]@{
        report_version = 2
        started_utc = [DateTime]::UtcNow.ToString('o')
        finished_utc = $null
        device_name = $null
        selection_name_kind = $null
        operator_confirmed_xrp = $false
        hardware_identity_verified = $false
        windows_version = $null
        requested_profile = 'ThroughputOptimized'
        requested_min_interval_ms = $null
        requested_max_interval_ms = $null
        requested_peripheral_latency_events = $null
        request_created = $false
        request_status = $null
        request_released = $false
        device_reference_released = $false
        observation_reference_released = $false
        samples = [System.Collections.Generic.List[object]]::new()
        summary = $null
        error = $null
        release_error = $null
        recovery_error = $null
        device_release_error = $null
    }
}
