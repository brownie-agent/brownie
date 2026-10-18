import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectSupervisorOwnership, normalizeStaleRunningStatus, rollbackStaleRunningRecovery, watchdogContinuationLiveness } from './phase-loop-run-state.mjs';

function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-run-state-'));
  fs.mkdirSync(stateDir, { recursive: true });
  return { stateDir, statusPath: path.join(stateDir, 'status.json'), pidPath: path.join(stateDir, 'phase-loop.pid'), ownerPath: path.join(stateDir, 'phase-loop-owner.json') };
}

function writeOwner(ownerPath, pid = 1234, generation = 'generation-1') {
  fs.writeFileSync(ownerPath, JSON.stringify({ schema_version: 1, pid, generation, root_dir: '/repo' }));
}

test('normalizes a stale running status with an atomic replacement and two-phase audit', () => {
  const { stateDir, statusPath, pidPath } = fixture();
  const previous = {
    status: 'running',
    detail: 'interrupted by host loss',
    run_id: 'run-stale',
    exit_code: '',
    consecutive_failures: 2,
    pid_file: pidPath
  };
  fs.writeFileSync(statusPath, JSON.stringify(previous));
  fs.writeFileSync(pidPath, '999999');

  const result = normalizeStaleRunningStatus({
    stateDir,
    pidFile: pidPath,
    runStamp: 'next-run',
    now: '2026-10-18T01:02:03.000Z',
    processExists: () => false
  });
  assert.equal(result.ok, true);
  assert.equal(result.normalized, true);
  assert.equal(result.replacement_status.status, 'recovered_stale_running');
  assert.equal(result.replacement_status.exit_code, '78');
  assert.equal(result.replacement_status.consecutive_failures, 3);
  assert.equal(JSON.parse(fs.readFileSync(statusPath, 'utf8')).recovery_id, result.recovery_id);
  const audit = fs.readFileSync(path.join(stateDir, 'run-state-recovery.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(audit.map((record) => record.phase), ['prepared', 'applied']);
  assert.deepEqual(audit[0].previous_status, previous);
  assert.equal(audit[1].replacement_status.status, 'recovered_stale_running');
});

test('refuses to normalize a status whose PID is still alive', () => {
  const { stateDir, statusPath, pidPath } = fixture();
  fs.writeFileSync(statusPath, JSON.stringify({ status: 'running', run_id: 'live-run', pid_file: pidPath, supervisor_pid: 1234, supervisor_generation: 'generation-1' }));
  fs.writeFileSync(pidPath, '1234');
  writeOwner(path.join(stateDir, 'phase-loop-owner.json'));
  const result = normalizeStaleRunningStatus({ stateDir, pidFile: pidPath, rootDir: '/repo', processExists: () => true, getProcessCommand: () => 'bash /repo/phase-loop.sh supervise', listSupervisors: () => [1234] });
  assert.deepEqual(result, { ok: false, code: 'run_already_running', pid: 1234, run_id: 'live-run' });
  assert.equal(JSON.parse(fs.readFileSync(statusPath, 'utf8')).status, 'running');
  assert.equal(fs.existsSync(path.join(stateDir, 'run-state-recovery.jsonl')), false);
});

test('allows the owning supervisor to resume an authorized continuation', () => {
  const { stateDir, statusPath, pidPath } = fixture();
  fs.writeFileSync(statusPath, JSON.stringify({
    status: 'running',
    run_id: 'continuation-run',
    pid_file: pidPath,
    continuation_required: true,
    controller_action: 'resume',
    supervisor_pid: 1234,
    supervisor_generation: 'generation-1'
  }));
  fs.writeFileSync(pidPath, '1234');
  writeOwner(path.join(stateDir, 'phase-loop-owner.json'));
  const result = normalizeStaleRunningStatus({
    stateDir,
    pidFile: pidPath,
    rootDir: '/repo',
    ownerPid: 1234,
    processExists: () => true,
    getProcessCommand: () => 'bash /repo/phase-loop.sh supervise',
    listSupervisors: () => [1234]
  });
  assert.deepEqual(result, {
    ok: true,
    normalized: false,
    reason: 'owned_continuation_resume',
    pid: 1234,
    run_id: 'continuation-run',
    generation: 'generation-1'
  });
  assert.equal(JSON.parse(fs.readFileSync(statusPath, 'utf8')).status, 'running');
  assert.equal(fs.existsSync(path.join(stateDir, 'run-state-recovery.jsonl')), false);
});

test('fails closed when a different live process owns the continuation state', () => {
  const { stateDir, statusPath, pidPath } = fixture();
  fs.writeFileSync(statusPath, JSON.stringify({
    status: 'running',
    run_id: 'competing-run',
    pid_file: pidPath,
    continuation_required: true,
    controller_action: 'resume'
  }));
  fs.writeFileSync(pidPath, '5678');
  fs.writeFileSync(path.join(stateDir, 'phase-loop-owner.json'), JSON.stringify({ schema_version: 1, pid: 5678, generation: 'generation-1', root_dir: '/repo' }));
  const result = normalizeStaleRunningStatus({
    stateDir,
    pidFile: pidPath,
    rootDir: '/repo',
    ownerPid: 1234,
    processExists: () => true,
    getProcessCommand: () => 'bash /repo/phase-loop.sh supervise',
    listSupervisors: () => [5678]
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'supervisor_ownership_conflict');
  assert.equal(result.pid, 5678);
  assert.equal(result.run_id, 'competing-run');
});

test('leaves non-running status untouched', () => {
  const { stateDir, statusPath } = fixture();
  fs.writeFileSync(statusPath, JSON.stringify({ status: 'last_run_failed', run_id: 'finished' }));
  const result = normalizeStaleRunningStatus({ stateDir, processExists: () => { throw new Error('must not inspect PID'); } });
  assert.equal(result.ok, true);
  assert.equal(result.normalized, false);
  assert.equal(result.reason, 'status_not_running');
});

test('supports guarded rollback of the latest recovery for audit and operator correction', () => {
  const { stateDir, statusPath, pidPath } = fixture();
  fs.writeFileSync(statusPath, JSON.stringify({ status: 'running', detail: 'previous', run_id: 'run-reversible', pid_file: pidPath }));
  const normalized = normalizeStaleRunningStatus({
    stateDir,
    pidFile: pidPath,
    now: '2026-10-18T02:00:00.000Z',
    processExists: () => false
  });
  const result = rollbackStaleRunningRecovery({ stateDir, recoveryId: normalized.recovery_id, now: '2026-10-18T02:01:00.000Z' });
  assert.equal(result.ok, true);
  assert.equal(result.restored_status.status, 'running');
  assert.equal(result.restored_status.recovery_rollback_id, normalized.recovery_id);
  assert.equal(JSON.parse(fs.readFileSync(statusPath, 'utf8')).status, 'running');
  assert.match(fs.readFileSync(path.join(stateDir, 'run-state-recovery.jsonl'), 'utf8'), /"phase":"rolled_back"/u);
});

test('fails closed when status, pid file, and owner generation disagree', () => {
  const { stateDir, statusPath, pidPath, ownerPath } = fixture();
  fs.writeFileSync(statusPath, JSON.stringify({
    status: 'running',
    run_id: 'generation-mismatch',
    pid_file: pidPath,
    supervisor_pid: 1234,
    supervisor_generation: 'status-generation'
  }));
  fs.writeFileSync(pidPath, '5678');
  writeOwner(ownerPath, 5678, 'owner-generation');
  const result = normalizeStaleRunningStatus({
    stateDir,
    pidFile: pidPath,
    rootDir: '/repo',
    processExists: () => true,
    getProcessCommand: () => 'bash /repo/phase-loop.sh supervise',
    listSupervisors: () => [5678]
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'supervisor_ownership_conflict');
  assert.equal(JSON.parse(fs.readFileSync(statusPath, 'utf8')).status, 'running');
});

test('fails closed when a live supervisor command belongs to another root', () => {
  const { stateDir, statusPath, pidPath, ownerPath } = fixture();
  fs.writeFileSync(statusPath, JSON.stringify({
    status: 'running',
    run_id: 'foreign-root',
    pid_file: pidPath,
    supervisor_pid: 1234,
    supervisor_generation: 'generation-1'
  }));
  fs.writeFileSync(pidPath, '1234');
  writeOwner(ownerPath);
  const result = normalizeStaleRunningStatus({
    stateDir,
    pidFile: pidPath,
    rootDir: '/repo',
    processExists: () => true,
    getProcessCommand: () => 'bash /repo-evil/phase-loop.sh supervise',
    listSupervisors: () => [1234]
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'supervisor_ownership_conflict');
  assert.equal(JSON.parse(fs.readFileSync(statusPath, 'utf8')).status, 'running');
});

test('accepts a supervisor launched through a symlinked root path', () => {
  const { stateDir, pidPath, ownerPath } = fixture();
  const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie root '));
  const linkedRoot = `${realRoot}-link`;
  fs.writeFileSync(path.join(realRoot, 'phase-loop.sh'), '');
  fs.symlinkSync(realRoot, linkedRoot, 'dir');
  fs.writeFileSync(path.join(stateDir, 'status.json'), JSON.stringify({
    status: 'running',
    run_id: 'symlinked-root',
    supervisor_pid: 1234,
    supervisor_generation: 'generation-1'
  }));
  fs.writeFileSync(pidPath, '1234');
  fs.writeFileSync(ownerPath, JSON.stringify({ schema_version: 1, pid: 1234, generation: 'generation-1', root_dir: realRoot }));
  const result = inspectSupervisorOwnership({
    stateDir,
    pidFile: pidPath,
    ownerFile: ownerPath,
    rootDir: linkedRoot,
    processExists: () => true,
    getProcessCommand: () => `bash ${linkedRoot}/phase-loop.sh supervise`,
    listSupervisors: () => [1234]
  });
  assert.equal(result.command_looks_like_supervisor, true);
  assert.equal(result.ownership_ok, true);
});

test('keeps an authorized continuation within the watchdog deadline', () => {
  const { stateDir, statusPath, pidPath, ownerPath } = fixture();
  fs.writeFileSync(statusPath, JSON.stringify({
    status: 'running',
    run_id: 'continuation-fresh',
    updated_at: '2026-10-18T01:00:00.000Z',
    continuation_required: true,
    controller_action: 'resume',
    supervisor_pid: 1234,
    supervisor_generation: 'generation-1'
  }));
  fs.writeFileSync(pidPath, '1234');
  writeOwner(ownerPath);
  const result = watchdogContinuationLiveness({
    stateDir,
    pidFile: pidPath,
    ownerFile: ownerPath,
    rootDir: '/repo',
    now: '2026-10-18T01:10:00.000Z',
    maxAgeSeconds: 900,
    processExists: () => true,
    getProcessCommand: () => 'bash /repo/phase-loop.sh supervise',
    listSupervisors: () => [1234]
  });
  assert.equal(result.expired, false);
  assert.equal(JSON.parse(fs.readFileSync(statusPath, 'utf8')).status, 'running');
});

test('rejects an invalid watchdog duration without expiring a continuation', () => {
  const { stateDir, statusPath } = fixture();
  fs.writeFileSync(statusPath, JSON.stringify({
    status: 'running',
    run_id: 'continuation-invalid-duration',
    updated_at: '2026-10-18T01:00:00.000Z',
    continuation_required: true,
    controller_action: 'resume'
  }));
  const result = watchdogContinuationLiveness({
    stateDir,
    maxAgeSeconds: 'not-a-duration',
    now: '2026-10-18T01:20:01.000Z'
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'continuation_watchdog_duration_invalid');
  assert.equal(JSON.parse(fs.readFileSync(statusPath, 'utf8')).status, 'running');
  assert.equal(fs.existsSync(path.join(stateDir, 'run-state-recovery.jsonl')), false);
});

test('audits and terminalizes an expired continuation held by a live hung owner', () => {
  const { stateDir, statusPath, pidPath, ownerPath } = fixture();
  fs.writeFileSync(statusPath, JSON.stringify({
    status: 'running',
    run_id: 'continuation-stale',
    updated_at: '2026-10-18T01:00:00.000Z',
    continuation_required: true,
    controller_action: 'resume',
    supervisor_pid: 1234,
    supervisor_generation: 'generation-1'
  }));
  fs.writeFileSync(pidPath, '1234');
  writeOwner(ownerPath);
  const result = watchdogContinuationLiveness({
    stateDir,
    pidFile: pidPath,
    ownerFile: ownerPath,
    rootDir: '/repo',
    now: '2026-10-18T01:20:01.000Z',
    maxAgeSeconds: 900,
    runStamp: 'watchdog-run',
    processExists: () => true,
    getProcessCommand: () => 'bash /repo/phase-loop.sh supervise',
    listSupervisors: () => [1234]
  });
  assert.equal(result.ok, true);
  assert.equal(result.redelegate, true);
  const replacement = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  assert.equal(replacement.status, 'blocked');
  assert.equal(replacement.continuation_required, false);
  assert.equal(replacement.stop_reason, 'continuation_watchdog_expired');
  const audit = fs.readFileSync(path.join(stateDir, 'run-state-recovery.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(audit.map((record) => record.phase), ['prepared', 'applied']);
  assert.equal(audit[0].kind, 'phase_loop_continuation_watchdog');
});

test('does not replace a continuation refreshed during ownership inspection', () => {
  const { stateDir, statusPath, pidPath, ownerPath } = fixture();
  const staleStatus = {
    status: 'running',
    run_id: 'continuation-race',
    updated_at: '2026-10-18T01:00:00.000Z',
    continuation_required: true,
    controller_action: 'resume',
    supervisor_pid: 1234,
    supervisor_generation: 'generation-1'
  };
  fs.writeFileSync(statusPath, JSON.stringify(staleStatus));
  fs.writeFileSync(pidPath, '1234');
  writeOwner(ownerPath);
  let inspected = false;
  const result = watchdogContinuationLiveness({
    stateDir,
    pidFile: pidPath,
    ownerFile: ownerPath,
    rootDir: '/repo',
    now: '2026-10-18T01:20:01.000Z',
    maxAgeSeconds: 900,
    processExists: () => true,
    getProcessCommand: () => {
      if (!inspected) {
        inspected = true;
        fs.writeFileSync(statusPath, JSON.stringify({
          ...staleStatus,
          updated_at: '2026-10-18T01:19:59.000Z'
        }));
      }
      return 'bash /repo/phase-loop.sh supervise';
    },
    listSupervisors: () => [1234]
  });
  assert.equal(result.ok, true);
  assert.equal(result.expired, false);
  assert.equal(result.reason, 'continuation_changed_during_watchdog_check');
  assert.equal(JSON.parse(fs.readFileSync(statusPath, 'utf8')).updated_at, '2026-10-18T01:19:59.000Z');
  assert.equal(fs.existsSync(path.join(stateDir, 'run-state-recovery.jsonl')), false);
});

test('run-once installs exit and signal terminalization hooks after entering running state', () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const controller = fs.readFileSync(path.join(repoRoot, 'phase-loop.sh'), 'utf8');
  assert.ok(controller.includes("trap 'phase_loop_finalize_unexpected_exit \"$?\"' EXIT"));
  assert.ok(controller.includes("trap 'phase_loop_handle_run_signal INT' INT"));
  assert.ok(controller.includes("trap 'phase_loop_handle_run_signal TERM' TERM"));
  assert.match(controller, /Unexpected phase-loop run-once exit; terminalized status/u);
  assert.match(controller, /--owner-pid "\$\{PHASE_LOOP_SUPERVISOR_PID:-\}"/u);
  assert.match(controller, /continuation_required\)\n[\s\S]*write_status "running"[^\n]*"true"/u);
  assert.match(controller, /PHASE_LOOP_DEFERRED_SIGNAL_PENDING=1/gu);
  assert.match(controller, /phase_loop_drain_deferred_signal/gu);
  assert.match(controller, /PHASE_LOOP_DEFERRED_SIGNAL_FILE/gu);
  assert.match(controller, /mv "\$tmp_status" "\$STATUS_FILE"[\s\S]*PHASE_LOOP_STATUS_WRITE_IN_PROGRESS=0[\s\S]*if \[ "\$\{PHASE_LOOP_DEFERRED_SIGNAL_PENDING:-0\}"/u);
  assert.match(controller, /PHASE_LOOP_STATUS_WRITE_IN_PROGRESS=0[\s\S]*if \[ -n "\$force_status_exit_code" \]; then\n    exit "\$force_status_exit_code"/u);
  assert.match(controller, /normalize_stale_running_before_start[\s\S]*write_status "starting"/u);
  assert.match(controller, /SUPERVISOR_OWNER_FILE=/u);
  assert.match(controller, /write_supervisor_owner/gu);
  assert.match(controller, /phase_loop_watch_continuation_liveness/gu);
  assert.match(controller, /PHASE_LOOP_CONTINUATION_WATCHDOG_SECONDS/u);
  assert.match(controller, /--owner-generation/u);
});
