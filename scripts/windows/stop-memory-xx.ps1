param(
  [string]$WslProjectRoot = $env:MEMORY_XX_WSL_PROJECT_ROOT,
  [string]$OvmsDir = $env:MEMORY_XX_OVMS_DIR,
  [switch]$StopOvms
)

$ErrorActionPreference = "Continue"

if ([string]::IsNullOrWhiteSpace($WslProjectRoot)) {
  $wslUser = if ($env:MEMORY_XX_WSL_USER) { $env:MEMORY_XX_WSL_USER } else { $env:USERNAME }
  $WslProjectRoot = "/home/$wslUser/services/memory-xx"
}

if ([string]::IsNullOrWhiteSpace($OvmsDir)) {
  $OvmsDir = Join-Path $HOME "ovms"
}

wsl.exe bash -lc "pkill -f 'scripts/memory-control-panel.ts' || true; cd '$WslProjectRoot' && TMPDIR=/tmp npm run memory:platform-doctor -- --profile=wsl-windows-gpu --json || true" | Out-Null

if ($StopOvms) {
  $stopAll = Join-Path $OvmsDir "stop_all.bat"
  if (Test-Path $stopAll) {
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $stopAll -WorkingDirectory $OvmsDir -Wait
  }
}

@{
  ok = $true
  stopped_control_panel = $true
  stopped_ovms = [bool]$StopOvms
  wsl_project_root = $WslProjectRoot
  ovms_dir = $OvmsDir
} | ConvertTo-Json -Depth 5
