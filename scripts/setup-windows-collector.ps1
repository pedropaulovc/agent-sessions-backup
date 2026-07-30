[CmdletBinding()]
param(
    [ValidateRange(1, 1440)]
    [int]$IntervalMinutes = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$taskName = 'agent-collector'
$collector = Join-Path $env:USERPROFILE '.local\bin\agent-collector.exe'
$ref = 'git+https://github.com/pedropaulovc/agent-sessions-backup.git@main#subdirectory=collector'

function Assert-NativeSuccess {
    param([string]$Operation)

    if ($LASTEXITCODE -ne 0) {
        throw "$Operation failed with exit code $LASTEXITCODE."
    }
}

Get-Command uv -ErrorAction Stop | Out-Null

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
while ($null -ne $task -and $task.State -eq 'Running') {
    Write-Verbose "Waiting for the active $taskName run to finish."
    Start-Sleep -Seconds 2
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}

Write-Verbose 'Installing the collector from main.'
& uv tool install --force --reinstall --no-cache $ref
Assert-NativeSuccess 'Collector installation'

Write-Verbose 'Registering the scheduled collector task.'
& $collector install --interval $IntervalMinutes
Assert-NativeSuccess 'Scheduled-task registration'

Write-Verbose 'Sending an immediate heartbeat.'
& $collector run --heartbeat-only
Assert-NativeSuccess 'Immediate heartbeat'
