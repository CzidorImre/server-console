# Slow-cycle collector: OS identity, services, listening ports, GPUs, sessions, WSL.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$osi = Get-CimInstance Win32_OperatingSystem
$sys = [pscustomobject]@{
  caption = [string]$osi.Caption
  version = [string]$osi.Version
  boot    = if ($osi.LastBootUpTime) { $osi.LastBootUpTime.ToString('o') } else { $null }
}

$services = @(Get-Service | Where-Object { $_.Status -eq 'Running' } | Sort-Object DisplayName | ForEach-Object {
  [pscustomobject]@{ name = [string]$_.Name; display = [string]$_.DisplayName; start = [string]$_.StartType }
})

# Closest Windows analogue to a failed systemd unit. Auto-start + stopped is NOT
# enough: many auto/trigger-start services sit idle by design. A non-zero exit code
# that is not 1077 (ERROR_SERVICE_NEVER_STARTED) means it actually died.
$failed = @(Get-CimInstance Win32_Service -Filter "StartMode='Auto' AND State!='Running' AND ExitCode!=0 AND ExitCode!=1077" | ForEach-Object {
  [pscustomobject]@{
    name    = [string]$_.Name
    display = [string]$_.DisplayName
    detail  = "exit code $($_.ExitCode)"
  }
})

$pn = @{}
Get-Process | ForEach-Object { $pn[[int]$_.Id] = $_.ProcessName }

$ports = @(Get-NetTCPConnection -State Listen | Sort-Object LocalPort -Unique | ForEach-Object {
  [pscustomobject]@{
    port = [int]$_.LocalPort
    addr = [string]$_.LocalAddress
    proc = [string]$pn[[int]$_.OwningProcess]
    pid  = [int]$_.OwningProcess
  }
})

# nvidia-smi gives live load; the WMI adapter list is a name-only fallback. WMI's
# AdapterRAM is a 32-bit field that lies about anything over 4 GB, so it is not used.
$gpus = @()
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
  $raw = & nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>$null
  foreach ($line in @($raw)) {
    if (-not $line) { continue }
    $f = $line -split ',' | ForEach-Object { $_.Trim() }
    $num = { param($v) $out = 0.0; if ([double]::TryParse($v, [ref]$out)) { $out } else { $null } }
    $gpus += [pscustomobject]@{
      name     = [string]$f[0]
      util     = & $num $f[1]
      memUsed  = if ((& $num $f[2]) -ne $null) { [int64]((& $num $f[2]) * 1MB) } else { $null }
      memTotal = if ((& $num $f[3]) -ne $null) { [int64]((& $num $f[3]) * 1MB) } else { $null }
      temp     = & $num $f[4]
      power    = & $num $f[5]
      source   = 'nvidia-smi'
    }
  }
}
if ($gpus.Count -eq 0) {
  $gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object {
    [pscustomobject]@{
      name     = [string]$_.Name
      util     = $null
      memUsed  = $null
      memTotal = $null
      temp     = $null
      power    = $null
      source   = 'wmi'
    }
  })
}

$users = @()
$cs = Get-CimInstance Win32_ComputerSystem
if ($cs -and $cs.UserName) {
  $users += [pscustomobject]@{ user = [string]$cs.UserName; tty = 'console'; since = ''; from = 'local' }
}

$wsl = @()
if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
  $raw = & wsl.exe -l -v 2>$null
  if ($raw) {
    # wsl.exe emits UTF-16; strip nulls, then parse "* Name State Version" rows.
    $wsl = @($raw | ForEach-Object { ($_ -replace "`0", '').Trim() } |
      Where-Object { $_ -and $_ -notmatch '^\*?\s*NAME\s' } |
      ForEach-Object {
        $parts = ($_ -replace '^\*\s*', '') -split '\s+'
        if ($parts.Count -ge 2) {
          [pscustomobject]@{ name = $parts[0]; state = $parts[1] }
        }
      })
  }
}

[pscustomobject]@{
  sys        = $sys
  services   = $services
  failed     = $failed
  ports      = $ports
  gpus       = $gpus
  users      = $users
  wsl        = $wsl
  containers = @()
} | ConvertTo-Json -Depth 4 -Compress
