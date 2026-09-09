# Fast-cycle collector: disks, top processes, network counters.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  [pscustomobject]@{
    id    = [string]$_.DeviceID
    label = [string]$_.VolumeName
    fs    = [string]$_.FileSystem
    size  = [int64]$_.Size
    free  = [int64]$_.FreeSpace
  }
})

$procs = @(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 14 | ForEach-Object {
  [pscustomobject]@{
    name = [string]$_.ProcessName
    pid  = [int]$_.Id
    mem  = [int64]$_.WorkingSet64
    cpu  = [math]::Round([double]$_.CPU, 1)
  }
})

$net = @(Get-NetAdapterStatistics | ForEach-Object {
  [pscustomobject]@{
    name = [string]$_.Name
    rx   = [int64]$_.ReceivedBytes
    tx   = [int64]$_.SentBytes
  }
})

[pscustomobject]@{ disks = $disks; procs = $procs; net = $net } | ConvertTo-Json -Depth 4 -Compress
