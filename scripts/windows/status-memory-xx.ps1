param(
  [string]$ProjectRoot = "<windows-drive>\memory-xx",
  [string]$WslProjectRoot = "<project-root>"
)

$ErrorActionPreference = "Stop"

function Test-HttpOk([string]$Url) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

$wslAvailable = $false
try {
  wsl.exe test -d $WslProjectRoot | Out-Null
  $wslAvailable = $LASTEXITCODE -eq 0
} catch {
  $wslAvailable = $false
}

$status = [ordered]@{
  ok = $true
  checked_at = (Get-Date).ToString("o")
  windows_native_project_exists = (Test-Path $ProjectRoot)
  wsl_project_exists = $wslAvailable
  wrapper_http_ok = (Test-HttpOk "http://127.0.0.1:5100/health")
  control_panel_http_ok = (Test-HttpOk "http://127.0.0.1:5310/")
  embedding_upstream_ok = (Test-HttpOk "http://127.0.0.1:8082/v3/models")
  reranker_upstream_ok = (Test-HttpOk "http://127.0.0.1:8084/v3/models")
}

$status.ok = $status.wsl_project_exists -or $status.windows_native_project_exists
$status | ConvertTo-Json -Depth 5
if (-not $status.ok) { exit 2 }
