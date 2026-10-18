#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run_case() {
  local mode="$1"
  local state_dir
  state_dir="$(mktemp -d "${TMPDIR:-/tmp}/brownie-watchdog-errexit.XXXXXX")"
  mkdir -p "$state_dir/logs" "$state_dir/todo-claims" "$state_dir/runs" "$state_dir/trajectories" "$state_dir/known-good-targets"
  trap 'rm -rf "$state_dir"' RETURN
  PHASE_LOOP_STATE_DIR="$state_dir" STATE_DIR="$state_dir" ROOT_DIR="$ROOT_DIR" MODE="$mode" bash -c '
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

supervise_case_dir="$(mktemp -d "${TMPDIR:-/tmp}/brownie-watchdog-supervise.XXXXXX")"
trap 'rm -rf "$supervise_case_dir"' EXIT
mkdir -p "$supervise_case_dir/logs"
set +e
PHASE_LOOP_STATE_DIR="$supervise_case_dir" STATE_DIR="$supervise_case_dir" ROOT_DIR="$ROOT_DIR" bash -c '
  set -e
  source "$ROOT_DIR/phase-loop.sh" status >/dev/null 2>&1
  acquire_lock() { return 0; }
  write_supervisor_owner() { :; }
  write_status() {
    printf "%s|%s|%s|%s\n" "$1" "$2" "$3" "$4" > "$STATE_DIR/supervisor-status.txt"
  }
  phase_loop_watch_continuation_liveness() { return 75; }
  stop_if_todo_empty() { touch "$STATE_DIR/stop-if-todo-empty-called"; return 0; }
  run_brownie_once() { touch "$STATE_DIR/run-brownie-once-called"; return 0; }
  supervise
' bash
supervise_status=$?
set -e
[ "$supervise_status" -eq 78 ]
[ "$(cut -d "|" -f 1 "$supervise_case_dir/supervisor-status.txt")" = "blocked" ]
[ ! -e "$supervise_case_dir/stop-if-todo-empty-called" ]
[ ! -e "$supervise_case_dir/run-brownie-once-called" ]

start_case_dir="$(mktemp -d "${TMPDIR:-/tmp}/brownie-watchdog-start.XXXXXX")"
trap 'rm -rf "$start_case_dir"' EXIT
mkdir -p "$start_case_dir/logs"
set +e
PHASE_LOOP_STATE_DIR="$start_case_dir" STATE_DIR="$start_case_dir" ROOT_DIR="$ROOT_DIR" bash -c '
  set -e
  source "$ROOT_DIR/phase-loop.sh" status >/dev/null 2>&1
  phase_loop_watch_continuation_liveness() { return 75; }
  is_running() { touch "$STATE_DIR/is-running-called"; return 0; }
  start
' bash
start_status=$?
set -e
[ "$start_status" -eq 75 ]
[ ! -e "$start_case_dir/is-running-called" ]
printf '%s\n' 'phase-loop watchdog preserves caller errexit state (off/on)'
printf '%s\n' 'phase-loop supervisor terminalizes watchdog ownership failure (75 -> blocked/78)'
printf '%s\n' 'phase-loop startup checks continuation watchdog before live-owner return'
