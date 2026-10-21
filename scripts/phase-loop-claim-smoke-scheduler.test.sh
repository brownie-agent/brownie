#!/usr/bin/env bash
set -eu

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO_ROOT/scripts/phase-loop-claim-smoke-scheduler.sh"

fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/brownie-claim-smoke-scheduler.XXXXXX")"
cleanup() {
  rm -rf -- "$fixture_root"
}
trap cleanup EXIT

fixture_script="$fixture_root/shard-fixture.sh"
cat > "$fixture_script" <<'SH'
#!/usr/bin/env bash
set -eu

case "${PHASE_LOOP_CLAIM_SMOKE_SECTION:-}" in
  fast)
    printf 'fast shard completed\n'
    ;;
  slow)
    sleep 30 &
    child_pid="$!"
    printf '%s\n' "$child_pid" > "${PHASE_LOOP_CLAIM_SMOKE_CHILD_PID_FILE:?}"
    wait "$child_pid"
    ;;
  *)
    printf 'unexpected shard: %s\n' "${PHASE_LOOP_CLAIM_SMOKE_SECTION:-}" >&2
    exit 2
    ;;
esac
SH
chmod +x "$fixture_script"

scheduler_driver="$fixture_root/scheduler-driver.sh"
cat > "$scheduler_driver" <<SH
#!/usr/bin/env bash
set -u
source "$REPO_ROOT/scripts/phase-loop-claim-smoke-scheduler.sh"
PHASE_LOOP_CLAIM_SMOKE_AUDIT_OUTPUT="\$1"
export PHASE_LOOP_CLAIM_SMOKE_AUDIT_OUTPUT
shift
phase_loop_claim_smoke_run_scheduler "\$@"
SH
chmod +x "$scheduler_driver"

assert_json() {
  local manifest="$1"
  local expression="$2"
  python3 - "$manifest" "$expression" <<'PY'
import json
import sys

manifest = json.loads(open(sys.argv[1], encoding="utf-8").read())
safe_globals = {"__builtins__": {}}
safe_locals = {"manifest": manifest, "len": len, "all": all, "any": any}
assert eval(sys.argv[2], safe_globals, safe_locals), sys.argv[2]
PY
}

normal_output="$fixture_root/normal-audit.json"
PHASE_LOOP_CLAIM_SMOKE_AUDIT_OUTPUT="$normal_output" \
  bash "$scheduler_driver" "$normal_output" \
  "$fixture_root/normal-shards" "$fixture_script" 2 10 fast fast fast fast fast fast fast fast \
  2>"$fixture_root/normal-driver.stderr"
assert_json "$normal_output" 'manifest["scheduler_timed_out"] is False'
assert_json "$normal_output" 'len([r for r in manifest["records"] if r.get("event") == "shard_finished" and r.get("status") == "passed"]) == 8'
assert_json "$normal_output" 'all(r.get("pid") and r.get("pgid") and r.get("stdout_path") and r.get("stderr_path") and r.get("temp_root") and r.get("state_root") and r.get("workspace_root") for r in manifest["records"] if r.get("event") == "shard_started")'
grep -Fq '"event": "shard_started"' "$fixture_root/normal-driver.stderr"
grep -Fq '"event": "shard_finished"' "$fixture_root/normal-driver.stderr"

child_pid_file="$fixture_root/slow-child.pid"
timeout_output="$fixture_root/timeout-audit.json"
set +e
PHASE_LOOP_CLAIM_SMOKE_CHILD_PID_FILE="$child_pid_file" \
PHASE_LOOP_CLAIM_SMOKE_AUDIT_OUTPUT="$timeout_output" \
  bash "$scheduler_driver" "$timeout_output" \
  "$fixture_root/timeout-shards" "$fixture_script" 2 2 slow fast \
  2>"$fixture_root/timeout-driver.stderr"
timeout_status="$?"
set -e
[ "$timeout_status" -ne 0 ]
grep -Fq '"event": "scheduler_timeout"' "$fixture_root/timeout-driver.stderr"
assert_json "$timeout_output" 'manifest["scheduler_timed_out"] is True'
assert_json "$timeout_output" 'any(r.get("event") == "scheduler_timeout" for r in manifest["records"])'
assert_json "$timeout_output" 'any(r.get("event") == "shard_timeout" and r.get("shard") == "slow" and r.get("pid") and r.get("pgid") and r.get("stdout_tail") is not None and r.get("stderr_tail") is not None for r in manifest["records"])'
assert_json "$timeout_output" 'any(r.get("event") == "shard_started" and r.get("shard") == "fast" for r in manifest["records"])'

slow_child_pid="$(cat "$child_pid_file")"
if phase_loop_claim_smoke_process_is_live "$slow_child_pid"; then
  echo "scheduler left fixture descendant alive: pid=$slow_child_pid" >&2
  exit 1
fi

command_audit="$fixture_root/command-audit.jsonl"
set +e
PHASE_LOOP_CLAIM_SMOKE_AUDIT_FILE="$command_audit" \
  phase_loop_claim_smoke_run_with_timeout 1 sleep 30 \
  2>"$fixture_root/command-timeout.stderr"
command_status="$?"
set -e
[ "$command_status" -eq 124 ]
python3 - "$command_audit" <<'PY'
import json
import sys

records = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
timeout = next(record for record in records if record.get("event") == "command_timeout")
assert timeout["pid"] and timeout["pgid"]
PY

echo 'phase-loop claim-smoke scheduler tests passed'
