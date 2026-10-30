#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildContractRebaselineReceipt,
  readContractRebaselineRecords,
  writeContractRebaselineReceipt
} from './phase-loop-todo-contract-rebaseline.mjs';

const repositoryRoot = path.resolve(new URL('..', import.meta.url).pathname);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    args[value.slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256Text(value) {
  return sha256Buffer(Buffer.from(value, 'utf8'));
}

function sha256File(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? sha256Buffer(fs.readFileSync(filePath))
    : null;
}

function atomicWrite(filePath, content, mode = 0o600) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, content, { encoding: 'utf8', mode });
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, mode);
}

function writeJson(filePath, value) {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
  fs.chmodSync(filePath, 0o600);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function isReparableDecompositionDiagnostic(diagnostic) {
  const text = String(diagnostic ?? '');
  if (!text.includes('guard-todo-decomposition.mjs')
    && !text.includes('phase-loop-todo-queue-integrity.mjs')
    && !text.includes('contract_unsatisfiable_dirty_scope')) {
    return false;
  }
  return /Create only target already exists|TODO dependencies must not contain cycles|dependency .* present only in the breakdown ledger|abstract\/decomposed parent|superseded parent|dangling dependency|todo-replan|contract_unsatisfiable_dirty_scope/iu.test(text);
}

export function targetScopes(firstLine) {
  const line = String(firstLine ?? '');
  const operationStarts = [...line.matchAll(/\b(Patch|Create) only\s+/gu)];
  const scopes = [];
  for (const [index, operationMatch] of operationStarts.entries()) {
    const start = operationMatch.index + operationMatch[0].length;
    const nextOperation = operationStarts[index + 1]?.index ?? line.length;
    const clause = line.slice(start, nextOperation)
      // A lower-case "then patch only" starts the ancillary invocation
      // clause; it is not one of the bounded implementation targets.
      .split(/,?\s+then\s+(?:patch|create) only\b/u)[0];
    for (const pathMatch of clause.matchAll(/`([^`]+)`/gu)) {
      scopes.push({ operation: operationMatch[1], path: pathMatch[1] });
    }
  }
  return scopes;
}

function allUncheckedTargetScopes(todoText) {
  const byPath = new Map();
  for (const block of todoBlocks(todoText)) {
    for (const scope of targetScopes(block.split('\n')[0] ?? '')) {
      const existing = byPath.get(scope.path);
      if (existing && existing.operation !== scope.operation) {
        throw new Error(`TODO queue declares conflicting operations for target: ${scope.path}`);
      }
      byPath.set(scope.path, scope);
    }
  }
  return [...byPath.values()];
}

function todoBlocks(todoText) {
  const starts = [...todoText.matchAll(/^(?:[-*]|\d+[.)])\s+\[\s\]\s+/gmu)].map((match) => match.index);
  return starts.map((start, index) => todoText.slice(start, starts[index + 1] ?? todoText.length).trim());
}

function todoId(block) {
  return String(block ?? '').split('\n')[0]
    .trim()
    .replace(/^(?:[-*]|\d+[.)])\s+\[\s\]\s+/u, '')
    .split(':')[0]
    ?.trim() ?? '';
}

function safeRelativePath(repo, filePath) {
  const relative = path.relative(repo, path.resolve(repo, filePath));
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/')
    : null;
}

function gitOutput(repo, args) {
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024
  });
  return result.status === 0 ? result.stdout : null;
}

function gitRevision(repo, ref) {
  const output = gitOutput(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
  const revision = output?.trim() ?? '';
  return /^[0-9a-f]{40}$/iu.test(revision) ? revision : null;
}

function gitFileAtRevision(repo, revision, relativePath) {
  return gitOutput(repo, ['show', `${revision}:${relativePath}`]);
}

function targetPreimagePath(recoveryDir, relativePath) {
  return path.join(recoveryDir, 'target-preimages', `${sha256Text(relativePath)}.before`);
}

function recoveryHasEffectiveMutation(record) {
  if (typeof record?.contract_rebaseline_receipt === 'string' && record.contract_rebaseline_receipt) return true;
  if (Array.isArray(record?.placeholder_target_restorations) && record.placeholder_target_restorations.length > 0) return true;
  if (record?.before?.todo_sha256 && Object.hasOwn(record?.after ?? {}, 'todo_sha256') && record.before.todo_sha256 !== record.after.todo_sha256) return true;
  if (Object.hasOwn(record?.before ?? {}, 'breakdown_sha256')
    && Object.hasOwn(record?.after ?? {}, 'breakdown_sha256')
    && record.before.breakdown_sha256 !== record.after.breakdown_sha256) return true;
  return Array.isArray(record?.target_snapshot) && record.target_snapshot.some((target) => (
    target.exists_before !== target.exists_after || target.sha256_before !== target.sha256_after
  ));
}

function isLegacyNoopAppliedRecovery(record, diagnostic) {
  return record?.status === 'applied'
    && String(diagnostic).includes('contract_unsatisfiable_dirty_scope')
    && !recoveryHasEffectiveMutation(record);
}

function restoreTargetPreimages(repo, recoveryDir, restorations) {
  const errors = [];
  for (const restoration of [...restorations].reverse()) {
    try {
      const relativePath = safeRelativePath(repo, restoration.path);
      if (!relativePath) {
        throw new Error('target path is outside the repository');
      }
      const targetPath = path.resolve(repo, relativePath);
      const expectedSnapshotPath = targetPreimagePath(recoveryDir, relativePath);
      const snapshotPath = path.resolve(repo, restoration.preimage_path);
      if (snapshotPath !== expectedSnapshotPath) {
        throw new Error('target preimage path does not match the recovery record target');
      }
      const content = fs.readFileSync(snapshotPath, 'utf8');
      const originalMode = Number.isInteger(restoration.original_mode) ? restoration.original_mode : 0o600;
      atomicWrite(targetPath, content, originalMode);
    } catch (error) {
      errors.push(`${restoration.path}: ${String(error?.message ?? error)}`);
    }
  }
  return errors;
}

function verifyPersistedTargetRestorations({ repo, recoveryDir, restorations, baselineRef }) {
  if (!Array.isArray(restorations) || restorations.length === 0) {
    return { applied: false, reason: 'persisted_target_restorations_missing', restorations: [], errors: [] };
  }
  if (typeof baselineRef !== 'string' || baselineRef.trim() === '') {
    return { applied: false, reason: 'approved_baseline_missing', restorations, errors: [] };
  }
  const baselineCommit = gitRevision(repo, baselineRef);
  if (!baselineCommit) {
    return { applied: false, reason: 'approved_baseline_unresolvable', restorations, errors: [] };
  }

  const errors = [];
  for (const restoration of restorations) {
    const relativePath = safeRelativePath(repo, restoration.path);
    if (!relativePath) {
      errors.push(`${String(restoration.path)}: target path is outside the repository`);
      continue;
    }
    const targetPath = path.resolve(repo, relativePath);
    const expectedSnapshotPath = targetPreimagePath(recoveryDir, relativePath);
    const snapshotPath = path.resolve(repo, restoration.preimage_path);
    if (snapshotPath !== expectedSnapshotPath || !fs.existsSync(snapshotPath)) {
      errors.push(`${relativePath}: recorded target preimage is missing or does not match its target`);
      continue;
    }
    const targetSha256 = sha256File(targetPath);
    if (!targetSha256 || targetSha256 !== restoration.restored_sha256) {
      errors.push(`${relativePath}: restored target digest no longer matches the recovery record`);
      continue;
    }
    if (sha256File(snapshotPath) !== restoration.observed_sha256) {
      errors.push(`${relativePath}: target preimage digest no longer matches the recovery record`);
      continue;
    }
    const targetContent = fs.readFileSync(targetPath, 'utf8');
    const headContent = gitFileAtRevision(repo, 'HEAD', relativePath);
    const baselineContent = gitFileAtRevision(repo, baselineCommit, relativePath);
    if (headContent === null || baselineContent === null) {
      errors.push(`${relativePath}: checked-out or selected baseline does not contain the restored target`);
      continue;
    }
    if (isBoundedProposalPlaceholder(targetContent)) {
      errors.push(`${relativePath}: persisted restoration still contains a bounded placeholder`);
      continue;
    }
    if (headContent !== targetContent || baselineContent !== targetContent) {
      errors.push(`${relativePath}: restored target no longer matches both checked-out and selected baseline content`);
    }
  }
  return {
    applied: errors.length === 0,
    reason: errors.length === 0 ? 'persisted_target_restorations_verified' : 'persisted_target_restorations_invalid',
    restorations,
    resumed: true,
    errors
  };
}

function restoreExactBoundedPatchPlaceholders({ repo, recoveryDir, targetSnapshot, baselineRef }) {
  const candidates = [];
  const errors = [];
  for (const target of targetSnapshot.filter((entry) => entry.operation === 'Patch')) {
    const relativePath = safeRelativePath(repo, target.path);
    if (!relativePath) continue;
    const targetPath = path.join(repo, relativePath);
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) continue;
    const observedContent = fs.readFileSync(targetPath, 'utf8');
    if (!isBoundedProposalPlaceholder(observedContent)) continue;
    const observedSha256 = sha256Text(observedContent);
    if (target.sha256_before && target.sha256_before !== observedSha256) {
      errors.push(`${relativePath}: observed placeholder digest no longer matches the recovery snapshot`);
      continue;
    }
    candidates.push({
      relativePath,
      targetPath,
      observedContent,
      observedSha256,
      originalMode: fs.statSync(targetPath).mode & 0o777
    });
  }

  if (candidates.length === 0) {
    return { applied: false, reason: 'no_exact_bounded_patch_placeholder', restorations: [] };
  }
  if (typeof baselineRef !== 'string' || baselineRef.trim() === '') {
    return { applied: false, reason: 'approved_baseline_missing', restorations: [], errors };
  }
  const baselineCommit = gitRevision(repo, baselineRef);
  if (!baselineCommit) {
    return { applied: false, reason: 'approved_baseline_unresolvable', restorations: [], errors };
  }

  for (const candidate of candidates) {
    const headContent = gitFileAtRevision(repo, 'HEAD', candidate.relativePath);
    const baselineContent = gitFileAtRevision(repo, baselineCommit, candidate.relativePath);
    if (headContent === null || baselineContent === null) {
      errors.push(`${candidate.relativePath}: approved baseline does not contain a tracked recovery target`);
      continue;
    }
    if (headContent !== baselineContent) {
      errors.push(`${candidate.relativePath}: approved baseline content diverges from the checked-out source baseline`);
      continue;
    }
    if (isBoundedProposalPlaceholder(baselineContent)) {
      errors.push(`${candidate.relativePath}: approved baseline is itself a bounded placeholder`);
      continue;
    }
    candidate.baselineContent = baselineContent;
  }
  if (errors.length > 0) {
    return { applied: false, reason: 'approved_baseline_not_safe_for_placeholder_restore', restorations: [], errors };
  }

  const restorations = [];
  try {
    for (const candidate of candidates) {
      const preimagePath = targetPreimagePath(recoveryDir, candidate.relativePath);
      fs.mkdirSync(path.dirname(preimagePath), { recursive: true, mode: 0o700 });
      if (fs.existsSync(preimagePath)) {
        if (fs.readFileSync(preimagePath, 'utf8') !== candidate.observedContent) {
          throw new Error(`${candidate.relativePath}: existing target preimage does not match the exact placeholder`);
        }
      } else {
        atomicWrite(preimagePath, candidate.observedContent);
      }
      atomicWrite(candidate.targetPath, candidate.baselineContent, candidate.originalMode);
      if (fs.readFileSync(candidate.targetPath, 'utf8') !== candidate.baselineContent) {
        throw new Error(`${candidate.relativePath}: restored target verification failed`);
      }
      restorations.push({
        path: candidate.relativePath,
        mode: 'exact_bounded_patch_placeholder_to_approved_baseline',
        observed_sha256: candidate.observedSha256,
        restored_sha256: sha256Text(candidate.baselineContent),
        approved_baseline_ref: baselineRef,
        approved_baseline_commit: baselineCommit,
        preimage_path: safeRelativePath(repo, preimagePath),
        original_mode: candidate.originalMode,
        restored_at: new Date().toISOString()
      });
    }
  } catch (error) {
    const rollbackErrors = restoreTargetPreimages(repo, recoveryDir, restorations);
    return {
      applied: false,
      reason: 'placeholder_restore_failed',
      restorations: [],
      errors: [String(error?.message ?? error), ...rollbackErrors]
    };
  }
  return { applied: true, reason: 'exact_bounded_patch_placeholder_restored', restorations, errors: [] };
}

function legacyAppliedRecoveryRecords(stateDir) {
  const directory = path.join(stateDir, 'preclaim-recovery');
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const recordPath = path.join(directory, entry.name, 'record.json');
        const record = readJson(recordPath);
        return record.status === 'applied' ? { recordPath, record } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isBoundedProposalPlaceholder(content) {
  return String(content ?? '') === '// Brownie bounded Patch-only proposal.\n'
    || String(content ?? '') === '// Brownie bounded Create-only proposal.\n';
}

function migrateLegacyTargetCapture({ repo, stateDir, todoPath, breakdownPath, todoText, runStamp, diagnostic }) {
  if (!String(diagnostic).includes('contract_unsatisfiable_dirty_scope')) return false;
  const liveBlocks = new Map(todoBlocks(todoText).map((block) => [todoId(block), block]));
  const existingReceipts = readContractRebaselineRecords(repo);
  for (const { recordPath, record } of legacyAppliedRecoveryRecords(stateDir)) {
    const receiptRelative = safeRelativePath(repo, record.contract_rebaseline_receipt ?? '');
    const beforeRelative = safeRelativePath(repo, record.rollback_snapshot?.todo ?? '');
    if (!receiptRelative || !beforeRelative) continue;
    const receiptPath = path.join(repo, receiptRelative);
    const beforePath = path.join(repo, beforeRelative);
    if (!fs.existsSync(receiptPath) || !fs.existsSync(beforePath)) continue;
    const sourceReceipt = readJson(receiptPath);
    for (const [id, block] of liveBlocks) {
      const firstLine = block.split('\n')[0] ?? '';
      const change = sourceReceipt.contract_changes?.find((entry) => entry?.todo_id === id && entry?.after_contract?.first_line === firstLine);
      if (!change) continue;
      for (const scope of targetScopes(firstLine).filter((entry) => entry.operation === 'Patch')) {
        // A legacy contract can group multiple targets under one operation
        // ("Create only A and B").  Match the parsed operation/path pairs,
        // rather than searching for a phrase that only exists for the first
        // target in that clause.
        const beforeCreatedTarget = targetScopes(change.before_contract?.first_line)
          .some((candidate) => candidate.operation === 'Create' && candidate.path === scope.path);
        if (!beforeCreatedTarget) continue;
        const targetPath = path.join(repo, scope.path);
        let targetContent = '';
        try { targetContent = fs.readFileSync(targetPath, 'utf8'); } catch { continue; }
        if (!isBoundedProposalPlaceholder(targetContent)) continue;
        const targetSha256 = sha256Text(targetContent.trim());
        const alreadyCaptured = existingReceipts.some((candidate) => candidate.target_capture?.mode === 'legacy_pre_capture_materialization'
          && candidate.target_capture?.source_recovery_record === safeRelativePath(repo, recordPath)
          && candidate.target_snapshots?.some((snapshot) => snapshot.path === scope.path && snapshot.sha256_after === targetSha256));
        // The capture receipt is only one half of recovery.  Do not report
        // success here: the normal repair below must still rewrite any
        // remaining Create-only scopes for materialized siblings to Patch-only.
        if (alreadyCaptured) continue;
        const beforeTodoText = fs.readFileSync(beforePath, 'utf8');
        const beforeBreakdownPath = record.rollback_snapshot?.breakdown;
        const beforeBreakdownText = beforeBreakdownPath && fs.existsSync(beforeBreakdownPath)
          ? fs.readFileSync(beforeBreakdownPath, 'utf8')
          : null;
        const afterBreakdownText = fs.existsSync(breakdownPath) ? fs.readFileSync(breakdownPath, 'utf8') : null;
        const migrationEventKey = sha256Text(`${record.event_key}\n${id}\n${scope.path}\n${targetSha256}`);
        const migrationReceipt = buildContractRebaselineReceipt({
          repoRoot: repo,
          beforeTodoText,
          afterTodoText: todoText,
          beforeBreakdownText,
          afterBreakdownText,
          runStamp: `${runStamp}-legacy-target-capture`,
          eventKey: migrationEventKey,
          diagnostic,
          verification: {
            repair_command: 'node scripts/phase-loop-preclaim-recovery.mjs',
            guard_command: 'node scripts/guard-todo-decomposition.mjs',
            integrity_command: 'pnpm -s phase-loop:todo-queue-integrity'
          },
          todoIds: [id],
          targetSnapshots: [{
            operation: 'Create',
            path: scope.path,
            exists_before: null,
            sha256_before: null,
            exists_after: true,
            sha256_after: targetSha256
          }],
          targetCapture: {
            mode: 'legacy_pre_capture_materialization',
            source_recovery_record: safeRelativePath(repo, recordPath),
            source_contract_rebaseline_receipt: receiptRelative,
            target_sha256: targetSha256
          }
        });
        if (!migrationReceipt) continue;
        const migrationRelative = writeContractRebaselineReceipt(repo, migrationReceipt);
        const latestRecord = readJson(recordPath);
        latestRecord.legacy_target_materialization_rebaselines = [
          ...(Array.isArray(latestRecord.legacy_target_materialization_rebaselines) ? latestRecord.legacy_target_materialization_rebaselines : []),
          migrationRelative
        ];
        writeJson(recordPath, latestRecord);
        return true;
      }
    }
  }
  return false;
}

function restoreSnapshot({ recoveryDir, todoPath, breakdownPath, breakdownExisted }) {
  fs.copyFileSync(path.join(recoveryDir, 'todo.before.md'), todoPath);
  const breakdownSnapshot = path.join(recoveryDir, 'todo-breakdown.before.md');
  if (breakdownExisted) {
    fs.copyFileSync(breakdownSnapshot, breakdownPath);
  } else if (fs.existsSync(breakdownPath)) {
    fs.unlinkSync(breakdownPath);
  }
}

const terminalRecoveryStatuses = new Set([
  'applied',
  'failed_reverted',
  'failed_recovery_snapshot_missing',
  'failed_recovery_record_invalid'
]);

function findInterruptedRecovery({ stateDir, todoPath, breakdownPath, diagnostic }) {
  const recoveryRoot = path.join(stateDir, 'preclaim-recovery');
  if (!fs.existsSync(recoveryRoot)) return null;
  const matches = fs.readdirSync(recoveryRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const recoveryDir = path.join(recoveryRoot, entry.name);
      const recordPath = path.join(recoveryDir, 'record.json');
      if (!fs.existsSync(recordPath)) return null;
      const record = readJson(recordPath);
      return record.status === 'started'
        && record.before?.todo_path === todoPath
        && record.before?.breakdown_path === breakdownPath
        && record.diagnostic_tail === diagnostic.slice(-6000)
        ? { recoveryDir, recordPath, record }
        : null;
    })
    .filter(Boolean);
  if (matches.length > 1) {
    throw new Error('multiple interrupted pre-claim recovery records match the current event');
  }
  return matches[0] ?? null;
}

function recoverySnapshotMissing({ record }) {
  const required = [
    record.rollback_snapshot?.todo,
    record.claim_snapshot?.recovery_claim_path
  ];
  if (record.rollback_snapshot?.breakdown) required.push(record.rollback_snapshot.breakdown);
  return required.filter((filePath) => typeof filePath !== 'string' || !fs.existsSync(filePath));
}

function markRecoveryTerminal({ recordPath, record, status, reason, missing = [] }) {
  record.status = status;
  record.failure_reason = reason;
  record.snapshot_missing = missing;
  record.terminal_recorded_at = new Date().toISOString();
  writeJson(recordPath, record);
}

async function main(rawArgs) {
  const args = rawArgs;
  const repo = path.resolve(args.repo ?? repositoryRoot);
  const todoPath = path.resolve(repo, args.todo ?? '.brownie/todo.md');
  const breakdownPath = path.resolve(repo, args.breakdown ?? '.brownie/todo-breakdown.md');
  const claimPath = path.resolve(repo, args.claim ?? '.brownie/private/phase-loop/todo-claims/current.json');
  const stateDir = path.resolve(args['state-dir'] ?? path.join(repo, '.brownie/private/phase-loop'));
  const diagnostic = String(args.diagnostic ?? '');
  const runStamp = String(args['run-stamp'] ?? new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z'));
  const maxRetriesRaw = Number.parseInt(args['max-retries'] ?? '3', 10);
  const maxRetries = Number.isInteger(maxRetriesRaw) && maxRetriesRaw > 0 ? maxRetriesRaw : 3;
  const approvedBaselineRef = typeof args['baseline-ref'] === 'string' ? args['baseline-ref'] : '';

  if (!isReparableDecompositionDiagnostic(diagnostic)) {
    return 2;
  }
  if (!fs.existsSync(todoPath)) {
    return 1;
  }

  const todoBeforeText = fs.readFileSync(todoPath, 'utf8');
  const breakdownBeforeExists = fs.existsSync(breakdownPath);
  const breakdownBeforeText = breakdownBeforeExists ? fs.readFileSync(breakdownPath, 'utf8') : '';
  const claim = readJson(claimPath);
  let selectedTodo = typeof claim.selected_todo === 'string' && todoBeforeText.includes(claim.selected_todo)
    ? claim.selected_todo
    : todoBlocks(todoBeforeText)[0] ?? '';
  // Older controller versions captured only the first declared target.  When
  // that evidence proves a successful Create-only operation but omits the
  // materialized sibling target, record one explicit, hash-bound migration
  // before allowing the repaired Patch-only TODO to continue.
  if (migrateLegacyTargetCapture({
    repo,
    stateDir,
    todoPath,
    breakdownPath,
    todoText: todoBeforeText,
    runStamp,
    diagnostic
  })) {
    return 0;
  }
  const todoBeforeHash = sha256Text(todoBeforeText);
  const breakdownBeforeHash = breakdownBeforeExists ? sha256Text(breakdownBeforeText) : null;
  const eventKey = sha256Text(`${todoBeforeHash}\n${breakdownBeforeHash ?? 'missing'}\n${diagnostic}`);
  let recoveryDir = path.join(stateDir, 'preclaim-recovery', eventKey);
  let recordPath = path.join(recoveryDir, 'record.json');
  let recoveryRecord = fs.existsSync(recordPath) ? readJson(recordPath) : null;
  if (!recoveryRecord) {
    const interrupted = findInterruptedRecovery({ stateDir, todoPath, breakdownPath, diagnostic });
    if (interrupted) {
      recoveryDir = interrupted.recoveryDir;
      recordPath = interrupted.recordPath;
      recoveryRecord = interrupted.record;
    }
  }
  let reopeningLegacyNoop = false;
  let resumedInterruptedRecovery = false;
  if (recoveryRecord) {
    if (recoveryRecord.status !== 'started' && !isLegacyNoopAppliedRecovery(recoveryRecord, diagnostic)) {
      return terminalRecoveryStatuses.has(recoveryRecord.status) ? 2 : 1;
    }
    reopeningLegacyNoop = recoveryRecord.status === 'applied';
    resumedInterruptedRecovery = !reopeningLegacyNoop;
    const missingSnapshots = recoverySnapshotMissing({ record: recoveryRecord });
    if (missingSnapshots.length > 0) {
      markRecoveryTerminal({
        recordPath,
        record: recoveryRecord,
        status: 'failed_recovery_snapshot_missing',
        reason: 'recovery_snapshot_missing',
        missing: missingSnapshots
      });
      return 1;
    }
    if (reopeningLegacyNoop) {
      const liveTodoSha256 = sha256File(todoPath);
      const liveBreakdownSha256 = breakdownBeforeExists ? sha256File(breakdownPath) : null;
      if (liveTodoSha256 !== recoveryRecord.after?.todo_sha256 || liveBreakdownSha256 !== recoveryRecord.after?.breakdown_sha256) {
        markRecoveryTerminal({
          recordPath,
          record: recoveryRecord,
          status: 'failed_recovery_record_invalid',
          reason: 'legacy_noop_recovery_live_state_changed',
          missing: []
        });
        return 1;
      }
    } else {
      try {
        restoreSnapshot({
          recoveryDir,
          todoPath,
          breakdownPath,
          breakdownExisted: Boolean(recoveryRecord.rollback_snapshot.breakdown)
        });
      } catch (error) {
        markRecoveryTerminal({
          recordPath,
          record: recoveryRecord,
          status: 'failed_recovery_snapshot_missing',
          reason: 'recovery_snapshot_restore_failed',
          missing: [String(error?.message ?? error)]
        });
        return 1;
      }
    }
    recoveryRecord.recovery_resumes = [
      ...(Array.isArray(recoveryRecord.recovery_resumes) ? recoveryRecord.recovery_resumes : []),
      {
        run_stamp: runStamp,
        resumed_at: new Date().toISOString(),
        rollback_performed: !reopeningLegacyNoop,
        legacy_noop_reopened: reopeningLegacyNoop
      }
    ];
    recoveryRecord.status = 'started';
    recoveryRecord.resumed_after_interruption = !reopeningLegacyNoop;
    recoveryRecord.legacy_noop_reopened = reopeningLegacyNoop || recoveryRecord.legacy_noop_reopened === true;
    writeJson(recordPath, recoveryRecord);
  }

  if (!recoveryRecord) {
    fs.mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(todoPath, path.join(recoveryDir, 'todo.before.md'));
    fs.chmodSync(path.join(recoveryDir, 'todo.before.md'), 0o600);
    if (breakdownBeforeExists) {
      fs.copyFileSync(breakdownPath, path.join(recoveryDir, 'todo-breakdown.before.md'));
      fs.chmodSync(path.join(recoveryDir, 'todo-breakdown.before.md'), 0o600);
    }
  }

  const recoveryClaimPath = recoveryRecord?.claim_snapshot?.recovery_claim_path ?? path.join(recoveryDir, 'claim.json');
  if (!recoveryRecord) {
    const recoveryClaim = {
      schema_version: 1,
      claim_id: String(claim.claim_id ?? `preclaim-recovery-${eventKey.slice(0, 16)}`),
      status: 'preclaim_recovery',
      selected_todo: selectedTodo,
      queue_fingerprint: String(claim.queue_fingerprint ?? ''),
      source_claim_path: claimPath,
      event_key: eventKey
    };
    writeJson(recoveryClaimPath, recoveryClaim);
    atomicWrite(path.join(recoveryDir, 'selected-todo.before.md'), selectedTodo ? `${selectedTodo}\n` : '');
  }

  const firstLine = recoveryRecord?.claim_snapshot?.selected_todo_first_line ?? selectedTodo.split('\n')[0] ?? '';
  // Deterministic repair can normalize a sibling leaf (for example a
  // Create-only test leaf) while repairing the selected TODO's graph.  Capture
  // every currently executable target before mutation so a later rebaseline
  // cannot accidentally authorize an uncaptured materialization.
  const targetSnapshot = recoveryRecord?.target_snapshot ?? allUncheckedTargetScopes(todoBeforeText).map((scope) => {
    const targetPath = path.resolve(repo, scope.path);
    return {
      operation: scope.operation,
      path: scope.path,
      exists_before: fs.existsSync(targetPath),
      sha256_before: sha256File(targetPath)
    };
  });
  const record = recoveryRecord ?? {
    schema_version: 1,
    record_type: 'phase_loop_preclaim_recovery',
    status: 'started',
    reason: 'reparable_decomposition_diagnostics_before_claim',
    event_key: eventKey,
    run_stamp: runStamp,
    max_retries: maxRetries,
    diagnostic_tail: diagnostic.slice(-6000),
    claim_snapshot: {
      source_path: claimPath,
      claim_id: String(claim.claim_id ?? ''),
      selected_todo_first_line: firstLine,
      selected_todo_sha256: sha256Text(selectedTodo),
      recovery_claim_path: recoveryClaimPath
    },
    target_snapshot: targetSnapshot,
    before: {
      todo_path: todoPath,
      todo_sha256: todoBeforeHash,
      breakdown_path: breakdownPath,
      breakdown_sha256: breakdownBeforeHash
    },
    rollback_snapshot: {
      todo: path.join(recoveryDir, 'todo.before.md'),
      breakdown: breakdownBeforeExists ? path.join(recoveryDir, 'todo-breakdown.before.md') : null,
      selected_todo: path.join(recoveryDir, 'selected-todo.before.md')
    },
    attempts: []
  };
  writeJson(recordPath, record);

  const resumedPlaceholderRecovery = resumedInterruptedRecovery
    && Array.isArray(record.placeholder_target_restorations)
    && record.placeholder_target_restorations.length > 0
    ? verifyPersistedTargetRestorations({
      repo,
      recoveryDir,
      restorations: record.placeholder_target_restorations,
      baselineRef: approvedBaselineRef
    })
    : null;
  if (resumedPlaceholderRecovery && !resumedPlaceholderRecovery.applied) {
    record.status = 'failed_recovery_record_invalid';
    record.failure_reason = 'persisted_target_restoration_invalid';
    record.placeholder_target_recovery_error = {
      reason: resumedPlaceholderRecovery.reason,
      errors: resumedPlaceholderRecovery.errors ?? []
    };
    record.terminal_recorded_at = new Date().toISOString();
    writeJson(recordPath, record);
    return 1;
  }

  const repairScript = path.join(repo, 'scripts/repair-todo-decomposition.mjs');
  const guardScript = path.join(repo, 'scripts/guard-todo-decomposition.mjs');
  process.env.BROWNIE_REPAIR_TODO_REPO_ROOT = repo;
  const { repairTodoDecomposition } = await import(pathToFileURL(repairScript).href);
  const { validateTodoDecomposition } = await import(pathToFileURL(guardScript).href);

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    let repair;
    try {
      const repairResult = repairTodoDecomposition({
        claimPath: recoveryClaimPath,
        todoPath,
        breakdownPath,
        runStamp: `${runStamp}-preclaim-${attempt}`
      });
      repair = {
        exitCode: repairResult.applied ? 0 : repairResult.eligible ? 1 : 2,
        output: JSON.stringify(repairResult)
      };
    } catch (error) {
      repair = { exitCode: 1, output: String(error?.stack ?? error) };
    }
    const placeholderRecovery = resumedPlaceholderRecovery ?? (repair.exitCode === 0
      ? { applied: false, reason: 'todo_repair_applied', restorations: [] }
      : restoreExactBoundedPatchPlaceholders({
        repo,
        recoveryDir,
        targetSnapshot,
        baselineRef: approvedBaselineRef
      }));
    const guardErrors = validateTodoDecomposition(repo, path.relative(repo, todoPath));
    const guard = {
      exitCode: guardErrors.length > 0 ? 1 : 0,
      output: guardErrors.length > 0 ? `TODO decomposition guard failed:\n${guardErrors.map((error) => `- ${error}`).join('\n')}` : 'TODO decomposition guard passed.'
    };
    const currentRecord = readJson(recordPath);
    currentRecord.attempts.push({
      attempt,
      repair_exit: repair.exitCode,
      repair_output_tail: repair.output.slice(-4000),
      guard_exit: guard.exitCode,
      guard_output_tail: guard.output.slice(-4000),
      placeholder_recovery: {
        applied: placeholderRecovery.applied === true,
        reason: placeholderRecovery.reason,
        resumed: placeholderRecovery.resumed === true,
        errors: placeholderRecovery.errors ?? []
      },
      todo_sha256_after: sha256File(todoPath),
      breakdown_sha256_after: sha256File(breakdownPath)
    });
    currentRecord.after = {
      todo_sha256: sha256File(todoPath),
      breakdown_sha256: sha256File(breakdownPath)
    };
    currentRecord.target_snapshot = targetSnapshot.map((target) => {
      const targetPath = path.resolve(repo, target.path);
      return {
        ...target,
        exists_after: fs.existsSync(targetPath),
        sha256_after: sha256File(targetPath)
      };
    });
    if (placeholderRecovery.applied && placeholderRecovery.resumed !== true) {
      currentRecord.placeholder_target_restorations = [
        ...(Array.isArray(currentRecord.placeholder_target_restorations) ? currentRecord.placeholder_target_restorations : []),
        ...placeholderRecovery.restorations
      ];
    }
    if (!placeholderRecovery.applied && placeholderRecovery.reason !== 'todo_repair_applied') {
      currentRecord.placeholder_target_recovery_error = {
        reason: placeholderRecovery.reason,
        errors: placeholderRecovery.errors ?? []
      };
    }
    writeJson(recordPath, currentRecord);

    if (guard.exitCode === 0 && (repair.exitCode === 0 || placeholderRecovery.applied)) {
      try {
        const beforeTodoText = fs.readFileSync(currentRecord.rollback_snapshot.todo, 'utf8');
        const afterTodoText = fs.readFileSync(todoPath, 'utf8');
        const beforeBreakdownText = currentRecord.rollback_snapshot.breakdown
          ? fs.readFileSync(currentRecord.rollback_snapshot.breakdown, 'utf8')
          : null;
        const afterBreakdownText = fs.existsSync(breakdownPath)
          ? fs.readFileSync(breakdownPath, 'utf8')
          : null;
        const contractReceipt = buildContractRebaselineReceipt({
          repoRoot: repo,
          beforeTodoText,
          afterTodoText,
          beforeBreakdownText,
          afterBreakdownText,
          runStamp,
          eventKey,
          diagnostic,
          verification: {
            repair_command: 'node scripts/repair-todo-decomposition.mjs',
            guard_command: 'node scripts/guard-todo-decomposition.mjs',
            integrity_command: 'pnpm -s phase-loop:todo-queue-integrity'
          },
          targetSnapshots: currentRecord.target_snapshot
        });
        if (contractReceipt) {
          currentRecord.contract_rebaseline_receipt = writeContractRebaselineReceipt(repo, contractReceipt);
        }
        currentRecord.status = 'applied';
        currentRecord.rollback_performed = false;
        writeJson(recordPath, currentRecord);
        return 0;
      } catch (error) {
        const targetRollbackErrors = placeholderRecovery.applied
          ? restoreTargetPreimages(repo, recoveryDir, placeholderRecovery.restorations)
          : [];
        restoreSnapshot({ recoveryDir, todoPath, breakdownPath, breakdownExisted: breakdownBeforeExists });
        currentRecord.status = 'failed_reverted';
        currentRecord.rollback_performed = true;
        currentRecord.failure_reason = 'contract_rebaseline_receipt_failed';
        currentRecord.after_rollback = {
          todo_sha256: sha256File(todoPath),
          breakdown_sha256: sha256File(breakdownPath),
          receipt_error: String(error?.message ?? error),
          target_restore_rollback_errors: targetRollbackErrors
        };
        writeJson(recordPath, currentRecord);
        return 1;
      }
    }

    const canRetry = repair.exitCode === 0 && attempt < maxRetries && isReparableDecompositionDiagnostic(guard.output);
    if (canRetry) {
      continue;
    }

    const targetRollbackErrors = placeholderRecovery.applied
      ? restoreTargetPreimages(repo, recoveryDir, placeholderRecovery.restorations)
      : [];
    restoreSnapshot({ recoveryDir, todoPath, breakdownPath, breakdownExisted: breakdownBeforeExists });
    currentRecord.status = 'failed_reverted';
    currentRecord.rollback_performed = true;
    currentRecord.failure_reason = repair.exitCode !== 0 && !placeholderRecovery.applied
      ? placeholderRecovery.reason === 'no_exact_bounded_patch_placeholder'
        ? 'no_effective_recovery'
        : 'placeholder_recovery_unavailable'
      : !isReparableDecompositionDiagnostic(guard.output)
        ? 'guard_remained_non_reparable'
        : 'retry_bound_reached';
    currentRecord.after_rollback = {
      todo_sha256: sha256File(todoPath),
      breakdown_sha256: sha256File(breakdownPath),
      guard_output_tail: guard.output.slice(-4000),
      target_restore_rollback_errors: targetRollbackErrors
    };
    writeJson(recordPath, currentRecord);
    return 1;
  }
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = parseArgs(process.argv.slice(2));
  main(args).then((status) => process.exit(status)).catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
  });
}

export { isReparableDecompositionDiagnostic, main };
