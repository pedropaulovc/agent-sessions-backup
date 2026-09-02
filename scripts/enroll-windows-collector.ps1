<#
.SYNOPSIS
Re-enroll a Windows collector onto a new hub host after an mTLS zone move.

.DESCRIPTION
Cloudflare client certificates are ZONE-scoped. When `vza.net` left the account
on 2026-09-01 the certs enrolled in that zone stopped being able to authenticate
anywhere - so both Windows collectors are already down, and their config.toml
still points at the retired `api.sessions.vza.net`. This script fixes both halves
in one pass: it imports the replacement PFX into the Windows certificate store
and rewrites the collector config to the new hub host.

Schannel cannot use file-based client certs, which is the entire reason this must
run ON the box rather than from the migration host: the private key has to land
in `Cert:\CurrentUser\My`, non-exportable, and only a local import does that.

The D1 side is ALREADY DONE (applied 2026-09-02T00:32Z). The hub holds the new
SHA-256 fingerprint in each machine's CURRENT cert slot, with the superseded one
in the prev slot:

    amet-windows           cur=f7fe20e8244d8769  admin=1
    vm-solidworks-windows  cur=7e13bcb9fbf2656c  admin=0

`is_admin` survives only while the new cert occupies the CURRENT slot, which is
why doctor is run with -RequireCurrentCert: landing in the `prev` slot would
authenticate but silently drop admin.

.PARAMETER MachineId
Which collector this is. Inferred from the PFX files next to the script when
there is exactly one candidate; must be given explicitly otherwise, because
enrolling under the wrong machine_id authenticates and then fails every upload
with machine_mismatch.

.PARAMETER HubUrl
Hub API base. Read from hub/wrangler.jsonc when this script is run from a repo
checkout - config is the source of truth, and a hostname restated as a literal
is how the last outage happened. Falls back to the known production host when
the repo is not present (the usual case: PFX + script copied to a bare box).

.PARAMETER KeepPfx
Keep the source PFX after a successful enrollment. Off by default: the bundle
carries an exportable private key, and once it is in the store non-exportably
the file is pure liability.

.EXAMPLE
.\enroll-windows-collector.ps1
Infers the machine from the single PFX present, enrolls, verifies, shreds the PFX.

.EXAMPLE
.\enroll-windows-collector.ps1 -MachineId vm-solidworks-windows -KeepPfx
#>
[CmdletBinding()]
param(
    [ValidateSet('amet-windows', 'vm-solidworks-windows')]
    [string]$MachineId,

    [string]$PfxPath,

    [string]$HubUrl,

    [switch]$KeepPfx
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-NativeSuccess {
    param([string]$Operation)

    if ($LASTEXITCODE -ne 0) {
        throw "$Operation failed with exit code $LASTEXITCODE."
    }
}

# $IsWindows does NOT exist in Windows PowerShell 5.1 - the default shell on both
# collector boxes - so under Set-StrictMode it raises VariableIsUndefined and this
# guard would abort the script it is meant to protect. Verified against a real
# 5.1.26100.9168: `if (-not $IsWindows)` throws there. OSVersion.Platform is
# present in both editions.
if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw 'This script imports into the Windows certificate store and is Windows-only.'
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---------------------------------------------------------------------------
# Resolve which machine we are. Guessing from $env:COMPUTERNAME would be wrong:
# the machine_id is a hub-side registration key, not a hostname, and the two do
# not have to match. The PFX bundles are named for their machine_id, so the files
# present on the box are the authoritative hint.
# ---------------------------------------------------------------------------
if (-not $MachineId) {
    $candidates = @(
        Get-ChildItem -Path $scriptDir, (Get-Location).Path -Filter '*.pedrovc.pfx' -ErrorAction SilentlyContinue |
            ForEach-Object { $_.Name -replace '\.pedrovc\.pfx$', '' } |
            Sort-Object -Unique
    )

    if ($candidates.Count -eq 1) {
        $MachineId = $candidates[0]
        Write-Host "   inferred machine id from PFX: $MachineId"
    }
    elseif ($candidates.Count -eq 0) {
        throw "No *.pedrovc.pfx found in '$scriptDir' or '$(Get-Location)'. Copy the bundle over, or pass -MachineId and -PfxPath."
    }
    else {
        throw "Multiple PFX bundles present ($($candidates -join ', ')). Pass -MachineId to say which box this is."
    }
}

if (-not $PfxPath) {
    $PfxPath = @(
        Join-Path $scriptDir "$MachineId.pedrovc.pfx"
        Join-Path (Get-Location).Path "$MachineId.pedrovc.pfx"
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

if (-not $PfxPath -or -not (Test-Path -LiteralPath $PfxPath)) {
    throw "PFX not found for '$MachineId'. Pass -PfxPath explicitly."
}
$PfxPath = (Resolve-Path -LiteralPath $PfxPath).Path

# The password ships beside the PFX. .Trim() is REQUIRED, not defensive: both
# files end in a newline (25 bytes incl. \n) and config.py:430 uses the env value
# verbatim, so an untrimmed read fails the import with a bad-password error that
# looks like a corrupt bundle.
$pwPath = "$PfxPath.password"
if (-not (Test-Path -LiteralPath $pwPath)) {
    throw "Password file not found: $pwPath (it ships alongside the PFX)."
}
$pfxPassword = (Get-Content -LiteralPath $pwPath -Raw).Trim()
if (-not $pfxPassword) {
    throw "Password file is empty: $pwPath"
}

# ---------------------------------------------------------------------------
# Hub host: prefer the repo's own config over any literal in this file.
# ---------------------------------------------------------------------------
if (-not $HubUrl) {
    $wranglerPath = Join-Path (Split-Path -Parent $scriptDir) 'hub\wrangler.jsonc'
    if (Test-Path -LiteralPath $wranglerPath) {
        # Strip JSONC comments without eating the // inside "https://": the
        # alternation matches a whole double-quoted string FIRST, so a comment
        # marker living inside a string value is consumed as part of that string
        # and handed back unchanged. Only genuine comments - line or block,
        # anywhere on the line, not just at the start - are removed.
        $raw = Get-Content -LiteralPath $wranglerPath -Raw
        $jsonc = [regex]::Replace(
            $raw,
            '("(?:\\.|[^"\\])*")|/\*[\s\S]*?\*/|//[^\r\n]*',
            { param($m) if ($m.Groups[1].Success) { $m.Groups[1].Value } else { '' } }
        )
        $apiHost = ($jsonc | ConvertFrom-Json).vars.API_HOST
        if ($apiHost) {
            $HubUrl = "https://$apiHost"
            Write-Host "   hub read from hub/wrangler.jsonc: $HubUrl"
        }
    }
}
if (-not $HubUrl) {
    $HubUrl = 'https://api.sessions.pedrovc.com.br'
    Write-Host "   repo not present; using known production hub: $HubUrl"
}

$collector = Join-Path $env:USERPROFILE '.local\bin\agent-collector.exe'
if (-not (Test-Path -LiteralPath $collector)) {
    throw "Collector not installed at '$collector'. Run scripts\setup-windows-collector.ps1 first."
}

Write-Host ''
Write-Host '== plan'
Write-Host "   machine id : $MachineId"
Write-Host "   pfx        : $PfxPath"
Write-Host "   hub        : $HubUrl"
Write-Host "   keep pfx   : $KeepPfx"
Write-Host ''

# ---------------------------------------------------------------------------
# `enroll --import-pfx` DELETES the PFX it is handed on success (config.py:503).
# That is good hygiene but bad for retries, so hand it a temp copy and keep the
# original until doctor has actually passed. Failure then leaves the bundle
# intact and the script re-runnable; success shreds it below.
# ---------------------------------------------------------------------------
$tempPfx = Join-Path ([System.IO.Path]::GetTempPath()) ("{0}.{1}.pfx" -f $MachineId, [guid]::NewGuid())

try {
    # Inside try: a failed copy still hits finally, so a partial PFX in TEMP is
    # cleaned up rather than left holding an exportable key.
    Copy-Item -LiteralPath $PfxPath -Destination $tempPfx -Force

    # AC_PFX_PW must be PLAINTEXT: config.py:407 runs ConvertTo-SecureString
    # -AsPlainText on it. Using the env var rather than --pfx-password keeps the
    # secret out of the process table, where any other user could read it.
    $env:AC_PFX_PW = $pfxPassword

    Write-Host '== importing PFX and writing collector config'
    & $collector enroll --hub $HubUrl --import-pfx $tempPfx --machine-id $MachineId
    Assert-NativeSuccess 'agent-collector enroll'
}
finally {
    Remove-Item Env:\AC_PFX_PW -ErrorAction SilentlyContinue
    # The CLI removes this on success; clean it up on every other path too. This
    # covers exceptions and normal failure - it cannot cover forced termination,
    # reboot, or power loss, so TEMP is still worth checking after a hard crash.
    Remove-Item -LiteralPath $tempPfx -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host '== verifying (cert must land in the CURRENT slot to keep is_admin)'
& $collector doctor --require-current-cert
Assert-NativeSuccess 'agent-collector doctor'

if (-not $KeepPfx) {
    Write-Host ''
    Write-Host '== removing the source PFX (private key now non-exportable in the store)'
    Remove-Item -LiteralPath $PfxPath -Force
    Remove-Item -LiteralPath $pwPath -Force
    Write-Host "   removed $PfxPath and its .password"
}

Write-Host ''
Write-Host "Done. $MachineId is enrolled against $HubUrl."
Write-Host 'Next collector run will upload on its existing schedule; force one with:'
Write-Host "   & `"$collector`" run --heartbeat-only"
