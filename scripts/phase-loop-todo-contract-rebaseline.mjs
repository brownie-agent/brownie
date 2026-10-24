#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function todoBlocks(text) {
  const source = String(text ?? '');
  const starts = [...source.matchAll(/^(?:[-*]|\d+[.)])\s+\[[ xX]\]\s+/gmu)].map((match) => match.index);
  return starts.map((start, index) => source.slice(start, starts[index + 1] ?? source.length).trimEnd());
}

export function todoId(block) {
  return String(block ?? '')
    .split('\n')[0]
    ?.trim()
    .replace(/^(?:[-*]|\d+[.)])\s+\[[ xX]\]\s+/u, '')
    .split(':')[0]
    ?.trim() ?? '';
}

function lineValue(block, label) {
  const prefix = `${label}:`;
  const line = String(block ?? '')
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix));
  return line ? line.slice(prefix.length).trim().replace(/[.]$/u, '') : '';
}

function boundedScopeValues(firstLine, keyword) {
  const start = firstLine.indexOf(keyword);
  if (start < 0) return [];
  let rest = firstLine.slice(start + keyword.length).trimStart();
  const values = [];
  while (rest.startsWith('`')) {
    const end = rest.indexOf('`', 1);
    if (end < 0) break;
    values.push(rest.slice(1, end));
    rest = rest.slice(end + 1).trimStart();
    const separator = rest.match(/^(?:,|and\b|&)\s*/u);
    if (!separator) break;
    rest = rest.slice(separator[0].length).trimStart();
  }
  return values;
}

export function protectedContract(block) {
  const firstLine = String(block ?? '').split('\n')[0]?.trim() ?? '';
  return {
    id: todoId(block),
    first_line: firstLine,
    route: lineValue(block, 'Route').toLowerCase(),
    depends_on: lineValue(block, 'Depends on'),
    completion_condition: lineValue(block, 'Completion condition'),
    forbidden_changes: lineValue(block, 'Forbidden changes'),
    verification: lineValue(block, 'Verification'),
    bounded_scopes: [
      ...boundedScopeValues(firstLine, 'Patch only'),
      ...boundedScopeValues(firstLine, 'Create only')
    ]
  };
}

export function contractDrift(beforeBlock, afterBlock) {
  const before = protectedContract(beforeBlock);
  const after = protectedContract(afterBlock);
  const drift = [];
  for (const key of ['id', 'first_line', 'route', 'depends_on', 'completion_condition', 'forbidden_changes', 'verification']) {
    if (before[key] !== after[key]) drift.push(key);
  }
  if (JSON.stringify(before.bounded_scopes) !== JSON.stringify(after.bounded_scopes)) {
    drift.push('bounded_scopes');
  }
  return drift;
}

export function contractMap(text) {
  const result = new Map();
  for (const block of todoBlocks(text)) {
    const id = todoId(block);
    if (id) result.set(id, block);
  }
  return result;
}

export function contractChanges({ beforeTodoText, afterTodoText, todoIds = null }) {
  const before = contractMap(beforeTodoText);
  const after = contractMap(afterTodoText);
  const selectedTodoIds = todoIds === null ? null : new Set(todoIds);
  const changes = [];
  for (const [id, beforeBlock] of before) {
    if (selectedTodoIds && !selectedTodoIds.has(id)) continue;
    const afterBlock = after.get(id);
    if (!afterBlock) continue;
    const changedFields = contractDrift(beforeBlock, afterBlock);
    if (changedFields.length === 0) continue;
    changes.push({
      todo_id: id,
      changed_fields: changedFields,
      before_contract: protectedContract(beforeBlock),
      after_contract: protectedContract(afterBlock)
    });
  }
  return changes;
}

function atomicWriteJson(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fsyncFile(temporary);
  fs.renameSync(temporary, filePath);
  fsyncDirectory(directory);
  fs.chmodSync(filePath, 0o600);
}

function fsyncFile(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory) {
  try {
    const descriptor = fs.openSync(directory, 'r');
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    // Directory fsync is not available on every supported filesystem.
  }
}

function dependencyIds(value) {
  return String(value ?? '')
    .split(/\s*,\s*/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry !== '<none>');
}

function parentTodoIdForChange(change) {
  const beforeDependencies = dependencyIds(change.before_contract.depends_on);
  const afterDependencies = dependencyIds(change.after_contract.depends_on);
  const afterDependencySet = new Set(afterDependencies);
  return beforeDependencies.find((dependency) => !afterDependencySet.has(dependency)) ?? beforeDependencies[0] ?? afterDependencies[0] ?? null;
}

export function buildContractRebaselineReceipt({
  repoRoot,
  beforeTodoText,
  afterTodoText,
  beforeBreakdownText = null,
  afterBreakdownText = null,
  runStamp,
  eventKey,
  diagnostic,
  verification,
  todoIds = null
}) {
  const changes = contractChanges({ beforeTodoText, afterTodoText, todoIds });
  if (changes.length === 0) return null;
  const targetTodoIds = changes.map((change) => change.todo_id);
  const parentTodoIds = [...new Set(changes.map((change) => parentTodoIdForChange(change)).filter(Boolean))];
  if (!runStamp || !eventKey || !diagnostic || !verification?.repair_command || !verification?.guard_command || !verification?.integrity_command) {
    throw new Error('contract rebaseline receipt requires cause run and verification path');
  }
  return {
    schema_version: 1,
    record_type: 'todo_contract_rebaseline',
    status: 'approved',
    approval: 'preclaim_deterministic_repair_guard_passed',
    operation: 'deterministic_decomposition_contract_rebaseline',
    parent_todo_ids: parentTodoIds,
    target_todo_ids: targetTodoIds,
    contract_changes: changes,
    cause_run: {
      run_stamp: String(runStamp),
      event_key: String(eventKey),
      diagnostic_sha256: sha256Text(diagnostic)
    },
    verification: {
      repair_command: String(verification.repair_command),
      guard_command: String(verification.guard_command),
      integrity_command: String(verification.integrity_command),
      guard_passed: true
    },
    todo_path: '.brownie/todo.md',
    breakdown_path: '.brownie/todo-breakdown.md',
    before_todo_sha256: sha256Text(beforeTodoText),
    after_todo_sha256: sha256Text(afterTodoText),
    before_breakdown_sha256: beforeBreakdownText === null ? null : sha256Text(beforeBreakdownText),
    after_breakdown_sha256: afterBreakdownText === null ? null : sha256Text(afterBreakdownText),
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z'),
    controller: 'phase-loop-preclaim-recovery'
  };
}

export function writeContractRebaselineReceipt(repoRoot, receipt) {
  if (!receipt || receipt.record_type !== 'todo_contract_rebaseline') {
    throw new Error('invalid todo contract rebaseline receipt');
  }
  const identity = {
    record_type: receipt.record_type,
    cause_run: receipt.cause_run,
    target_todo_ids: receipt.target_todo_ids,
    contract_changes: receipt.contract_changes,
    before_todo_sha256: receipt.before_todo_sha256,
    after_todo_sha256: receipt.after_todo_sha256,
    before_breakdown_sha256: receipt.before_breakdown_sha256,
    after_breakdown_sha256: receipt.after_breakdown_sha256
  };
  const digest = sha256Text(JSON.stringify(identity)).slice(0, 16);
  const runStamp = String(receipt.cause_run?.run_stamp ?? 'unknown').replace(/[^A-Za-z0-9_.-]+/gu, '-');
  const relativePath = `.brownie/private/phase-loop/todo-claims/contract-rebaselines/${runStamp}-${digest}.json`;
  const absolutePath = path.join(repoRoot, relativePath);
  if (fs.existsSync(absolutePath)) {
    const existing = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    const existingIdentity = {
      record_type: existing.record_type,
      cause_run: existing.cause_run,
      target_todo_ids: existing.target_todo_ids,
      contract_changes: existing.contract_changes,
      before_todo_sha256: existing.before_todo_sha256,
      after_todo_sha256: existing.after_todo_sha256,
      before_breakdown_sha256: existing.before_breakdown_sha256,
      after_breakdown_sha256: existing.after_breakdown_sha256
    };
    if (JSON.stringify(existingIdentity) !== JSON.stringify(identity)) {
      throw new Error(`contract rebaseline receipt identity collision: ${relativePath}`);
    }
    return relativePath;
  }
  atomicWriteJson(absolutePath, receipt);
  return relativePath;
}

export function readContractRebaselineRecords(repoRoot) {
  const directory = path.join(repoRoot, '.brownie/private/phase-loop/todo-claims/contract-rebaselines');
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function matchesContractRebaselineRecord(record, {
  todoId: changedTodoId,
  changedFields,
  beforeContract,
  afterContract,
  beforeTodoSha256,
  afterTodoSha256,
  beforeBreakdownSha256 = null,
  afterBreakdownSha256 = null
}) {
  if (record?.schema_version !== 1 || record.record_type !== 'todo_contract_rebaseline' || record.status !== 'approved') return false;
  if (record.approval !== 'preclaim_deterministic_repair_guard_passed') return false;
  if (!Array.isArray(record.target_todo_ids) || !record.target_todo_ids.includes(changedTodoId)) return false;
  if (!Array.isArray(record.parent_todo_ids) || record.parent_todo_ids.length === 0) return false;
  // The whole-document hashes are immutable audit anchors for the repair
  // transaction, not a continuing precondition.  Later queue work may add
  // independent TODOs, which necessarily changes them without changing this
  // record's protected before/after contract.  Requiring their equality here
  // would turn a previously approved rebaseline into a permanent pre-claim
  // blocker.  The exact per-TODO contracts below remain the authorization.
  if (!/^[a-f0-9]{64}$/u.test(String(record.before_todo_sha256 ?? ''))
    || !/^[a-f0-9]{64}$/u.test(String(record.after_todo_sha256 ?? ''))) return false;
  if ((record.before_breakdown_sha256 ?? null) !== null
    && !/^[a-f0-9]{64}$/u.test(String(record.before_breakdown_sha256))) return false;
  if ((record.after_breakdown_sha256 ?? null) !== null
    && !/^[a-f0-9]{64}$/u.test(String(record.after_breakdown_sha256))) return false;
  if (!record.cause_run?.run_stamp || !record.cause_run?.event_key || !record.cause_run?.diagnostic_sha256) return false;
  if (!record.verification?.repair_command || !record.verification?.guard_command || !record.verification?.integrity_command || record.verification.guard_passed !== true) return false;
  const change = record.contract_changes?.find((entry) => entry.todo_id === changedTodoId);
  return Boolean(change)
    && JSON.stringify(change.changed_fields) === JSON.stringify(changedFields)
    && JSON.stringify(change.before_contract) === JSON.stringify(beforeContract)
    && JSON.stringify(change.after_contract) === JSON.stringify(afterContract);
}
