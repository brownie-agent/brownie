#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildContractRebaselineReceipt,
  contractChanges,
  readContractRebaselineRecords,
  writeContractRebaselineReceipt
} from './phase-loop-todo-contract-rebaseline.mjs';
import { boundedScopeEntries } from './phase-loop-bounded-scope.mjs';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) args[argv[index].slice(2)] = argv[++index];
  }
  return args;
}

function gitShow(repoRoot, ref, relativePath) {
  return execFileSync('git', ['show', `${ref}:${relativePath}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function scopeMap(firstLine) {
  const result = new Map();
  for (const entry of boundedScopeEntries(firstLine)) {
    if (result.has(entry.path)) throw new Error(`duplicate bounded scope: ${entry.path}`);
    result.set(entry.path, entry.operation);
  }
  return result;
}

function capturedPlaceholder(records, todoId, targetPath, targetSha256) {
  return records.some((record) => record?.target_capture?.mode === 'legacy_pre_capture_materialization'
    && record?.target_todo_ids?.includes(todoId)
    && record?.target_snapshots?.some((snapshot) => snapshot.operation === 'Create'
      && snapshot.path === targetPath
      && snapshot.exists_after === true
      && snapshot.sha256_after === targetSha256));
}

export function validateMaterializedScopeRebaseline({ beforeContract, afterContract, repoRoot, records }) {
  for (const field of ['id', 'route', 'depends_on', 'completion_condition', 'forbidden_changes', 'verification']) {
    if (beforeContract[field] !== afterContract[field]) {
      throw new Error(`materialized scope rebaseline may not change ${field}`);
    }
  }
  const beforeScopes = scopeMap(beforeContract.first_line);
  const afterScopes = scopeMap(afterContract.first_line);
  if (beforeScopes.size !== afterScopes.size || [...beforeScopes.keys()].some((target) => !afterScopes.has(target))) {
    throw new Error('materialized scope rebaseline may not add, remove, or replace bounded targets');
  }
  const converted = [];
  for (const [target, beforeOperation] of beforeScopes) {
    const afterOperation = afterScopes.get(target);
    if (beforeOperation === afterOperation) continue;
    if (beforeOperation !== 'create' || afterOperation !== 'patch') {
      throw new Error(`materialized scope rebaseline only permits Create-to-Patch: ${target}`);
    }
    const absoluteTarget = path.join(repoRoot, target);
    if (!fs.existsSync(absoluteTarget)) throw new Error(`materialized target is absent: ${target}`);
    const sha256 = sha256File(absoluteTarget);
    if (!capturedPlaceholder(records, afterContract.id, target, sha256)) {
      throw new Error(`materialized target is not bound to a legacy placeholder capture: ${target}`);
    }
    converted.push({ operation: 'Patch', path: target, exists_before: true, sha256_before: sha256, exists_after: true, sha256_after: sha256 });
  }
  if (converted.length === 0) throw new Error('materialized scope rebaseline requires a Create-to-Patch transition');
  return converted;
}

export function admitMaterializedScopeRebaseline({ repoRoot, baselineRef, todoId, runStamp, eventKey, diagnostic }) {
  if (!todoId || !runStamp || !eventKey || !diagnostic) throw new Error('todo id, run stamp, event key, and diagnostic are required');
  const beforeTodoText = gitShow(repoRoot, baselineRef, '.brownie/todo.md');
  const beforeBreakdownText = gitShow(repoRoot, baselineRef, '.brownie/todo-breakdown.md');
  const afterTodoText = fs.readFileSync(path.join(repoRoot, '.brownie/todo.md'), 'utf8');
  const afterBreakdownText = fs.readFileSync(path.join(repoRoot, '.brownie/todo-breakdown.md'), 'utf8');
  const changes = contractChanges({ beforeTodoText, afterTodoText, todoIds: [todoId] });
  if (changes.length !== 1 || changes[0].todo_id !== todoId) throw new Error(`expected one changed contract for ${todoId}`);
  const change = changes[0];
  if (JSON.stringify(change.changed_fields) !== JSON.stringify(['first_line', 'bounded_scopes'])) {
    throw new Error(`unsupported materialized scope contract drift: ${change.changed_fields.join(', ')}`);
  }
  const targetSnapshots = validateMaterializedScopeRebaseline({
    beforeContract: change.before_contract,
    afterContract: change.after_contract,
    repoRoot,
    records: readContractRebaselineRecords(repoRoot)
  });
  execFileSync(process.execPath, ['scripts/guard-todo-decomposition.mjs'], { cwd: repoRoot, stdio: 'ignore' });
  const receipt = buildContractRebaselineReceipt({
    repoRoot,
    beforeTodoText,
    afterTodoText,
    beforeBreakdownText,
    afterBreakdownText,
    todoIds: [todoId],
    runStamp,
    eventKey,
    diagnostic,
    verification: {
      repair_command: 'node scripts/phase-loop-admit-materialized-scope-rebaseline.mjs',
      guard_command: 'node scripts/guard-todo-decomposition.mjs',
      integrity_command: 'pnpm -s phase-loop:todo-queue-integrity'
    },
    targetSnapshots,
    targetCapture: { mode: 'legacy_materialized_scope_operation_rebaseline', source: 'legacy_pre_capture_materialization' }
  });
  return { applied: true, receipt_path: writeContractRebaselineReceipt(repoRoot, receipt), target_snapshots: targetSnapshots };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    console.log(JSON.stringify(admitMaterializedScopeRebaseline({
      repoRoot: path.resolve(args.repo ?? process.cwd()),
      baselineRef: args['baseline-ref'] ?? 'HEAD',
      todoId: args['todo-id'],
      runStamp: args['run-stamp'],
      eventKey: args['event-key'],
      diagnostic: args.diagnostic
    }), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ applied: false, error: error?.message ?? String(error) }, null, 2));
    process.exit(1);
  }
}
