#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildContractRebaselineReceipt, writeContractRebaselineReceipt } from './phase-loop-todo-contract-rebaseline.mjs';
import { loadCliInput, validateTodoQueueIntegrity } from './phase-loop-todo-queue-integrity.mjs';
import { validateTodoDecomposition } from './guard-todo-decomposition.mjs';

function sha256(value) { return crypto.createHash('sha256').update(value, 'utf8').digest('hex'); }
function stamp() { return new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z'); }
function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) result[argv[index].slice(2)] = argv[++index];
  }
  return result;
}
function blocks(text) {
  const starts = [...String(text).matchAll(/^(?:[-*]|\d+[.)])\s+\[\s\]\s+/gmu)].map((match) => match.index);
  return starts.map((start, index) => String(text).slice(start, starts[index + 1] ?? String(text).length).trimEnd());
}
function id(block) { return block.split('\n')[0].replace(/^(?:[-*]|\d+[.)])\s+\[\s\]\s+/u, '').split(':')[0].trim(); }
function dependencyValue(block) {
  const line = block.split('\n').map((entry) => entry.trim()).find((entry) => entry.startsWith('Depends on:'));
  return line ? line.slice('Depends on:'.length).trim().replace(/[.]$/u, '') : '<none>';
}
function dependencies(value) {
  return String(value).split(/\s*,\s*/u).map((entry) => entry.trim()).filter((entry) => entry && entry !== '<none>');
}
function graph(text) {
  const result = new Map();
  let active = false;
  for (const line of String(text).split('\n')) {
    if (line.trim() === 'Dependency graph:') { active = true; continue; }
    if (!active) continue;
    if (/^#{1,6}\s/u.test(line) || ['Verification ledger:', 'History:', 'Quality rubric:'].includes(line.trim())) { active = false; continue; }
    const match = line.match(/^-\s+([^:]+):\s*(.*?)\s*$/u);
    if (match) result.set(match[1].trim(), [...(result.get(match[1].trim()) ?? []), dependencies(match[2])]);
  }
  return result;
}
function hasDependencyCycle(dependencyGraph) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (todoId) => {
    if (visiting.has(todoId)) return true;
    if (visited.has(todoId)) return false;
    visiting.add(todoId);
    const entries = dependencyGraph.get(todoId) ?? [];
    if (entries.some((entry) => entry.some((dependency) => dependency === todoId || (dependencyGraph.has(dependency) && visit(dependency))))) return true;
    visiting.delete(todoId); visited.add(todoId); return false;
  };
  return [...dependencyGraph.keys()].some(visit);
}
function atomicWrite(filePath, content) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
}
function replaceDependencies(block, next) {
  return block.replace(/^(\s*Depends on:\s*).*$/mu, `$1${next.length ? next.join(', ') : '<none>'}.`);
}
function recoverInterruptedReconciliation(repoRoot, currentTodo) {
  const root = path.join(repoRoot, '.brownie/private/phase-loop/todo-claims/dependency-reconciliations');
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  const matches = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name)).filter((directory) => {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(directory, 'record.json'), 'utf8'));
      return record.status === 'started' && record.intended_after_todo_sha256 === sha256(currentTodo);
    } catch { return false; }
  });
  if (matches.length !== 1) return null;
  const directory = matches[0];
  const snapshot = path.join(directory, 'todo.before.md');
  if (!fs.existsSync(snapshot)) throw new Error('interrupted dependency reconciliation snapshot is missing');
  return { directory, todo: fs.readFileSync(snapshot, 'utf8') };
}

// Reconciles only a complete, non-conflicting durable graph.  It never guesses
// a dependency edge or partially applies a repair.
export function reconcileTodoBreakdown({ repoRoot, todoPath = '.brownie/todo.md', breakdownPath = '.brownie/todo-breakdown.md', runStamp = stamp(), eventKey = null, diagnostic = 'todo_breakdown_dependency_mismatch' }) {
  const todoFile = path.resolve(repoRoot, todoPath);
  const breakdownFile = path.resolve(repoRoot, breakdownPath);
  const beforeTodo = fs.readFileSync(todoFile, 'utf8');
  const beforeBreakdown = fs.readFileSync(breakdownFile, 'utf8');
  const interrupted = recoverInterruptedReconciliation(repoRoot, beforeTodo);
  if (interrupted) {
    atomicWrite(todoFile, interrupted.todo);
    fs.writeFileSync(path.join(interrupted.directory, 'record.json'), `${JSON.stringify({ schema_version: 1, record_type: 'todo_breakdown_dependency_reconciliation', status: 'interrupted_reverted', rollback_snapshot: { todo: path.join(interrupted.directory, 'todo.before.md'), breakdown: path.join(interrupted.directory, 'todo-breakdown.before.md') } }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return { applied: false, reason: 'interrupted_reconciliation_reverted', recovery_path: path.relative(repoRoot, interrupted.directory) };
  }
  // The receipt must bind to the exact baseline used by the next CLI
  // integrity check, rather than merely to the already-dirty workspace.
  const queueBaseline = loadCliInput({ repo: repoRoot, todo: todoPath, breakdown: breakdownPath });
  const durableGraph = graph(beforeBreakdown);
  if (hasDependencyCycle(durableGraph)) return { applied: false, reason: 'cyclic_durable_dependency_graph' };
  const live = blocks(beforeTodo);
  const failures = [];
  for (const block of live) {
    const entries = durableGraph.get(id(block));
    if (!entries) continue;
    if (entries.length !== 1) failures.push({ todo_id: id(block), reason: 'duplicate_or_conflicting_dependency_graph' });
  }
  if (failures.length) return { applied: false, reason: 'ambiguous_durable_dependency_graph', failures };
  let afterTodo = beforeTodo;
  const changed = [];
  for (const block of live) {
    const next = durableGraph.get(id(block))?.[0];
    if (!next) continue;
    if (JSON.stringify(dependencies(dependencyValue(block)).sort()) === JSON.stringify([...next].sort())) continue;
    const updated = replaceDependencies(block, next);
    afterTodo = afterTodo.replace(block, updated);
    changed.push(id(block));
  }
  if (!changed.length) return { applied: false, reason: 'no_dependency_mismatch' };
  const key = eventKey ?? sha256(`${sha256(beforeTodo)}\n${sha256(beforeBreakdown)}\n${diagnostic}`);
  const recoveryDir = path.join(repoRoot, '.brownie/private/phase-loop/todo-claims/dependency-reconciliations', key);
  fs.mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(recoveryDir, 'todo.before.md'), beforeTodo, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(path.join(recoveryDir, 'todo-breakdown.before.md'), beforeBreakdown, { encoding: 'utf8', mode: 0o600 });
  const recordPath = path.join(recoveryDir, 'record.json');
  fs.writeFileSync(recordPath, `${JSON.stringify({ schema_version: 1, record_type: 'todo_breakdown_dependency_reconciliation', status: 'started', before_todo_sha256: sha256(beforeTodo), intended_after_todo_sha256: sha256(afterTodo), rollback_snapshot: { todo: path.join(recoveryDir, 'todo.before.md'), breakdown: path.join(recoveryDir, 'todo-breakdown.before.md') } }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  atomicWrite(todoFile, afterTodo);
  try {
    const receipt = buildContractRebaselineReceipt({
      repoRoot, beforeTodoText: queueBaseline.todoBefore ?? beforeTodo, afterTodoText: afterTodo,
      beforeBreakdownText: queueBaseline.beforeBreakdownText ?? beforeBreakdown, afterBreakdownText: beforeBreakdown,
      // Receipts bind whole-queue hashes. Reissue every surviving dependency
      // drift so an earlier exact receipt cannot be invalidated by this repair.
      runStamp, eventKey: key, diagnostic,
      verification: {
        repair_command: 'node scripts/phase-loop-todo-breakdown-reconcile.mjs',
        guard_command: 'node scripts/guard-todo-decomposition.mjs',
        integrity_command: 'pnpm -s phase-loop:todo-queue-integrity'
      }
    });
    const decompositionErrors = validateTodoDecomposition(repoRoot, todoPath, breakdownPath);
    const integrity = validateTodoQueueIntegrity({ ...queueBaseline, todoAfter: afterTodo, afterBreakdownText: beforeBreakdown, contractRebaselineRecords: receipt ? [...queueBaseline.contractRebaselineRecords, receipt] : queueBaseline.contractRebaselineRecords });
    if (decompositionErrors.length || !integrity.valid) throw new Error(JSON.stringify({ decompositionErrors, integrity }));
    const receiptPath = receipt ? writeContractRebaselineReceipt(repoRoot, receipt) : null;
    const record = { schema_version: 1, record_type: 'todo_breakdown_dependency_reconciliation', status: 'applied', run_stamp: runStamp, event_key: key, diagnostic_sha256: sha256(diagnostic), changed_todo_ids: changed, before_todo_sha256: sha256(beforeTodo), after_todo_sha256: sha256(afterTodo), breakdown_sha256: sha256(beforeBreakdown), rollback_snapshot: { todo: path.join(recoveryDir, 'todo.before.md'), breakdown: path.join(recoveryDir, 'todo-breakdown.before.md') }, contract_rebaseline_receipt: receiptPath };
    fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return { applied: true, changed_todo_ids: changed, receipt_path: receiptPath, recovery_path: path.relative(repoRoot, recoveryDir), integrity };
  } catch (error) {
    atomicWrite(todoFile, beforeTodo);
    fs.writeFileSync(recordPath, `${JSON.stringify({ schema_version: 1, record_type: 'todo_breakdown_dependency_reconciliation', status: 'failed_reverted', error: error?.message ?? String(error), rollback_snapshot: { todo: path.join(recoveryDir, 'todo.before.md'), breakdown: path.join(recoveryDir, 'todo-breakdown.before.md') } }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return { applied: false, reason: 'validation_failed_reverted', error: error?.message ?? String(error), recovery_path: path.relative(repoRoot, recoveryDir) };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const result = reconcileTodoBreakdown({ repoRoot: path.resolve(args.repo ?? process.cwd()), todoPath: args.todo, breakdownPath: args.breakdown, runStamp: args['run-stamp'], eventKey: args['event-key'], diagnostic: args.diagnostic });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.applied ? 0 : 1);
  } catch (error) { console.error(JSON.stringify({ applied: false, error: error?.message ?? String(error) })); process.exit(1); }
}
