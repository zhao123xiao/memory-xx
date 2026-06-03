param(
  [string]$WslProjectRoot = "<project-root>",
  [switch]$StopOvms
)

$ErrorActionPreference = "Continue"

wsl.exe bash -lc "pkill -f 'scripts/memory-control-panel.ts' || true; cd '$WslProjectRoot' && TMPDIR=/tmp npm run memory:platform-doctor -- --profile=wsl-windows-gpu --json || true" | Out-Null

if ($StopOvms) {
  $stopAll = "<windows-drive>\ovms\stop_all.bat"
  if (Test-Path $stopAll) {
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $stopAll -WorkingDirectory "<windows-drive>\ovms" -Wait
  }
}

@{
  ok = $true
  stopped_control_panel = $true
  stopped_ovms = [bool]$StopOvms
} | ConvertTo-Json -Depth 5
