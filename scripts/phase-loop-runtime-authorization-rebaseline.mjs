#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomically(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function runtimeErrorCode(root) {
  return typeof root?.status === 'string'
    ? root.status
    : (typeof root?.error?.code === 'string' ? root.error.code : '');
}

function parsePositiveInteger(raw) {
  if (!/^[0-9]+$/u.test(String(raw))) throw new Error('invalid_rebaseline_cap');
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error('invalid_rebaseline_cap');
  return value;
}

export function rebaselineExpiredRuntimeAuthorization({ storeRoot, stateDir, claimPath, stdoutPath, runStamp, cap }) {
  const normalizedCap = parsePositiveInteger(cap);
  const claim = readJson(claimPath);
  const root = readJson(stdoutPath);
  const claimId = typeof claim?.claim_id === 'string' ? claim.claim_id : '';
  if (!claimId) throw new Error('claim_identity_missing');
  if (runtimeErrorCode(root) !== 'runtime_proposal_apply_approval_expired') {
    return { ok: true, rebaselined: false, reason: 'unrecognized_runtime_error' };
  }
  const priorCount = Number.isSafeInteger(claim.runtime_authorization_rebaseline_count)
    && claim.runtime_authorization_rebaseline_count >= 0
    ? claim.runtime_authorization_rebaseline_count : 0;
  if (priorCount >= normalizedCap) {
    return {
      ok: true,
      rebaselined: false,
      reason: 'runtime_authorization_rebaseline_cap_exhausted',
      claim_id: claimId,
      rebaseline_count: priorCount,
      rebaseline_cap: normalizedCap,
    };
  }
  const claimDigest = sha256(claimId);
  const activeStore = path.join(storeRoot, 'phase-loop-claims', claimDigest);
  if (!fs.statSync(activeStore, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('runtime_claim_store_missing');
  }
  const archiveDir = path.join(storeRoot, 'phase-loop-claim-archives', claimDigest);
  const archiveStore = path.join(archiveDir, `${runStamp}-authorization-expired`);
  if (fs.existsSync(archiveStore)) throw new Error('runtime_authorization_archive_collision');
  const auditPath = path.join(stateDir, 'recovery-audits', `${runStamp}-runtime-authorization-rebaseline.json`);
  const timestamp = new Date().toISOString();
  const audit = {
    schema_version: 1,
    kind: 'phase_loop_runtime_authorization_rebaseline',
    recorded_at: timestamp,
    run_stamp: String(runStamp),
    cause: 'runtime_proposal_apply_approval_expired',
    claim_id: claimId,
    claim_sha256: `sha256:${claimDigest}`,
    rebaseline_count_before: priorCount,
    rebaseline_count_after: priorCount + 1,
    rebaseline_cap: normalizedCap,
    active_store: activeStore,
    archived_store: archiveStore,
    recovery_policy: 'archive_expired_runtime_session_then_require_fresh_run',
  };
  fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  fs.renameSync(activeStore, archiveStore);
  try {
    const updatedClaim = {
      ...claim,
      runtime_authorization_rebaseline_count: priorCount + 1,
      runtime_authorization_rebaseline_pending: true,
      runtime_authorization_rebaseline_audit_path: auditPath,
      runtime_authorization_rebaseline_reason: 'proposal_apply_approval_expired',
      runtime_authorization_rebaseline_updated_at: timestamp,
    };
    writeJsonAtomically(auditPath, audit);
    writeJsonAtomically(claimPath, updatedClaim);
    return {
      ok: true,
      rebaselined: true,
      claim_id: claimId,
      rebaseline_count: priorCount + 1,
      rebaseline_cap: normalizedCap,
      audit_path: auditPath,
      archived_store: archiveStore,
    };
  } catch (error) {
    if (!fs.existsSync(activeStore) && fs.existsSync(archiveStore)) fs.renameSync(archiveStore, activeStore);
    throw error;
  }
}

function readOption(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [command, ...args] = process.argv.slice(2);
  if (command !== 'rebaseline') {
    process.stderr.write('usage: phase-loop-runtime-authorization-rebaseline.mjs rebaseline --store-root <path> --state-dir <path> --claim <path> --stdout <path> --run-stamp <value> --cap <integer>\n');
    process.exit(64);
  }
  try {
    const result = rebaselineExpiredRuntimeAuthorization({
      storeRoot: readOption(args, '--store-root'),
      stateDir: readOption(args, '--state-dir'),
      claimPath: readOption(args, '--claim'),
      stdoutPath: readOption(args, '--stdout'),
      runStamp: readOption(args, '--run-stamp'),
      cap: readOption(args, '--cap'),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error instanceof Error ? error.message : 'runtime_authorization_rebaseline_failed' })}\n`);
    process.exit(78);
  }
}
