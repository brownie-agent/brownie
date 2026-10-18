import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
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

function processCommand(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function liveSupervisorPids(rootDir) {
  let output = '';
  try {
    output = execFileSync('ps', ['-axo', 'pid=', '-o', 'command='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  return output.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/u);
    if (!match || !match[2].includes('phase-loop.sh') || !match[2].includes(' supervise')) return [];
    if (rootDir && !match[2].includes(rootDir)) return [];
    return [Number.parseInt(match[1], 10)];
  });
}

function readPid(file) {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function readOwner(ownerFile) {
  return readJson(ownerFile) || null;
}

function ownerMatches({ status, pid, owner, ownerPid, ownerGeneration, rootDir, ownerRootDir }) {
  if (!status || !owner || !pid) return false;
  if (status.supervisor_pid !== pid || owner.pid !== pid) return false;
  if (!status.supervisor_generation || status.supervisor_generation !== owner.generation) return false;
  if (!rootDir || !ownerRootDir || rootDir !== ownerRootDir) return false;
  if (Number.isInteger(ownerPid) && ownerPid !== pid) return false;
  if (ownerGeneration && ownerGeneration !== owner.generation) return false;
  return true;
}

export function inspectSupervisorOwnership({
  stateDir,
  pidFile = path.join(stateDir, 'phase-loop.pid'),
  ownerFile = path.join(stateDir, 'phase-loop-owner.json'),
  rootDir = '',
  ownerPid = null,
  ownerGeneration = null,
  processExists = (pid) => processIsAlive(pid),
  getProcessCommand = processCommand,
  listSupervisors = () => liveSupervisorPids(rootDir)
}) {
  const status = readJson(path.join(stateDir, 'status.json'));
  const pid = readPid(pidFile);
  const owner = readOwner(ownerFile);
  const livePid = pid && processExists(pid);
  const canonicalizeRoot = (value) => {
    if (!value) return '';
    try {
      return fs.realpathSync.native(value);
    } catch {
      return path.resolve(value);
    }
  };
  const canonicalRootDir = canonicalizeRoot(rootDir);
  const canonicalOwnerRootDir = canonicalizeRoot(owner?.root_dir);
  const matchingOwner = ownerMatches({
    status,
    pid,
    owner,
    ownerPid,
    ownerGeneration,
    rootDir: canonicalRootDir,
    ownerRootDir: canonicalOwnerRootDir
  });
  const command = livePid
    ? (getProcessCommand === processCommand ? processCommand(pid) : getProcessCommand(pid))
    : '';
  const commandScriptPath = canonicalRootDir === '/' ? '/phase-loop.sh' : `${canonicalRootDir}/phase-loop.sh`;
  const commandLooksLikeSupervisor = Boolean(
    canonicalRootDir
    && command.includes(commandScriptPath)
    && /phase-loop\.sh.*\bsupervise\b/u.test(command)
  );
  const supervisors = [...new Set(listSupervisors().filter((candidate) => Number.isInteger(candidate) && candidate > 1))];
  const liveSupervisors = supervisors.filter((candidate) => processExists(candidate));
  return {
    status,
    pid,
    owner,
    live_pid: livePid ? pid : null,
    matching_owner: matchingOwner,
    command,
    command_looks_like_supervisor: commandLooksLikeSupervisor,
    live_supervisors: liveSupervisors,
    ownership_ok: Boolean(livePid && matchingOwner && commandLooksLikeSupervisor)
  };
}

export function normalizeStaleRunningStatus({
  stateDir,
  pidFile = path.join(stateDir, 'phase-loop.pid'),
  runStamp,
  ownerPid = null,
  ownerGeneration = null,
  ownerFile = path.join(stateDir, 'phase-loop-owner.json'),
  rootDir = '',
  now = new Date().toISOString(),
  processExists = (pid) => processIsAlive(pid),
  getProcessCommand = processCommand,
  listSupervisors = () => liveSupervisorPids(rootDir)
}) {
  const statusPath = path.join(stateDir, 'status.json');
  const auditPath = path.join(stateDir, 'run-state-recovery.jsonl');
  const status = readJson(statusPath);
  if (!status) return { ok: true, normalized: false, reason: 'status_missing' };
  if (status.status !== 'running') return { ok: true, normalized: false, reason: 'status_not_running', status: status.status };

  const referencedPidFile = status.pid_file || pidFile;
  let pid = null;
  try {
    pid = readPid(referencedPidFile);
  } catch (error) {
    if (error?.code !== 'ENOENT') return { ok: false, code: 'pid_read_failed', error: error.message };
  }
  const ownership = inspectSupervisorOwnership({
    stateDir,
    pidFile: referencedPidFile,
    ownerFile,
    rootDir,
    ownerPid,
    ownerGeneration,
    processExists,
    getProcessCommand,
    listSupervisors
  });
  if (ownership.ownership_ok) {
    if (
      status.continuation_required === true
      && status.controller_action === 'resume'
    ) {
      return { ok: true, normalized: false, reason: 'owned_continuation_resume', pid, run_id: status.run_id ?? null, generation: ownership.owner.generation };
    }
    return { ok: false, code: 'run_already_running', pid, run_id: status.run_id ?? null };
  }
  if (ownership.live_supervisors.length > 0 || ownership.live_pid) {
    return {
      ok: false,
      code: 'supervisor_ownership_conflict',
      pid,
      run_id: status.run_id ?? null,
      status_pid: status.supervisor_pid ?? null,
      status_generation: status.supervisor_generation ?? null,
      owner_pid: ownership.owner?.pid ?? null,
      owner_generation: ownership.owner?.generation ?? null,
      live_supervisors: ownership.live_supervisors
    };
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

export function watchdogContinuationLiveness({
  stateDir,
  pidFile = path.join(stateDir, 'phase-loop.pid'),
  ownerFile = path.join(stateDir, 'phase-loop-owner.json'),
  rootDir = '',
  maxAgeSeconds = 900,
  now = new Date().toISOString(),
  runStamp = null,
  processExists = (pid) => processIsAlive(pid),
  getProcessCommand = processCommand,
  listSupervisors = () => liveSupervisorPids(rootDir)
}) {
  const statusPath = path.join(stateDir, 'status.json');
  const auditPath = path.join(stateDir, 'run-state-recovery.jsonl');
  const status = readJson(statusPath);
  if (!status || status.continuation_required !== true || status.controller_action !== 'resume') {
    return { ok: true, expired: false, reason: 'continuation_not_pending' };
  }
  const updatedAt = Date.parse(status.updated_at || '');
  const nowMs = Date.parse(now);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(nowMs)) {
    return { ok: false, code: 'continuation_timestamp_invalid', run_id: status.run_id ?? null };
  }
  const ageSeconds = Math.max(0, Math.floor((nowMs - updatedAt) / 1000));
  if (ageSeconds < Number(maxAgeSeconds)) {
    return { ok: true, expired: false, age_seconds: ageSeconds, reason: 'continuation_within_deadline' };
  }
  const ownership = inspectSupervisorOwnership({
    stateDir,
    pidFile,
    ownerFile,
    rootDir,
    processExists,
    getProcessCommand,
    listSupervisors
  });
  if (!ownership.matching_owner
    || (ownership.live_pid && !ownership.command_looks_like_supervisor)
    || ownership.live_supervisors.some((pid) => pid !== ownership.pid)) {
    return {
      ok: false,
      code: 'continuation_ownership_unproven',
      age_seconds: ageSeconds,
      run_id: status.run_id ?? null,
      live_supervisors: ownership.live_supervisors,
      pid: ownership.pid,
      status_generation: status.supervisor_generation ?? null,
      owner_generation: ownership.owner?.generation ?? null
    };
  }
  const recoveryId = crypto.randomUUID();
  const previous = { ...status };
  const replacement = {
    ...status,
    status: 'blocked',
    detail: `Continuation resume watchdog expired after ${ageSeconds}s; terminalized for audited redelegation. recovery_id=${recoveryId}`,
    exit_code: '78',
    continuation_required: false,
    controller_action: 'stop',
    stop_class: 'terminal_failure',
    stop_reason: 'continuation_watchdog_expired',
    recovery_id: recoveryId,
    recovery_audit: auditPath,
    updated_at: now
  };
  const prepared = {
    schema_version: 1,
    kind: 'phase_loop_continuation_watchdog',
    recovery_id: recoveryId,
    phase: 'prepared',
    reason: 'continuation_watchdog_expired',
    previous_status: previous,
    replacement_status: replacement,
    age_seconds: ageSeconds,
    requested_run_stamp: runStamp,
    at: now
  };
  try {
    appendJsonLine(auditPath, prepared);
    writeJsonAtomically(statusPath, replacement);
    appendJsonLine(auditPath, { ...prepared, phase: 'applied', applied_at: now });
  } catch (error) {
    return { ok: false, code: 'continuation_watchdog_apply_failed', recovery_id: recoveryId, error: error.message };
  }
  return { ok: true, expired: true, redelegate: true, recovery_id: recoveryId, age_seconds: ageSeconds, owner_pid: ownership.pid, run_id: status.run_id ?? null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname) && ['normalize-stale-running', 'rollback-stale-running', 'watch-continuation'].includes(process.argv[2])) {
  const args = new Map(process.argv.slice(3).reduce((pairs, value, index, values) => (
    value.startsWith('--') ? [...pairs, [value.slice(2), values[index + 1]]] : pairs
  ), []));
  const stateDir = args.get('state-dir');
  if (!stateDir) process.exit(2);
  const result = process.argv[2] === 'rollback-stale-running'
    ? rollbackStaleRunningRecovery({ stateDir, recoveryId: args.get('recovery-id') })
    : process.argv[2] === 'watch-continuation'
      ? watchdogContinuationLiveness({
        stateDir,
        pidFile: args.get('pid-file') || path.join(stateDir, 'phase-loop.pid'),
        ownerFile: args.get('owner-file') || path.join(stateDir, 'phase-loop-owner.json'),
        rootDir: args.get('root-dir') || '',
        maxAgeSeconds: Number.parseInt(args.get('max-age-seconds') || '900', 10),
        runStamp: args.get('run-stamp')
      })
      : normalizeStaleRunningStatus({
      stateDir,
      pidFile: args.get('pid-file') || path.join(stateDir, 'phase-loop.pid'),
      ownerPid: args.has('owner-pid') ? Number.parseInt(args.get('owner-pid'), 10) : null,
      ownerGeneration: args.get('owner-generation') || null,
      ownerFile: args.get('owner-file') || path.join(stateDir, 'phase-loop-owner.json'),
      rootDir: args.get('root-dir') || '',
      runStamp: args.get('run-stamp')
    });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exit(result.code === 'run_already_running' || result.code === 'supervisor_ownership_conflict' || result.code === 'continuation_ownership_unproven' ? 75 : 78);
}
