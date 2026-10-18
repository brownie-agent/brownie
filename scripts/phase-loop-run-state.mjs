import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function readJsonLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function appendJsonLine(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(handle, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function writeJsonAtomically(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, file);
}

function processIsAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function normalizeStaleRunningStatus({
  stateDir,
  pidFile = path.join(stateDir, 'phase-loop.pid'),
  runStamp,
  now = new Date().toISOString(),
  processExists = processIsAlive
}) {
  const statusPath = path.join(stateDir, 'status.json');
  const auditPath = path.join(stateDir, 'run-state-recovery.jsonl');
  const status = readJson(statusPath);
  if (!status) return { ok: true, normalized: false, reason: 'status_missing' };
  if (status.status !== 'running') return { ok: true, normalized: false, reason: 'status_not_running', status: status.status };

  const referencedPidFile = status.pid_file || pidFile;
  let pid = null;
  try {
    pid = Number.parseInt(fs.readFileSync(referencedPidFile, 'utf8').trim(), 10);
  } catch (error) {
    if (error?.code !== 'ENOENT') return { ok: false, code: 'pid_read_failed', error: error.message };
  }
  if (processExists(pid)) {
    return { ok: false, code: 'run_already_running', pid, run_id: status.run_id ?? null };
  }

  const recoveryId = crypto.randomUUID();
  const previous = { ...status };
  const prepared = {
    schema_version: 1,
    kind: 'phase_loop_run_state_recovery',
    recovery_id: recoveryId,
    phase: 'prepared',
    reason: 'stale_running_pid_missing',
    previous_status: previous,
    pid,
    requested_run_stamp: runStamp ?? null,
    at: now
  };
  try {
    appendJsonLine(auditPath, prepared);
    const replacement = {
      ...status,
      status: 'recovered_stale_running',
      detail: `Recovered stale running status for run_id=${status.run_id ?? '<none>'}; no live phase-loop pid was found. recovery_id=${recoveryId}`,
      exit_code: '78',
      consecutive_failures: Math.max(Number(status.consecutive_failures ?? 0) + 1, 1),
      updated_at: now,
      recovery_id: recoveryId,
      recovery_audit: auditPath
    };
    writeJsonAtomically(statusPath, replacement);
    appendJsonLine(auditPath, { ...prepared, phase: 'applied', replacement_status: replacement, applied_at: now });
    return { ok: true, normalized: true, recovery_id: recoveryId, previous_status: previous, replacement_status: replacement };
  } catch (error) {
    return { ok: false, code: 'stale_running_recovery_failed', recovery_id: recoveryId, error: error.message };
  }
}

// Recovery is deliberately reversible for audit and operator correction. The
// guard prevents an old recovery record from restoring a newer status.
export function rollbackStaleRunningRecovery({ stateDir, recoveryId, now = new Date().toISOString() }) {
  const statusPath = path.join(stateDir, 'status.json');
  const auditPath = path.join(stateDir, 'run-state-recovery.jsonl');
  const status = readJson(statusPath);
  if (!status) return { ok: false, code: 'status_missing' };
  if (status.status !== 'recovered_stale_running' || status.recovery_id !== recoveryId) {
    return { ok: false, code: 'recovery_not_current' };
  }
  const applied = readJsonLines(auditPath).find((record) => (
    record?.phase === 'applied' && record?.recovery_id === recoveryId && record?.previous_status
  ));
  if (!applied) return { ok: false, code: 'recovery_audit_missing' };
  const restored = {
    ...applied.previous_status,
    recovery_rollback_id: recoveryId,
    recovery_rolled_back_at: now
  };
  try {
    writeJsonAtomically(statusPath, restored);
    appendJsonLine(auditPath, {
      schema_version: 1,
      kind: 'phase_loop_run_state_recovery',
      recovery_id: recoveryId,
      phase: 'rolled_back',
      restored_status: restored,
      at: now
    });
  } catch (error) {
    return { ok: false, code: 'recovery_rollback_failed', error: error.message };
  }
  return { ok: true, rolled_back: true, restored_status: restored };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname) && ['normalize-stale-running', 'rollback-stale-running'].includes(process.argv[2])) {
  const args = new Map(process.argv.slice(3).reduce((pairs, value, index, values) => (
    value.startsWith('--') ? [...pairs, [value.slice(2), values[index + 1]]] : pairs
  ), []));
  const stateDir = args.get('state-dir');
  if (!stateDir) process.exit(2);
  const result = process.argv[2] === 'rollback-stale-running'
    ? rollbackStaleRunningRecovery({ stateDir, recoveryId: args.get('recovery-id') })
    : normalizeStaleRunningStatus({
      stateDir,
      pidFile: args.get('pid-file') || path.join(stateDir, 'phase-loop.pid'),
      runStamp: args.get('run-stamp')
    });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exit(result.code === 'run_already_running' ? 75 : 78);
}
