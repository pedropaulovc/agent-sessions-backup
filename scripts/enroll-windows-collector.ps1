<#
.SYNOPSIS
Enroll a collector from a repository checkout on native Windows.
.DESCRIPTION
Requires uv on PATH and a complete checkout containing infra\cf\enroll-cert.py and
collector\pyproject.toml. Delegates enrollment to the Python script, which installs
or upgrades the collector when needed, imports the certificate, verifies hub access,
sends a heartbeat, and installs the 15-minute scheduled task. It does not perform
an initial full upload unless -NoSchedule is specified.

Set CLOUDFLARE_API_TOKEN to a short-lived token with Zone SSL and Certificates Edit
and Account D1 Edit permissions (see infra/cf/mtls.md). -InstallStaged requires no
token, but the staged certificate must already be registered by a hub administrator.
Run as the Windows user who will own the collector and its certificate store.
.PARAMETER MachineId
Override the collector-derived machine id (--machine-id).
.PARAMETER Out
Certificate working directory (--out); defaults to ~/.config/agent-collector.
.PARAMETER Admin
Enroll this machine as a hub admin (--admin).
.PARAMETER NoSchedule
Run one full collector pass instead of a heartbeat and do not install a schedule
(--no-schedule).
.PARAMETER InstallStaged
Install an already-registered staged certificate without Cloudflare management
calls (--install-staged). This is recovery, not fresh enrollment.
.EXAMPLE
$env:CLOUDFLARE_API_TOKEN = '<short-lived token>'
.\scripts\enroll-windows-collector.ps1
Remove-Item Env:CLOUDFLARE_API_TOKEN
.EXAMPLE
.\scripts\enroll-windows-collector.ps1 -MachineId workstation-windows -Out 'C:\cert material' -NoSchedule
.EXAMPLE
.\scripts\enroll-windows-collector.ps1 -MachineId workstation-windows -Out 'C:\cert material' -InstallStaged
#>
[CmdletBinding()]
param(
    [ValidateNotNullOrEmpty()]
    [string]$MachineId,
    [ValidateNotNullOrEmpty()]
    [string]$Out,
    [switch]$Admin,
    [switch]$NoSchedule,
    [switch]$InstallStaged
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Preserve uv's exit code even when the caller enables PowerShell 7 native errors.
$PSNativeCommandUseErrorActionPreference = $false
if ($env:OS -ne 'Windows_NT') {
    throw 'Run this wrapper in native Windows PowerShell, not WSL. On POSIX, use uv run infra/cf/enroll-cert.py.'
}
Get-Command uv -CommandType Application -ErrorAction Stop | Out-Null
$repo = Split-Path -Parent $PSScriptRoot
$enroller = Join-Path $repo 'infra\cf\enroll-cert.py'
$collectorProject = Join-Path $repo 'collector\pyproject.toml'
if (-not (Test-Path -LiteralPath $enroller -PathType Leaf) -or
    -not (Test-Path -LiteralPath $collectorProject -PathType Leaf)) {
    throw 'A complete repository checkout is required, including infra\cf\enroll-cert.py and collector\pyproject.toml.'
}

$enrollArgs = @('run', $enroller)
if ($PSBoundParameters.ContainsKey('MachineId')) { $enrollArgs += @('--machine-id', $MachineId) }
if ($PSBoundParameters.ContainsKey('Out')) { $enrollArgs += @('--out', $Out) }
if ($Admin) { $enrollArgs += '--admin' }
if ($NoSchedule) { $enrollArgs += '--no-schedule' }
if ($InstallStaged) { $enrollArgs += '--install-staged' }

& uv @enrollArgs
exit $LASTEXITCODE
