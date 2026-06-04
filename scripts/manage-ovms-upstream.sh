#!/usr/bin/env bash
set -euo pipefail

kind="${1:-}"
mode="${2:-run}"

OVMS_DIR="${MEMORY_XX_OVMS_DIR:-}"
POLL_SECONDS="${MEMORY_XX_OVMS_MANAGER_POLL_SECONDS:-15}"
READY_TIMEOUT_SECONDS="${MEMORY_XX_OVMS_MANAGER_READY_TIMEOUT_SECONDS:-300}"
UNHEALTHY_THRESHOLD="${MEMORY_XX_OVMS_MANAGER_UNHEALTHY_THRESHOLD:-3}"

CMD_EXE="${MEMORY_XX_WINDOWS_CMD_EXE:-}"
POWERSHELL_EXE="${MEMORY_XX_WINDOWS_POWERSHELL_EXE:-}"

case "$kind" in
  embedding)
    label="embedding upstream"
    port="${MEMORY_XX_EMBEDDING_UPSTREAM_PORT:-8082}"
    bat_path="${MEMORY_XX_EMBEDDING_UPSTREAM_BAT:-}"
    model="${MEMORY_XX_EMBEDDING_UPSTREAM_MODEL:-memory-xx-dev-embedding}"
    api_key_file="${MEMORY_XX_EMBEDDING_UPSTREAM_API_KEY_FILE:-}"
    process_match="--rest_port ${port}"
    ;;
  reranker)
    label="reranker upstream"
    port="${MEMORY_XX_RERANKER_UPSTREAM_PORT:-8084}"
    bat_path="${MEMORY_XX_RERANKER_UPSTREAM_BAT:-}"
    model="${MEMORY_XX_RERANKER_UPSTREAM_MODEL:-memory-xx-reranker}"
    api_key_file=""
    process_match="serve-reranker-8b.py"
    ;;
  *)
    echo "usage: $0 embedding|reranker [run|status|start|stop]" >&2
    exit 64
    ;;
esac

log() {
  printf '[%s] [%s] %s\n' "$(date -Is)" "$kind" "$*"
}

require_ovms_dir() {
  if [[ -z "$OVMS_DIR" ]]; then
    echo "MEMORY_XX_OVMS_DIR is required for Windows OVMS upstream management" >&2
    exit 78
  fi
  if [[ -z "$CMD_EXE" ]]; then
    echo "MEMORY_XX_WINDOWS_CMD_EXE is required for Windows OVMS upstream management" >&2
    exit 78
  fi
  if [[ -z "$POWERSHELL_EXE" ]]; then
    echo "MEMORY_XX_WINDOWS_POWERSHELL_EXE is required for Windows OVMS upstream management" >&2
    exit 78
  fi
  if [[ -z "$bat_path" ]]; then
    echo "MEMORY_XX_${kind^^}_UPSTREAM_BAT is required for Windows OVMS upstream management" >&2
    exit 78
  fi
}

api_key() {
  if [[ -n "$api_key_file" && -r "$api_key_file" ]]; then
    tr -d '\r\n' < "$api_key_file"
  fi
}

healthy() {
  if [[ "$kind" == "embedding" ]]; then
    local key
    key="$(api_key)"
    curl -fsS --max-time 15 \
      -H "content-type: application/json" \
      ${key:+-H "Authorization: Bearer ${key}"} \
      -d "{\"model\":\"${model}\",\"input\":[\"memory-xx upstream health\"]}" \
      "http://127.0.0.1:${port}/v3/embeddings" >/dev/null
  else
    curl -fsS --max-time 10 "http://127.0.0.1:${port}/v3/models" | grep -q "$model"
  fi
}

windows_process_running() {
  "$POWERSHELL_EXE" -NoProfile -ExecutionPolicy Bypass -Command \
    "\$self = \$PID; \$p = Get-CimInstance Win32_Process | Where-Object { \$_.ProcessId -ne \$self -and \$_.CommandLine -like '*${process_match}*' }; if (\$p) { 'running' }" 2>/dev/null | grep -q running
}

start_windows_process() {
  if healthy; then
    log "$label already healthy on port $port"
    return 0
  fi
  if windows_process_running; then
    log "$label process exists but is unhealthy; restarting it"
    stop_windows_process
  fi
  log "starting $label via $bat_path"
  "$POWERSHELL_EXE" -NoProfile -ExecutionPolicy Bypass -Command \
    "Start-Process -FilePath '${CMD_EXE}' -ArgumentList '/c','${bat_path}' -WorkingDirectory '${OVMS_DIR}' -WindowStyle Minimized" >/dev/null

  local deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
  until healthy; do
    if (( SECONDS >= deadline )); then
      log "$label did not become healthy within ${READY_TIMEOUT_SECONDS}s"
      return 1
    fi
    sleep 3
  done
  log "$label healthy on port $port"
}

stop_windows_process() {
  log "stopping $label process matching '$process_match'"
  "$POWERSHELL_EXE" -NoProfile -ExecutionPolicy Bypass -Command \
    "\$self = \$PID; Get-CimInstance Win32_Process | Where-Object { \$_.ProcessId -ne \$self -and \$_.CommandLine -like '*${process_match}*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" >/dev/null || true
}

case "$mode" in
  status)
    if healthy; then
      log "$label healthy"
      exit 0
    fi
    log "$label unhealthy"
    exit 1
    ;;
  start)
    start_windows_process
    exit $?
    ;;
  stop)
    stop_windows_process
    exit 0
    ;;
  run)
    ;;
  *)
    echo "unknown mode: $mode" >&2
    exit 64
    ;;
esac

require_ovms_dir
mkdir -p "$OVMS_DIR" >/dev/null 2>&1 || true
log "manager started for $label"
start_windows_process

unhealthy_count=0
while true; do
  if healthy; then
    unhealthy_count=0
  else
    unhealthy_count=$((unhealthy_count + 1))
    log "$label health check failed (${unhealthy_count}/${UNHEALTHY_THRESHOLD})"
    if (( unhealthy_count >= UNHEALTHY_THRESHOLD )); then
      stop_windows_process
      start_windows_process
      unhealthy_count=0
    fi
  fi
  sleep "$POLL_SECONDS"
done
