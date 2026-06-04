param(
  [string]$WslProjectRoot = "<project-root>",
  [int]$ControlPanelPort = 5310,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

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

Write-Host "未找到可用 WSL memory-xx。Windows native profile 请先配置 ProjectRoot、PostgreSQL、Redis、Qdrant 和 Node 运行环境。"
@{ ok = $false; mode = "unavailable"; remediation = "安装/启动 WSL，或按 deployment bundle 配置 windows-native profile。" } | ConvertTo-Json -Depth 5
exit 2
