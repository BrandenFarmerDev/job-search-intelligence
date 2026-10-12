Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -eq 'Windows_NT') { Add-Type -AssemblyName System.Security }

function New-PrivateRuntimeContext {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][string]$StateRoot,
    [Parameter(Mandatory=$true)][string]$Environment,
    [Parameter(Mandatory=$true)][string]$MailboxBinding,
    [Parameter(Mandatory=$true)][string]$ConfigVersion,
    [scriptblock]$ProtectBytes,
    [scriptblock]$UnprotectBytes
  )
  $binding = [ordered]@{ root=[IO.Path]::GetFullPath($StateRoot); environment=$Environment; mailbox=$MailboxBinding; config=$ConfigVersion }
  $canonical = ConvertTo-Json -InputObject $binding -Compress
  $entropy = [Security.Cryptography.SHA256]::Create()
  try { $entropyBytes = $entropy.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical)) } finally { $entropy.Dispose() }
  return [pscustomobject]@{ StateRoot=[IO.Path]::GetFullPath($StateRoot); Environment=$Environment; MailboxBinding=$MailboxBinding; ConfigVersion=$ConfigVersion; Entropy=$entropyBytes; ProtectBytes=$ProtectBytes; UnprotectBytes=$UnprotectBytes }
}
$script:PrivateRuntimeMutexFactory=$null
function Set-PrivateRuntimeMutexFactory([scriptblock]$Factory) { $script:PrivateRuntimeMutexFactory=$Factory }
function New-PrivateRuntimeMutex([string]$Name) {
  if($script:PrivateRuntimeMutexFactory){return (& $script:PrivateRuntimeMutexFactory $Name)}
  return [Threading.Mutex]::new($false,$Name)
}

function Set-PrivateAcl([string]$Path, [bool]$Directory) {
  if ($env:OS -ne 'Windows_NT') { return }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $rule = if ($Directory) { '{0}:(OI)(CI)F' -f $identity } else { '{0}:F' -f $identity }
  & "$env:SystemRoot\System32\icacls.exe" $Path '/reset' '/c' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not reset inherited protected state ACLs.' }
  & "$env:SystemRoot\System32\icacls.exe" $Path '/inheritance:r' '/grant:r' $rule '/c' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not restrict protected state ACL to the current Windows user.' }
}
function Assert-NoReparsePath([string]$Path) {
  $full=[IO.Path]::GetFullPath($Path)
  $cursor=[IO.Path]::GetPathRoot($full)
  $relative=$full.Substring($cursor.Length)
  foreach($part in $relative.Split([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)) {
    if (-not $part) { continue }; $cursor=Join-Path $cursor $part
    if (Test-Path -LiteralPath $cursor) { $attributes=[IO.File]::GetAttributes($cursor); if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Protected paths may not traverse reparse points.' } }
  }
}
function Assert-PrivatePath([string]$Path, [object]$Context) {
  $full=[IO.Path]::GetFullPath($Path); $root=[IO.Path]::GetFullPath($Context.StateRoot).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)
  $prefix=$root+[IO.Path]::DirectorySeparatorChar
  if (-not $full.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'Protected state paths must remain inside StateRoot.' }
  Assert-NoReparsePath $full
}
function Protect-PrivateDirectory([string]$Path) {
  $full=[IO.Path]::GetFullPath($Path);Assert-NoReparsePath $full
  [IO.Directory]::CreateDirectory($full) | Out-Null
  Assert-NoReparsePath $full;Set-PrivateAcl $full $true
}

function Protect-PrivateBytes([byte[]]$Bytes, [object]$Context) {
  if ($Context.ProtectBytes) { return ,(& $Context.ProtectBytes $Bytes $Context.Entropy) }
  if ($env:OS -ne 'Windows_NT') { throw 'DPAPI CurrentUser is available only on Windows; inject a protector in synthetic tests.' }
  return ,[Security.Cryptography.ProtectedData]::Protect($Bytes, $Context.Entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
}
function Unprotect-PrivateBytes([byte[]]$Bytes, [object]$Context) {
  if ($Context.UnprotectBytes) { return ,(& $Context.UnprotectBytes $Bytes $Context.Entropy) }
  if ($env:OS -ne 'Windows_NT') { throw 'DPAPI CurrentUser is available only on Windows; inject an unprotector in synthetic tests.' }
  return ,[Security.Cryptography.ProtectedData]::Unprotect($Bytes, $Context.Entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
}

function Save-ProtectedJsonAtomic {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][object]$Value,[Parameter(Mandatory=$true)][object]$Context)
  $full = [IO.Path]::GetFullPath($Path); Assert-PrivatePath $full $Context; $directory = [IO.Path]::GetDirectoryName($full)
  [IO.Directory]::CreateDirectory($directory) | Out-Null; Set-PrivateAcl $directory $true
  $json = ConvertTo-Json -InputObject $Value -Depth 30 -Compress
  $plain = [Text.UTF8Encoding]::new($false).GetBytes($json)
  $protected = Protect-PrivateBytes $plain $Context
  $temporary = Join-Path $directory ('.' + [IO.Path]::GetFileName($full) + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
  $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($protected,0,$protected.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  Set-PrivateAcl $temporary $false
  if ([IO.File]::Exists($full)) { $backup="$temporary.bak"; [IO.File]::Replace($temporary,$full,$backup,$true); if([IO.File]::Exists($backup)){[IO.File]::Delete($backup)} }
  else { [IO.File]::Move($temporary,$full) }
}

function Restore-JsonMarkers([object]$Node,[Collections.Generic.Dictionary[string,string]]$Strings) {
  if($null -eq $Node){return $null}
  if($Node -is [string]){if($Strings.ContainsKey($Node)){return $Strings[$Node]};return $Node}
  if($Node -is [System.Array]){$items=[Collections.Generic.List[object]]::new();foreach($item in $Node){$items.Add((Restore-JsonMarkers $item $Strings))};return ,($items.ToArray())}
  if($Node -is [pscustomobject]){$properties=[ordered]@{};foreach($property in $Node.PSObject.Properties){$key=[string]$property.Name;if($Strings.ContainsKey($key)){$key=$Strings[$key]};$properties[$key]=Restore-JsonMarkers $property.Value $Strings};return [pscustomobject]$properties}
  return $Node
}
function ConvertFrom-JsonPreservingStrings([string]$Json) {
  # Windows PowerShell 5.1 coerces ISO-looking strings into DateTime values.
  # Decode every string token in one JSON array parse, then replace all tokens
  # with neutral markers and parse the full structure once. This keeps exact
  # strings without one ConvertFrom-Json invocation per subject/body field.
  $strings=[Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
  $pattern='"(?:\\.|[^"\\])*"'
  $matches=[regex]::Matches($Json,$pattern)
  $tokens=[Collections.Generic.List[string]]::new()
  foreach($match in $matches){$token=[string]$match.Value;$tokens.Add('"~'+$token.Substring(1,$token.Length-2)+'~"')}
  $tokenArrayJson='['+([string]::Join(',',$tokens.ToArray()))+']'
  $decoded=ConvertFrom-Json -InputObject $tokenArrayJson -ErrorAction Stop
  if($decoded.Count -ne $matches.Count){throw ('protected_state_json_string_decode_failed count expected='+$matches.Count+' actual='+$decoded.Count)}
  $prefix='__JSI_JSON_STRING_'+[Guid]::NewGuid().ToString('N')+'_'
  while($Json.Contains($prefix)){$prefix='__JSI_JSON_STRING_'+[Guid]::NewGuid().ToString('N')+'_'}
  $builder=[Text.StringBuilder]::new($Json.Length)
  $cursor=0
  for($index=0;$index -lt $matches.Count;$index++){
    $match=$matches[$index]
    [void]$builder.Append($Json.Substring($cursor,$match.Index-$cursor))
    $marker=$prefix+$index+'__'
    $value=[string]$decoded[$index]
    if($value.Length -lt 2 -or $value[0] -ne '~' -or $value[$value.Length-1] -ne '~'){throw ('protected_state_json_string_decode_failed token='+$index+' length='+$value.Length)}
    $strings.Add($marker,$value.Substring(1,$value.Length-2))
    [void]$builder.Append('"'+$marker+'"')
    $cursor=$match.Index+$match.Length
  }
  [void]$builder.Append($Json.Substring($cursor))
  $neutral=$builder.ToString()
  $tree=ConvertFrom-Json -InputObject $neutral -ErrorAction Stop
  return (Restore-JsonMarkers $tree $strings)
}

function Read-ProtectedJson {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][object]$Context,[switch]$QuarantineInvalid)
  $full=[IO.Path]::GetFullPath($Path); Assert-PrivatePath $full $Context
  if (-not [IO.File]::Exists($full)) { return $null }
  try {
    $protected=[IO.File]::ReadAllBytes($full); $plain=Unprotect-PrivateBytes $protected $Context
    $json=[Text.UTF8Encoding]::new($false,$true).GetString($plain)
    $convertCommand=Get-Command ConvertFrom-Json -ErrorAction Stop
    if($convertCommand.Parameters.ContainsKey('DateKind')){
      $value=ConvertFrom-Json -InputObject $json -DateKind String -ErrorAction Stop
    } else {
      $value=ConvertFrom-JsonPreservingStrings $json
    }
    if ($null -eq $value -or $null -eq $value.schemaVersion) { throw 'protected_state_schema_invalid' }
    return $value
  } catch {
    if ($QuarantineInvalid) { $stamp=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'); $target="$full.$stamp.quarantine"; [IO.File]::Move($full,$target) }
    throw 'Protected state is unreadable, invalid, or bound to another environment/mailbox/configuration; no plaintext fallback was attempted.'
  }
}
function Save-ProtectedBytesAtomic {
  [CmdletBinding()] param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][byte[]]$Bytes,[Parameter(Mandatory=$true)][object]$Context)
  $full=[IO.Path]::GetFullPath($Path); Assert-PrivatePath $full $Context; $directory=[IO.Path]::GetDirectoryName($full)
  [IO.Directory]::CreateDirectory($directory) | Out-Null; Set-PrivateAcl $directory $true
  $protected=Protect-PrivateBytes $Bytes $Context
  $temporary=Join-Path $directory ('.'+[IO.Path]::GetFileName($full)+'.'+[Guid]::NewGuid().ToString('N')+'.tmp')
  $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $stream.Write($protected,0,$protected.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  Set-PrivateAcl $temporary $false
  if([IO.File]::Exists($full)){$backup="$temporary.bak";[IO.File]::Replace($temporary,$full,$backup,$true);if([IO.File]::Exists($backup)){[IO.File]::Delete($backup)}}else{[IO.File]::Move($temporary,$full)}
}
function Read-ProtectedBytes {
  [CmdletBinding()] param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][object]$Context)
  $full=[IO.Path]::GetFullPath($Path); Assert-PrivatePath $full $Context
  try { return ,(Unprotect-PrivateBytes ([IO.File]::ReadAllBytes($full)) $Context) }
  catch { throw 'Protected bytes are unreadable or bound to another environment/mailbox/configuration.' }
}

function Get-MaintenanceGatePath([string]$StateRoot) { Join-Path $StateRoot 'maintenance-gate.dpapi' }
function New-MaintenanceGateContext([object]$Context) {
  return New-PrivateRuntimeContext -StateRoot $Context.StateRoot -Environment 'job-search-intelligence-maintenance' -MailboxBinding 'shared-upload-cleanup-gate' -ConfigVersion 'maintenance-gate-v1' -ProtectBytes $Context.ProtectBytes -UnprotectBytes $Context.UnprotectBytes
}
function Test-MaintenanceGate {
  [CmdletBinding()] param([Parameter(Mandatory=$true)][object]$Context)
  $gateContext=New-MaintenanceGateContext $Context
  $invalid=Join-Path $Context.StateRoot 'maintenance-gate.invalid'
  if(Test-Path -LiteralPath $invalid){return $true}
  try { $gate=Read-ProtectedJson (Get-MaintenanceGatePath $Context.StateRoot) $gateContext; return ($null -ne $gate -and [bool]$gate.enabled) }
  catch { Assert-NoReparsePath $invalid; [IO.Directory]::CreateDirectory($Context.StateRoot) | Out-Null; Assert-NoReparsePath $invalid; [IO.File]::WriteAllText($invalid,'gate_validation_failed'); Set-PrivateAcl $invalid $false; return $true }
}
function Set-MaintenanceGate {
  [CmdletBinding()] param([Parameter(Mandatory=$true)][object]$Context,[Parameter(Mandatory=$true)][bool]$Enabled,[string]$Reason='maintenance')
  $gateContext=New-MaintenanceGateContext $Context
  Save-ProtectedJsonAtomic (Get-MaintenanceGatePath $Context.StateRoot) ([ordered]@{ schemaVersion=1; enabled=$Enabled; reason=$Reason; changedAt=[DateTime]::UtcNow.ToString('o') }) $gateContext
  if(-not $Enabled){$invalid=Join-Path $Context.StateRoot 'maintenance-gate.invalid';if(Test-Path -LiteralPath $invalid){Remove-Item -LiteralPath $invalid -Force}}
}
function Enter-MaintenanceCoordinator {
  [CmdletBinding()] param([Parameter(Mandatory=$true)][object]$Context,[switch]$RequireGateClear)
  $mutex=New-PrivateRuntimeMutex 'Local\JobSearchIntelligenceOutlookUpload'; $acquired=$false
  try { $acquired=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired=$true }
  $gate=$false
  if ($acquired) { try { $gate=Test-MaintenanceGate $Context } catch { $mutex.ReleaseMutex(); $mutex.Dispose(); throw } }
  $lease=[pscustomobject]@{ Acquired=$acquired; GateEnabled=$gate; Mutex=$mutex; Released=$false }
  $lease | Add-Member ScriptMethod Dispose {
    if (-not $this.Released) { if ($this.Acquired) { try { $this.Mutex.ReleaseMutex() } catch { } }; $this.Mutex.Dispose(); $this.Released=$true }
  }
  if ($RequireGateClear -and $acquired -and $gate) { $lease.Dispose() }
  return $lease
}

Export-ModuleMember -Function New-PrivateRuntimeContext,New-PrivateRuntimeMutex,Set-PrivateRuntimeMutexFactory,New-MaintenanceGateContext,Protect-PrivateDirectory,Save-ProtectedJsonAtomic,Read-ProtectedJson,Save-ProtectedBytesAtomic,Read-ProtectedBytes,Test-MaintenanceGate,Set-MaintenanceGate,Enter-MaintenanceCoordinator
