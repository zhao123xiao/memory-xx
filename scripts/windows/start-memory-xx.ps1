param(
  [string]$WslProjectRoot = $env:MEMORY_XX_WSL_PROJECT_ROOT,
  [int]$ControlPanelPort = 5310,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($WslProjectRoot)) {
  $wslUser = if ($env:MEMORY_XX_WSL_USER) { $env:MEMORY_XX_WSL_USER } else { $env:USERNAME }
  $WslProjectRoot = "/home/$wslUser/services/memory-xx"
}

function Invoke-WslMemoryXX([string]$Command) {
  wsl.exe bash -lc "cd '$WslProjectRoot' && $Command"
  if ($LASTEXITCODE -ne 0) {
    throw "WSL command failed: $Command"
  }
}

try {
  wsl.exe test -d $WslProjectRoot | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Invoke-WslMemoryXX "TMPDIR=/tmp npm run memory:platform-doctor -- --profile=wsl-windows-gpu --json || true"
    $cmd = "cd '$WslProjectRoot' && TMPDIR=/tmp MEMORY_XX_CONTROL_PANEL_PORT=$ControlPanelPort nohup npm run memory:control-panel > .runtime/control-panel-windows-launch.log 2>&1 &"
    wsl.exe bash -lc $cmd | Out-Null
    $url = "http://127.0.0.1:$ControlPanelPort/"
    if (-not $NoBrowser) { Start-Process $url }
    @{ ok = $true; mode = "wsl-windows-gpu"; url = $url } | ConvertTo-Json -Depth 5
    exit 0
  }
} catch {
  Write-Host "WSL 启动失败：$($_.Exception.Message)"
}

Write-Host "未找到可用 WSL memory-xx。请设置 MEMORY_XX_WSL_PROJECT_ROOT，或按 deployment bundle 配置 windows-native profile。"
@{ ok = $false; mode = "unavailable"; wsl_project_root = $WslProjectRoot; remediation = "设置 MEMORY_XX_WSL_PROJECT_ROOT，安装/启动 WSL，或按 deployment bundle 配置 windows-native profile。" } | ConvertTo-Json -Depth 5
exit 2
