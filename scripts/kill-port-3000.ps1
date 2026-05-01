$ErrorActionPreference = 'Stop'

$port = 3000

try {
  # Get-NetTCPConnection throws when no matching rows exist on some systems.
  $conns = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  if (-not $conns) {
    exit 0
  }

  $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($portPid in $pids) {
    if (-not $portPid -or $portPid -eq $PID) { continue }
    $proc = Get-Process -Id $portPid -ErrorAction Stop
    if ($proc.ProcessName -ne 'node') {
      Write-Host "Port $port is in use by PID $portPid ($($proc.ProcessName)). Not stopping it."
      exit 1
    }

    Stop-Process -Id $portPid -Force -ErrorAction Stop
    Start-Sleep -Milliseconds 300
    if (Get-Process -Id $portPid -ErrorAction SilentlyContinue) {
      Write-Host "Failed to stop PID $portPid on port $port."
      exit 1
    }
  }

  exit 0
} catch {
  Write-Host "Failed to clear port $port. $($_.Exception.Message)"
  exit 1
}

