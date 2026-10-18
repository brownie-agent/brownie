import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeStaleRunningStatus, rollbackStaleRunningRecovery } from './phase-loop-run-state.mjs';

function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-run-state-'));
  fs.mkdirSync(stateDir, { recursive: true });
  return { stateDir, statusPath: path.join(stateDir, 'status.json'), pidPath: path.join(stateDir, 'phase-loop.pid') };
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
  fs.writeFileSync(statusPath, JSON.stringify({ status: 'running', run_id: 'live-run', pid_file: pidPath }));
  fs.writeFileSync(pidPath, '1234');
  const result = normalizeStaleRunningStatus({ stateDir, pidFile: pidPath, processExists: () => true });
  assert.deepEqual(result, { ok: false, code: 'run_already_running', pid: 1234, run_id: 'live-run' });
  assert.equal(JSON.parse(fs.readFileSync(statusPath, 'utf8')).status, 'running');
  assert.equal(fs.existsSync(path.join(stateDir, 'run-state-recovery.jsonl')), false);
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

test('run-once installs exit and signal terminalization hooks after entering running state', () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const controller = fs.readFileSync(path.join(repoRoot, 'phase-loop.sh'), 'utf8');
  assert.ok(controller.includes("trap 'phase_loop_finalize_unexpected_exit \"$?\"' EXIT"));
  assert.ok(controller.includes("trap 'phase_loop_handle_run_signal INT' INT"));
  assert.ok(controller.includes("trap 'phase_loop_handle_run_signal TERM' TERM"));
  assert.match(controller, /Unexpected phase-loop run-once exit; terminalized status/u);
});
