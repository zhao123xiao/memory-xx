#!/usr/bin/env bash
#
# Start the public core/dev Docker Compose profile and verify write/project/recall.
# This script intentionally leaves the stack running for inspection.
#
set -euo pipefail

: "${MEMORY_XX_RUNTIME_PROFILE:=core}"
: "${MEMORY_XX_WRAPPER_HOST_PORT:=13100}"
: "${MEMORY_XX_EMBEDDING_PROXY_HOST_PORT:=13221}"
: "${MEMORY_XX_DEV_EMBEDDING_HOST_PORT:=13222}"
: "${MEMORY_XX_DEV_CHAT_HOST_PORT:=13223}"
: "${MEMORY_XX_DEV_RERANKER_HOST_PORT:=13084}"
: "${MEMORY_XX_POSTGRES_HOST_PORT:=13432}"
: "${MEMORY_XX_REDIS_HOST_PORT:=13379}"
: "${MEMORY_XX_QDRANT_HOST_PORT:=13333}"
: "${MEMORY_XX_COMPOSE_CORE_LIVE_WAIT_MS:=90000}"
: "${MEMORY_XX_COMPOSE_CORE_LIVE_SKIP_FUNCTIONAL:=0}"
: "${MEMORY_XX_COMPOSE_CORE_LIVE_BUILD:=1}"

export MEMORY_XX_RUNTIME_PROFILE
export MEMORY_XX_WRAPPER_HOST_PORT
export MEMORY_XX_EMBEDDING_PROXY_HOST_PORT
export MEMORY_XX_DEV_EMBEDDING_HOST_PORT
export MEMORY_XX_DEV_CHAT_HOST_PORT
export MEMORY_XX_DEV_RERANKER_HOST_PORT
export MEMORY_XX_POSTGRES_HOST_PORT
export MEMORY_XX_REDIS_HOST_PORT
export MEMORY_XX_QDRANT_HOST_PORT

if [[ "$MEMORY_XX_COMPOSE_CORE_LIVE_BUILD" == "1" ]]; then
  docker compose --profile dev up -d --remove-orphans --build
else
  docker compose --profile dev up -d --remove-orphans
fi

ADMIN_TOKEN="$(
  docker compose exec -T memory-xx sh -lc 'printf "%s" "$MEMORY_XX_ADMIN_TOKEN"'
)"
ADMIN_ENV=("MEMORY_XX_ADMIN_TOKEN=$ADMIN_TOKEN")
FUNCTIONAL_AUTH_ENV=(
  "MEMORY_XX_API_TOKEN=$ADMIN_TOKEN"
  "MEMORY_XX_ADMIN_TOKEN=$ADMIN_TOKEN"
)

env "${ADMIN_ENV[@]}" TMPDIR="${TMPDIR:-/tmp}" \
  npm run smoke:compose-profile-live -- \
    --url "http://127.0.0.1:${MEMORY_XX_WRAPPER_HOST_PORT}/health" \
    --wait-ms "$MEMORY_XX_COMPOSE_CORE_LIVE_WAIT_MS"

if [[ "$MEMORY_XX_COMPOSE_CORE_LIVE_SKIP_FUNCTIONAL" == "1" ]]; then
  echo "Skipping functional smoke because MEMORY_XX_COMPOSE_CORE_LIVE_SKIP_FUNCTIONAL=1"
  exit 0
fi

env \
  WRAPPER="http://127.0.0.1:${MEMORY_XX_WRAPPER_HOST_PORT}" \
  PG_DB="postgres://postgres:postgres@127.0.0.1:${MEMORY_XX_POSTGRES_HOST_PORT}/memory_xx" \
  QDRANT_BASE="http://127.0.0.1:${MEMORY_XX_QDRANT_HOST_PORT}" \
  QDRANT_COLLECTION="${MEMORY_XX_QDRANT_COLLECTION:-memory-xx}" \
  "${FUNCTIONAL_AUTH_ENV[@]}" \
  TMPDIR="${TMPDIR:-/tmp}" \
  npm run smoke:functional -- m1
