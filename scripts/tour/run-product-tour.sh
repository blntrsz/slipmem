#!/usr/bin/env bash
# Record the whole disposable product-tour scenario end to end.
#
# - builds the real web bundle (set TOUR_SKIP_BUILD=1 to reuse the current one);
# - seeds a disposable note root through the real CLI;
# - starts the real server with isolated HOME/XDG/SLIPMEM_DIR;
# - submits the pending permanent proposal through the real HTTP MCP endpoint;
# - records the committed product-tour.script.json;
# - stops only the server process it started.
#
# Generated media stays in scripts/tour/output (gitignored). No note, index,
# state, or recording files enter the repository.
#
# Usage:
#   bash scripts/tour/run-product-tour.sh
#   TOUR_SKIP_BUILD=1 bash scripts/tour/run-product-tour.sh
#   TOUR_WORK_ROOT=/tmp/opencode/another-slipmem-tour bash scripts/tour/run-product-tour.sh

set -euo pipefail

# Provider-backed memory is opt-in. The tour records a fixed, disposable
# scenario, so remove any ambient chat/maintenance/recall/capture configuration
# before the seeding CLI or the web server can inherit it. This also keeps a
# partial host configuration from failing server startup.
unset \
  SLIPMEM_AUTO_MEMORY \
  SLIPMEM_AUTO_MEMORY_INTERVAL_MS \
  SLIPMEM_AUTO_MEMORY_RUN_ON_START \
  SLIPMEM_CHAT_PROVIDER \
  SLIPMEM_CHAT_BASE_URL \
  SLIPMEM_CHAT_MODEL \
  SLIPMEM_CHAT_API_KEY \
  SLIPMEM_MAINTENANCE_PROVIDER \
  SLIPMEM_MAINTENANCE_BASE_URL \
  SLIPMEM_MAINTENANCE_MODEL \
  SLIPMEM_MAINTENANCE_API_KEY \
  SLIPMEM_RECALL_PROVIDER \
  SLIPMEM_RECALL_JEV_MODEL \
  SLIPMEM_CAPTURE_PROVIDER \
  SLIPMEM_CAPTURE_BASE_URL \
  SLIPMEM_CAPTURE_MODEL \
  SLIPMEM_CAPTURE_API_KEY \
  TYPESAFE_API_KEY \
  OPENAI_API_KEY \
  OPENAI_BASE_URL \
  OPENAI_MODEL \
  ANTHROPIC_API_KEY \
  ANTHROPIC_BASE_URL

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
work_root="${TOUR_WORK_ROOT:-/tmp/opencode/slipmem-tour}"
port="${TOUR_PORT:-3317}"
base_url="http://127.0.0.1:${port}"

if [[ "$port" != "3317" ]]; then
  echo "run-product-tour: product-tour.script.json targets port 3317; got TOUR_PORT=$port" >&2
  exit 1
fi
if [[ "$work_root" != *slipmem-tour* ]]; then
  echo "run-product-tour: TOUR_WORK_ROOT basename must contain 'slipmem-tour'" >&2
  exit 1
fi

cd "$repo"

if curl -fsS "${base_url}/api/health" >/dev/null 2>&1; then
  echo "run-product-tour: something is already serving ${base_url}; stop it first" >&2
  exit 1
fi

if [[ "${TOUR_SKIP_BUILD:-0}" != "1" ]]; then
  echo "run-product-tour: building the web bundle"
  bun run web:build
fi

echo "run-product-tour: seeding ${work_root}/.slipmem with the real CLI"
bun "$here/scenario.mjs" prepare

mkdir -p "$work_root"
(
  cd packages/web
  exec env \
    SLIPMEM_DIR="$work_root/.slipmem" \
    HOME="$work_root/home" \
    XDG_CACHE_HOME="$work_root/cache" \
    XDG_STATE_HOME="$work_root/state" \
    XDG_DATA_HOME="$work_root/data" \
    XDG_CONFIG_HOME="$work_root/config" \
    PORT="$port" \
    HOST=127.0.0.1 \
    bun scripts/serve.ts
) >"$work_root/server.log" 2>&1 &
server_pid=$!

cleanup() {
  if kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
  fi
  wait "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

ready=0
for _ in $(seq 1 80); do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    break
  fi
  if curl -fsS "${base_url}/api/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.25
done

if [[ "$ready" != "1" ]]; then
  echo "run-product-tour: server did not become healthy; log follows" >&2
  cat "$work_root/server.log" >&2 || true
  exit 1
fi

echo "run-product-tour: submitting the permanent proposal through HTTP MCP"
bun "$here/scenario.mjs" propose --base-url "$base_url"

echo "run-product-tour: recording"
(
  cd "$here"
  bun record.mjs product-tour.script.json
)

bun "$here/scenario.mjs" verify

echo "run-product-tour: scenario manifest: $work_root/scenario.json"
echo "run-product-tour: video: $here/output/slipmem-product-tour.webm"
echo "run-product-tour: action log: $here/output/slipmem-product-tour.actions.json"
