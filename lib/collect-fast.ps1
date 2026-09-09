# Fast-cycle collector: disks, top processes, network counters, disk I/O, CPU clock.
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

$all = Get-Process

$procs = @($all | Sort-Object WorkingSet64 -Descending | Select-Object -First 14 | ForEach-Object {
  [pscustomobject]@{
    name = [string]$_.ProcessName
    pid  = [int]$_.Id
    mem  = [int64]$_.WorkingSet64
    cpu  = [math]::Round([double]$_.CPU, 1)
  }
})

# Total CPU seconds is cumulative, not a live percentage, but it still ranks the
# processes that have burned the most CPU since they started.
$procsCpu = @($all | Where-Object { $_.CPU -gt 0 } | Sort-Object CPU -Descending | Select-Object -First 10 | ForEach-Object {
  [pscustomobject]@{
    name = [string]$_.ProcessName
    pid  = [int]$_.Id
    cpu  = [math]::Round([double]$_.CPU, 1)
    mem  = [int64]$_.WorkingSet64
  }
})

$net = @(Get-NetAdapterStatistics | ForEach-Object {
  [pscustomobject]@{
    name = [string]$_.Name
    rx   = [int64]$_.ReceivedBytes
    tx   = [int64]$_.SentBytes
  }
})

$io = Get-CimInstance Win32_PerfFormattedData_PerfDisk_LogicalDisk -Filter "Name='_Total'"
$diskIo = if ($io) {
  [pscustomobject]@{ readRate = [int64]$io.DiskReadBytesPersec; writeRate = [int64]$io.DiskWriteBytesPersec }
} else { $null }

$cpuInfo = Get-CimInstance Win32_Processor | Select-Object -First 1
$cpuMhz = if ($cpuInfo) { [double]$cpuInfo.CurrentClockSpeed } else { $null }

# Most consumer boards do not expose this WMI class; null simply hides the reading.
$tz = Get-CimInstance -Namespace root/WMI -ClassName MSAcpi_ThermalZoneTemperature | Select-Object -First 1
$cpuTemp = if ($tz -and $tz.CurrentTemperature) { [math]::Round(($tz.CurrentTemperature / 10) - 273.15, 1) } else { $null }

[pscustomobject]@{
  disks    = $disks
  procs    = $procs
  procsCpu = $procsCpu
  net      = $net
  diskIo   = $diskIo
  cpuMhz   = $cpuMhz
  cpuTemp  = $cpuTemp
} | ConvertTo-Json -Depth 4 -Compress
