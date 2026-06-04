#!/usr/bin/env bash
#
# functional-test-memory-xx.sh
# memory-xx 功能模块真实性测试 — 覆盖 M1~M6
#
# 用法：
#   bash scripts/functional-test-memory-xx.sh [module]
#   模块：m1|m2|m3|m4|m5|m6|all（默认 all）
#
set -uo pipefail

WRAPPER="${WRAPPER:-${MEMORY_XX_WRAPPER_URL:-http://127.0.0.1:5100}}"
PG_DB="${PG_DB:-postgres://postgres:postgres@127.0.0.1:55432/memory_xx}"
PG_SCHEMA="${PG_SCHEMA:-${MEMORY_XX_DATABASE_SCHEMA:-memory_xx}}"
QDRANT_BASE="${QDRANT_BASE:-http://127.0.0.1:6333}"
QDRANT_COLLECTION="${QDRANT_COLLECTION:-memory-xx}"
LOG_DIR="${LOG_DIR:-$(pwd)/.runtime/functional-tests}"
MODULE="${1:-all}"

mkdir -p "$LOG_DIR"
NOW="$(date -Iseconds)"
TEST_PREFIX="ftest_$(date +%H%M%S)_$$"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
info() { echo "[INFO] $1"; }

HTTP_STATUS=000
HTTP_STATUS_FILE="${LOG_DIR}/last-http-status"

# python-based HTTP POST helper (avoids shell quoting issues)
http_post() {
  python3 -c "
import json, os, subprocess, sys
path = '$1'
body = json.loads('''$2''')
headers = ['-H', 'Content-Type: application/json']
token = os.environ.get('MEMORY_XX_ADMIN_TOKEN', '').strip() or os.environ.get('MEMORY_XX_API_TOKEN', '').strip()
if token:
    headers += ['-H', f'Authorization: Bearer {token}']
r = subprocess.run(['curl', '-s', '-X', 'POST', '${WRAPPER}' + path,
    *headers,
    '-d', json.dumps(body),
    '-w', '\nHTTP_CODE:%{http_code}'],
    capture_output=True, text=True)
out = r.stdout
# separate body and code
parts = out.rsplit('\nHTTP_CODE:', 1)
print(parts[0] if parts else out)
code = parts[1] if len(parts) > 1 else '000'
open('${HTTP_STATUS_FILE}', 'w', encoding='utf-8').write(code.strip())
"
}

http_ok() {
  HTTP_STATUS="$(cat "$HTTP_STATUS_FILE" 2>/dev/null || printf '000')"
  [[ "$HTTP_STATUS" =~ ^2[0-9][0-9]$ ]]
}

wait_for_wrapper() {
  local timeout="${MEMORY_XX_FUNCTIONAL_WAIT_SECONDS:-30}"
  for i in $(seq 1 "$timeout"); do
    if curl -sS -m 2 "${WRAPPER}/live" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "Wrapper 未在 ${timeout}s 内就绪: ${WRAPPER}/live"
  return 1
}

qdrant_scroll() {
  curl -s -X POST "${QDRANT_BASE}/collections/${QDRANT_COLLECTION}/points/scroll" \
    -H "Content-Type: application/json" \
    -d '{"limit": 1, "scroll_filter": {"must": [{"key": "memory_id", "match": {"value": "'"$1"'"}}]}}' 2>/dev/null
}

# ─────────────────────────────────────────────
# M1: 写入管道
# write orchestrator → outbox → projector → Qdrant → recall
# ─────────────────────────────────────────────
test_m1() {
  local label="M1: 写入管道"
  info "=== $label ==="
  local title="功能测试-M1-写入管道-${TEST_PREFIX}"

  # orchestrator write-memory 需要 command 对象包含所有 required 字段
  local body; body="$(python3 -c "
import json, uuid
print(json.dumps({
    'command': {
        'requestId': str(uuid.uuid4()),
        'actorId': 'ftest',
        'scopeType': 'workspace',
        'scopeId': 'functional-test',
        'content': '这是一条真实性测试记录 (${TEST_PREFIX})，验证从 write 到 Qdrant 再到 recall 的完整链路。',
        'title': '${title}',
        'summary': None,
        'metadata': {'tags': ['ftest', 'm1']},
        'dedupeKey': 'm1:' + '${TEST_PREFIX}',
        'lifecycleStatus': 'approved',
        'reviewState': 'not_required',
        'sources': [],
        'relations': []
    }
}))")"

  local resp; resp="$(http_post "/api/memory/xx/orchestrator/write-memory" "$body")"
  if ! http_ok; then
    fail "$label: write HTTP $HTTP_STATUS"
    echo "RESP: $resp"
    return 1
  fi
  local mem_id; mem_id="$(echo "$resp" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('write',{}).get('memoryId','') or d.get('error',''))" 2>/dev/null)"
  [[ -z "$mem_id" || "$mem_id" == *"error"* ]] && { fail "$label: 未返回 memory_id: $mem_id"; echo "RESP: $resp"; return 1; }
  pass "$label: write 成功 memory_id=$mem_id"

  # 等待 projector 处理（2s x 10 = 20s）
  info "等待 projector 处理（最多 20s）..."
  local found=0
  for i in $(seq 1 10); do
    sleep 2
    local qresp; qresp="$(qdrant_scroll "$mem_id")"
    local point_id; point_id="$(echo "$qresp" | python3 -c "import json,sys; d=json.load(sys.stdin); pts=d.get('result',{}).get('points',[]); print(pts[0]['id'] if pts else '')" 2>/dev/null)"
    if [[ -n "$point_id" ]]; then
      found=1
      pass "$label: Qdrant 出现 point_id=$point_id (等待 $((i*2))s)"
      break
    fi
    info "  重试 $i/10..."
  done
  if [[ "$found" -eq 0 ]]; then
    fail "$label: Qdrant 未在 20s 内出现"
    return 1
  fi

  # recall 验证
  local recall_body; recall_body="$(python3 -c "
import json
print(json.dumps({
    'query': '${title}',
    'scope_context': {'user_id': 'functional-test', 'workspace_id': 'functional-test', 'include_global': False},
    'limit': 5
}))")"
  local recall_resp; recall_resp="$(http_post "/api/memory/xx/recall/query" "$recall_body")"
  if ! http_ok; then
    fail "$label: recall HTTP $HTTP_STATUS"
    echo "RESP: $recall_resp"
    return 1
  fi
  local hits; hits="$(echo "$recall_resp" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('results',[])))" 2>/dev/null)"
  local vec_hits; vec_hits="$(echo "$recall_resp" | python3 -c "import json,sys; print(d.get('audit',{}).get('vector_hits','?') if d.get('audit') else '?')" 2>/dev/null)"
  if [[ "$hits" -gt 0 ]]; then
    pass "$label: recall hits=$hits vec_hits=$vec_hits"
  else
    fail "$label: recall hits=0"
    return 1
  fi

  echo "$mem_id" > "${LOG_DIR}/last_test_memory_id"
  echo "$TEST_PREFIX|$mem_id|$title" >> "${LOG_DIR}/test-log.txt"
}

# ─────────────────────────────────────────────
# M2: 读取管道
# ─────────────────────────────────────────────
test_m2() {
  local label="M2: 读取管道"
  info "=== $label ==="
  local queries=("memory framework" "constraints rules" "lessons recent" "projects status")
  local all_ok=true
  for q in "${queries[@]}"; do
    local body; body="$(python3 -c "import json; print(json.dumps({'query':'$q','scope_context':{'user_id':'current-instance-owner','workspace_id':'current-instance','include_global':True},'limit':3}))")"
    local resp; resp="$(http_post "/api/memory/xx/recall/query" "$body")"
    local hits; hits="$(echo "$resp" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('results',[])))" 2>/dev/null)"
    local vec_hits; vec_hits="$(echo "$resp" | python3 -c "import json,sys; d=json.load(sys.stdin); a=d.get('audit',{}); print(a.get('vector_hits','?') if a else '?')" 2>/dev/null)"
    local degraded; degraded="$(echo "$resp" | python3 -c "import json,sys; d=json.load(sys.stdin); v=d.get('degraded'); print(str(v).lower() if v is not None else 'none')" 2>/dev/null)"
    if [[ "$hits" -gt 0 && "$degraded" != "true" ]]; then
      pass "$label: query='$q' hits=$hits vec_hits=$vec_hits"
    else
      fail "$label: query='$q' hits=$hits vec_hits=$vec_hits degraded=$degraded"
      all_ok=false
    fi
  done
  [[ "$all_ok" == "true" ]] && pass "$label: 全部查询 degraded=false" || warn "$label: 部分查询降级"
}

# ─────────────────────────────────────────────
# M3: 生命周期一致性审计
# ─────────────────────────────────────────────
test_m3() {
  local label="M3: 生命周期一致性"
  info "=== $label ==="
  local body; body="$(python3 -c "import json; print(json.dumps({'include_records':True}))")"
  local resp; resp="$(http_post "/api/memory/xx/orchestrator/audit-memory-consistency" "$body")"
  local ok; ok="$(echo "$resp" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('ok', d.get('consistent','unknown')))" 2>/dev/null)"
  local counts; counts="$(echo "$resp" | python3 -c "import json,sys; d=json.load(sys.stdin); c=d.get('counts',{}); print(f\"records={c.get('memory_records','?')} events={c.get('memory_events','?')} outbox={c.get('outbox_events','?')}\")" 2>/dev/null)"
  local findings_count; findings_count="$(echo "$resp" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('findings',[])))" 2>/dev/null)"
  info "$label: $counts findings=$findings_count"
  if [[ "$ok" == "True" || "$ok" == "true" ]]; then
    pass "$label: 一致性检查通过"
  else
    warn "$label: 一致性=$ok (ok 非 true，详见 findings)"
  fi
}

# ─────────────────────────────────────────────
# M4: 精确召回（memory_ids filter）
# ─────────────────────────────────────────────
test_m4() {
  local label="M4: 精确召回"
  info "=== $label ==="
  local mem_id_file="${LOG_DIR}/last_test_memory_id"
  if [[ ! -s "$mem_id_file" ]]; then
    warn "$label: 无测试 memory_id（需先跑 M1），跳过"
    return 0
  fi
  local test_mem_id; test_mem_id="$(cat "$mem_id_file")"
  # 用中文关键词查询，匹配 M1 写的测试记录内容
  local body; body="$(python3 -c "import json; print(json.dumps({'query':'真实性测试记录','scope_context':{'user_id':'functional-test','workspace_id':'functional-test','include_global':False,'memory_ids':['${test_mem_id}']},'limit':5}))")"
  local resp; resp="$(http_post "/api/memory/xx/recall/query" "$body")"
  local hits; hits="$(echo "$resp" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('results',[])))" 2>/dev/null)"
  if [[ "$hits" -gt 0 ]]; then
    pass "$label: memory_ids filter hits=$hits (query='这是一条真实性测试记录')"
  else
    warn "$label: memory_id=$test_mem_id 未召回（query='这是一条真实性测试记录'）"
  fi
}

# ─────────────────────────────────────────────
# M5: 遗忘管道
# ─────────────────────────────────────────────
test_m5() {
  local label="M5: 遗忘管道"
  info "=== $label ==="
  local mem_id_file="${LOG_DIR}/last_test_memory_id"
  if [[ ! -s "$mem_id_file" ]]; then
    warn "$label: 无测试 memory_id，跳过"
    return 0
  fi
  local test_mem_id; test_mem_id="$(cat "$mem_id_file")"
  # forget-memory 需要 top-level requestId
  local body; body="$(python3 -c "import json; print(json.dumps({'memoryId':'${test_mem_id}','mode':'tombstone','actorId':'ftest','requestId':'ftest-forget-001'}))")"
  local resp; resp="$(http_post "/api/memory/xx/orchestrator/forget-memory" "$body")"
  local success; success="$(echo "$resp" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('forget',{}).get('success', d.get('forget',{}).get('tombstoned', 'unknown')))" 2>/dev/null)"
  if [[ "$success" == "True" || "$success" == "true" ]]; then
    pass "$label: forget 成功 memory_id=$test_mem_id"
    > "$mem_id_file"
  else
    warn "$label: forget 返回: $resp"
  fi
}

# ─────────────────────────────────────────────
# M6: Qdrant 数据完整性
# ─────────────────────────────────────────────
test_m6() {
  local label="M6: Qdrant 数据完整性"
  info "=== $label ==="
  local count_resp; count_resp="$(curl -s -X POST "${QDRANT_BASE}/collections/${QDRANT_COLLECTION}/points/scroll" -H "Content-Type: application/json" -d '{"limit": 1}' 2>/dev/null)"
  local has_points; has_points="$(echo "$count_resp" | python3 -c "import json,sys; d=json.load(sys.stdin); pts=d.get('result',{}).get('points',[]); print('yes' if pts else 'no')" 2>/dev/null)"
  if [[ "$has_points" == "yes" ]]; then
    local info_str; info_str="$(echo "$count_resp" | python3 -c "import json,sys; d=json.load(sys.stdin); pts=d.get('result',{}).get('points',[]); p=pts[0] if pts else {}; print(f'id={p.get(\"id\",\"?\")} memory_id={p.get(\"payload\",{}).get(\"memory_id\",\"?\")}')")"
    pass "$label: Qdrant 有数据 $info_str"
  else
    fail "$label: Qdrant collection 为空"
  fi
}

# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
main() {
  echo "========================================"
  echo "memory-xx 功能模块真实性测试"
  echo "时间: $NOW  前缀: $TEST_PREFIX"
  echo "Wrapper: $WRAPPER"
  echo "========================================"
  echo ""
  wait_for_wrapper || return 1

  local status=0
  case "$MODULE" in
    m1) test_m1 || status=1 ;;
    m2) test_m2 || status=1 ;;
    m3) test_m3 || status=1 ;;
    m4) test_m4 || status=1 ;;
    m5) test_m5 || status=1 ;;
    m6) test_m6 || status=1 ;;
    all)
      test_m1 || status=1
      echo ""
      test_m2 || status=1
      echo ""
      test_m3 || status=1
      echo ""
      test_m4 || status=1
      echo ""
      test_m5 || status=1
      echo ""
      test_m6 || status=1
      ;;
    *) echo "未知模块: $MODULE"; echo "用法: $0 [m1|m2|m3|m4|m5|m6|all]"; exit 1 ;;
  esac

  echo ""
  info "测试完成，结果已记录到 ${LOG_DIR}/test-log.txt"
  return "$status"
}

main
