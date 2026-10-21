#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/brownie-supervisor-ownership.XXXXXX")"
FIRST_PID=""
cleanup() {
  if [ -n "$FIRST_PID" ] && kill -0 "$FIRST_PID" 2>/dev/null; then
    kill -KILL "$FIRST_PID" 2>/dev/null || true
    wait "$FIRST_PID" 2>/dev/null || true
  fi
  rm -rf "$STATE_DIR"
}
trap cleanup EXIT

mkdir -p "$STATE_DIR/logs" "$STATE_DIR/todo-claims"
cat > "$STATE_DIR/todo.md" <<'EOF'
- [ ] ownership regression fixture
EOF

COMMON_ENV=(
  PHASE_LOOP_STATE_DIR="$STATE_DIR"
  PHASE_LOOP_TODO="$STATE_DIR/todo.md"
  PHASE_LOOP_TODO_BREAKDOWN="$STATE_DIR/todo-breakdown.md"
  PHASE_LOOP_FAILURE_BACKOFF_SECONDS=30
  PHASE_LOOP_MAX_FAILURE_BACKOFF_SECONDS=30
  PHASE_LOOP_SUPERVISOR_OWNER_GRACE_SECONDS=0
)

touch "$STATE_DIR/stop"
env "${COMMON_ENV[@]}" bash "$ROOT_DIR/phase-loop.sh" supervise >"$STATE_DIR/cleanup.out" 2>&1
[ ! -d "$STATE_DIR/phase-loop.lock" ]
rm -f "$STATE_DIR/stop"

env "${COMMON_ENV[@]}" bash "$ROOT_DIR/phase-loop.sh" supervise >"$STATE_DIR/first.out" 2>&1 &
FIRST_PID=$!
for _ in $(seq 1 50); do
  [ -f "$STATE_DIR/phase-loop.lock/owner.json" ] && break
  sleep 0.1
done
[ -f "$STATE_DIR/phase-loop.lock/owner.json" ]

set +e
env "${COMMON_ENV[@]}" bash "$ROOT_DIR/phase-loop.sh" supervise >"$STATE_DIR/second.out" 2>&1
SECOND_STATUS=$?
set -e
[ "$SECOND_STATUS" -eq 75 ]
grep -q "refusing concurrent supervisor" "$STATE_DIR/second.out"
kill -KILL "$FIRST_PID" 2>/dev/null || true
wait "$FIRST_PID" 2>/dev/null || true
FIRST_PID=""

mkdir -p "$STATE_DIR/phase-loop.lock"
cat > "$STATE_DIR/phase-loop.lock/owner.json" <<EOF
{"command":"dead phase-loop.sh supervise","generation":"stale-generation","pid":999999,"root_dir":"$ROOT_DIR","schema_version":1,"start_time":"dead","started_at":"2020-01-01T00:00:00Z"}
EOF
printf '999999\n' > "$STATE_DIR/phase-loop.lock/pid"

env "${COMMON_ENV[@]}" bash "$ROOT_DIR/phase-loop.sh" supervise >"$STATE_DIR/recovered.out" 2>&1 &
RECOVERED_PID=$!
for _ in $(seq 1 50); do
  grep -q "reclaimed stale phase-loop supervisor lock" "$STATE_DIR/logs/supervisor.log" 2>/dev/null && break
  sleep 0.1
done
grep -q "reclaimed stale phase-loop supervisor lock" "$STATE_DIR/logs/supervisor.log"
kill -KILL "$RECOVERED_PID" 2>/dev/null || true
wait "$RECOVERED_PID" 2>/dev/null || true

printf '%s\n' 'phase-loop supervisor ownership regression: ok'
