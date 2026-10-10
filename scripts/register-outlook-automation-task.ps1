[CmdletBinding()]
param(
  [ValidatePattern('^[^@\s]+@[^@\s]+\.[^@\s]+$')]
  [string]$Mailbox,

  [ValidatePattern('^https://[^/\s]+(/\S*)?$')]
  [string]$ApiBase,

  [string]$StateDirectory,

  [switch]$Enable,
  [switch]$Unregister
)

# Registers the per-user Task Scheduler job that runs outlook-automation.ps1. The task is created DISABLED;
# pass -Enable only after live acceptance. Re-running updates the installed copy and keeps an already enabled task enabled.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$taskName = 'JobSearchIntelligence-OutlookUpload'
$stateRoot = if ($StateDirectory) { [IO.Path]::GetFullPath($StateDirectory) } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'JobSearchIntelligence' } else { throw 'No state directory is available.' }
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

if ($Unregister) {
  if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Write-Host "Removed scheduled task $taskName. State, logs and the saved credential in $stateRoot were left in place." }
  else { Write-Host "Scheduled task $taskName is not registered." }
  exit 0
}
if (-not $Mailbox) { throw 'Mailbox is required unless -Unregister is used.' }

# A private copy keeps branch switches in the repository from changing the scheduled job.
$bin = Join-Path $stateRoot 'bin'
[IO.Directory]::CreateDirectory($bin) | Out-Null
foreach ($name in 'outlook-automation.ps1', 'outlook-com-export.ps1') { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $bin $name) -Force }
if (-not (Test-Path -LiteralPath (Join-Path $stateRoot 'automation-credential.xml'))) { Write-Warning "No saved credential yet. Run: powershell -File `"$(Join-Path $bin 'outlook-automation.ps1')`" -SetupCredential -StateDirectory `"$stateRoot`"" }

$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $bin 'outlook-automation.ps1')`" -Mailbox $Mailbox -StateDirectory `"$stateRoot`""
if ($ApiBase) { $arguments += " -ApiBase $ApiBase" }
$user = "$env:USERDOMAIN\$env:USERNAME"
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
$logon.Delay = 'PT10M'
$triggers = @((New-ScheduledTaskTrigger -Daily -At '07:00'), $logon)
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
[void](Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description 'Exports job-search mail from classic Outlook and uploads it to the private Job Search Intelligence API.' -Force)

if ($Enable -or ($existing -and $existing.State -ne 'Disabled')) { [void](Enable-ScheduledTask -TaskName $taskName) } else { [void](Disable-ScheduledTask -TaskName $taskName) }
Write-Host "Scheduled task $taskName is $((Get-ScheduledTask -TaskName $taskName).State). Installed scripts: $bin"
