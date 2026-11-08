Set-StrictMode -Version Latest

function Get-XrpBleNameKind {
    param([AllowNull()][string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) { return 'unsupported' }
    $trimmed = $Name.Trim()
    if ($trimmed -match '^XRP(?:[-_\s]|$)') { return 'xrp_name' }
    if ([string]::Equals($trimmed, 'MPY BTSTACK', [StringComparison]::OrdinalIgnoreCase)) {
        return 'generic_micropython'
    }
    return 'unsupported'
}

function Get-XrpBleCandidates {
    param([AllowEmptyCollection()][object[]]$Devices)
    $seen = @{}
    foreach ($entry in $Devices) {
        if ($null -eq $entry) { continue }
        $kind = Get-XrpBleNameKind $entry.Name
        if ($kind -eq 'unsupported' -or [string]::IsNullOrWhiteSpace($entry.Id)) { continue }
        if ($seen.ContainsKey($entry.Id)) { continue }
        $seen[$entry.Id] = $true
        [pscustomobject]@{ Name = $entry.Name.Trim(); Id = $entry.Id; NameKind = $kind }
    }
}

function Get-XrpProbeConfirmationToken {
    param([string]$NameKind)
    switch ($NameKind) {
        'xrp_name' { return 'YES' }
        'generic_micropython' { return 'YES XRP' }
        default { throw 'Device name is not eligible for this experiment.' }
    }
}
