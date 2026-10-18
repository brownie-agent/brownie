#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run_case() {
  local mode="$1"
  local state_dir
  state_dir="$(mktemp -d "${TMPDIR:-/tmp}/brownie-watchdog-errexit.XXXXXX")"
  mkdir -p "$state_dir/logs" "$state_dir/todo-claims" "$state_dir/runs" "$state_dir/trajectories" "$state_dir/known-good-targets"
  trap 'rm -rf "$state_dir"' RETURN
  STATE_DIR="$state_dir" ROOT_DIR="$ROOT_DIR" MODE="$mode" bash -c '
    set -u
    printf "%s\n" "$$" > "$STATE_DIR/phase-loop.pid"
    printf "%s\n" "{\"schema_version\":1,\"pid\":$$,\"generation\":\"generation-1\",\"root_dir\":\"$ROOT_DIR\"}" > "$STATE_DIR/phase-loop-owner.json"
    printf "%s\n" "{\"status\":\"running\",\"run_id\":\"continuation-run\",\"updated_at\":\"2026-10-18T01:00:00.000Z\",\"continuation_required\":true,\"controller_action\":\"resume\",\"supervisor_pid\":$$,\"supervisor_generation\":\"generation-1\"}" > "$STATE_DIR/status.json"
    if [ "$MODE" = "on" ]; then
      set -e
    else
      set +e
    fi
    source "$ROOT_DIR/phase-loop.sh" status >/dev/null 2>&1
    if [ "$MODE" = "on" ]; then
      if phase_loop_watch_continuation_liveness "errexit-$MODE"; then
        result=0
      else
        result=$?
      fi
      case "$-" in *e*) ;; *) exit 11 ;; esac
    else
      phase_loop_watch_continuation_liveness "errexit-$MODE"
      result=$?
      case "$-" in *e*) exit 12 ;; esac
    fi
    [ "$result" -eq 75 ]
  ' bash
}

run_case off
run_case on
printf '%s\n' 'phase-loop watchdog preserves caller errexit state (off/on)'
