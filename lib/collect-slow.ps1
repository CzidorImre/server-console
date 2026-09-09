# Slow-cycle collector: OS identity, running services, listening TCP ports, WSL distros.
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

# Map owning PIDs to process names so ports read as "what is listening", not just numbers.
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

[pscustomobject]@{ sys = $sys; services = $services; ports = $ports; wsl = $wsl } | ConvertTo-Json -Depth 4 -Compress
