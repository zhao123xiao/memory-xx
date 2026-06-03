param(
  [string]$OvmsDir = "<windows-drive>\ovms",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Start-BatIfPresent([string]$Name) {
  $path = Join-Path $OvmsDir $Name
  if (-not (Test-Path $path)) {
    Write-Host "缺少 $path"
    return $false
  }
  if ($DryRun) {
    Write-Host "[dry-run] 将启动 $path"
    return $true
  }
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $path -WorkingDirectory $OvmsDir -WindowStyle Minimized
  Write-Host "已启动 $path"
  return $true
}

$embedding = Start-BatIfPresent "run-embedding.bat"
$reranker = Start-BatIfPresent "run-reranker.bat"

@{
  ok = ($embedding -and $reranker)
  ovms_dir = $OvmsDir
  dry_run = [bool]$DryRun
  embedding_started = $embedding
  reranker_started = $reranker
} | ConvertTo-Json -Depth 5
