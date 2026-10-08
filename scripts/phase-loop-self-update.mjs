#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { diagnosePhaseLoop } from './phase-loop-supervisor-diagnose.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRepoRoot = path.resolve(__dirname, '..');
const maxRequestBytes = 12_000;
const maxAttemptsPerFingerprint = 3;
const retryBaseDelayMs = 60_000;
const retryMaxDelayMs = 30 * 60_000;

function parseArgs(argv) {
  const args = { repo: defaultRepoRoot, dispatch: false, request: null };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') args.repo = path.resolve(argv[++index]);
    else if (arg === '--dispatch') args.dispatch = true;
    else if (arg === '--request') args.request = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function gitDirtyFiles(repoRoot, run = spawnSync) {
  const result = run('git', ['status', '--porcelain=v1'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  if (result.status !== 0) return { ok: false, files: [] };
  return {
    ok: true,
    files: result.stdout.split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3))
  };
}

function requestFailure(reason, extra = {}) {
  return { eligible: false, reason, ...extra };
}

function selfUpdateStatePath(repoRoot) {
  return path.join(repoRoot, '.brownie/private/phase-loop/self-update/retry-state.json');
}

function selfUpdateFingerprint({ request, eligibility }) {
  const payload = JSON.stringify({
    request: request.trim(),
    status: eligibility.diagnostic?.phase_loop?.status ?? null,
    issue_codes: (eligibility.diagnostic?.issues ?? []).map((issue) => issue.code).sort()
  });
  return `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`;
}

function retryDelayMs(failedAttempts) {
  return Math.min(retryBaseDelayMs * (2 ** Math.max(0, failedAttempts - 1)), retryMaxDelayMs);
}

function readRetryState(repoRoot) {
  const state = readJson(selfUpdateStatePath(repoRoot));
  return state && state.schema_version === 1 && typeof state.fingerprints === 'object'
    ? state
    : { schema_version: 1, kind: 'brownie_phase_loop_self_update_retry_state', fingerprints: {} };
}

function retryDecision({ repoRoot, request, eligibility, now }) {
  const state = readRetryState(repoRoot);
  const fingerprint = selfUpdateFingerprint({ request, eligibility });
  const entry = state.fingerprints[fingerprint] ?? null;
  const currentTime = now().getTime();
  if (!entry || entry.status !== 'failed') return { allowed: true, fingerprint, state, entry };
  if (entry.failed_attempts >= maxAttemptsPerFingerprint) {
    return { allowed: false, reason: 'self_update_retry_budget_exhausted', fingerprint, state, entry, max_attempts: maxAttemptsPerFingerprint };
  }
  const retryAfter = Date.parse(entry.retry_after ?? '');
  if (Number.isFinite(retryAfter) && currentTime < retryAfter) {
    return { allowed: false, reason: 'self_update_retry_backoff_active', fingerprint, state, entry, retry_after: entry.retry_after };
  }
  return { allowed: true, fingerprint, state, entry };
}

function persistRetryState(repoRoot, state) {
  writeAtomically(selfUpdateStatePath(repoRoot), `${JSON.stringify(state, null, 2)}\n`);
}

export function evaluateSelfUpdateEligibility({ repoRoot, request, run = spawnSync }) {
  if (typeof request !== 'string' || request.trim().length === 0) {
    return requestFailure('self_update_request_missing');
  }
  if (Buffer.byteLength(request, 'utf8') > maxRequestBytes) {
    return requestFailure('self_update_request_too_large', { max_request_bytes: maxRequestBytes });
  }

  const diagnostic = diagnosePhaseLoop({ repoRoot, write: false });
  const status = diagnostic.phase_loop?.status;
  const running = diagnostic.phase_loop?.running === true;
  if (running || !['no_progress', 'blocked', 'stopped'].includes(status)) {
    return requestFailure('phase_loop_not_stopped_for_self_update', { status, running, diagnostic });
  }

  const dirty = gitDirtyFiles(repoRoot, run);
  if (!dirty.ok) return requestFailure('git_status_unavailable', { diagnostic });
  const nonBrownieDirtyFiles = dirty.files.filter((file) => !file.startsWith('.brownie/'));
  if (nonBrownieDirtyFiles.length > 0) {
    return requestFailure('non_brownie_workspace_changes_present', { non_brownie_dirty_files: nonBrownieDirtyFiles, diagnostic });
  }

  const brownieBin = process.env.BROWNIE_BIN || path.join(repoRoot, 'target/debug/brownie');
  if (!fs.existsSync(brownieBin)) return requestFailure('brownie_binary_missing', { brownie_bin: brownieBin, diagnostic });

  return {
    eligible: true,
    brownie_bin: brownieBin,
    dirty_brownie_files: dirty.files,
    diagnostic
  };
}

export function buildSelfUpdateObjective({ request, eligibility }) {
  const issueCodes = (eligibility.diagnostic?.issues ?? []).map((issue) => issue.code).join(', ') || 'none';
  const status = eligibility.diagnostic?.phase_loop?.status ?? 'unknown';
  return `# Brownie controller self-update recovery\n\nYou are the dedicated Brownie recovery implementer. The normal phase loop is stopped; do not restart it and do not edit .brownie/todo.md or .brownie/todo-breakdown.md.\n\n## Observed controller state\n\n- status: ${status}\n- diagnostic issue codes: ${issueCodes}\n- preserved Brownie state files: ${(eligibility.dirty_brownie_files ?? []).join(', ') || '<none>'}\n\n## Recovery request\n\n${request.trim()}\n\n## Required outcome\n\n1. Implement only the minimum controller/runtime change that removes the diagnosed contradiction.\n2. Add a regression test that proves the recovery path works and retain the denial test for the unsafe path.\n3. Run the smallest relevant tests and report exact commands/results.\n4. Do not stage, overwrite, revert, or delete pre-existing .brownie/ changes.\n5. Do not restart the normal phase loop. Finish with a concise summary suitable for a brownie-agent-authored PR.\n`;
}

function writeAtomically(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

export function dispatchSelfUpdate({ repoRoot, request, run = spawnSync, now = () => new Date() }) {
  const eligibility = evaluateSelfUpdateEligibility({ repoRoot, request, run });
  if (!eligibility.eligible) return { dispatched: false, eligibility };
  const retry = retryDecision({ repoRoot, request, eligibility, now });
  if (!retry.allowed) {
    return {
      dispatched: false,
      eligibility,
      retry: {
        allowed: false,
        reason: retry.reason,
        fingerprint: retry.fingerprint,
        retry_after: retry.retry_after ?? null,
        failed_attempts: retry.entry?.failed_attempts ?? 0,
        max_attempts: retry.max_attempts ?? maxAttemptsPerFingerprint
      }
    };
  }

  const stamp = now().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  const stateDir = path.join(repoRoot, '.brownie/private/phase-loop/self-update');
  const objectivePath = path.join(stateDir, `${stamp}.objective.md`);
  const resultPath = path.join(stateDir, `${stamp}.result.json`);
  const objective = buildSelfUpdateObjective({ request, eligibility });
  writeAtomically(objectivePath, objective);

  const result = run(eligibility.brownie_bin, ['--json', 'run', '--file', objectivePath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, PHASE_LOOP_SELF_UPDATE_ACTIVE: '1' }
  });
  const record = {
    schema_version: 1,
    kind: 'brownie_phase_loop_self_update_dispatch',
    dispatched_at: now().toISOString(),
    objective_path: path.relative(repoRoot, objectivePath),
    exit_code: result.status,
    signal: result.signal ?? null,
    stdout: String(result.stdout ?? '').slice(-12_000),
    stderr: String(result.stderr ?? '').slice(-12_000),
    dirty_brownie_files_preserved: eligibility.dirty_brownie_files
  };
  writeAtomically(resultPath, `${JSON.stringify(record, null, 2)}\n`);
  const previousFailures = retry.entry?.failed_attempts ?? 0;
  const failedAttempts = result.status === 0 ? 0 : previousFailures + 1;
  const nextRetryAt = result.status === 0
    ? null
    : new Date(now().getTime() + retryDelayMs(failedAttempts)).toISOString();
  retry.state.fingerprints[retry.fingerprint] = {
    fingerprint: retry.fingerprint,
    status: result.status === 0 ? 'succeeded' : 'failed',
    request_sha256: crypto.createHash('sha256').update(request.trim()).digest('hex'),
    failed_attempts: failedAttempts,
    max_attempts: maxAttemptsPerFingerprint,
    last_attempt_at: record.dispatched_at,
    retry_after: nextRetryAt,
    last_result_path: path.relative(repoRoot, resultPath),
    last_exit_code: result.status,
    exhausted: result.status !== 0 && failedAttempts >= maxAttemptsPerFingerprint
  };
  persistRetryState(repoRoot, retry.state);
  return {
    dispatched: true,
    ok: result.status === 0,
    objective_path: record.objective_path,
    result_path: path.relative(repoRoot, resultPath),
    exit_code: result.status,
    retry: {
      fingerprint: retry.fingerprint,
      failed_attempts: failedAttempts,
      max_attempts: maxAttemptsPerFingerprint,
      retry_after: nextRetryAt,
      exhausted: result.status !== 0 && failedAttempts >= maxAttemptsPerFingerprint
    },
    diagnostic: eligibility.diagnostic
  };
}

if (process.argv[1] === __filename) {
  const args = parseArgs(process.argv);
  const result = args.dispatch
    ? dispatchSelfUpdate({ repoRoot: args.repo, request: args.request })
    : { dispatched: false, eligibility: evaluateSelfUpdateEligibility({ repoRoot: args.repo, request: args.request }) };
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.dispatched && result.ok === false ? 1 : result.eligibility?.eligible === false ? 2 : 0);
}
