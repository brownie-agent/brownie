#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContractRebaselineReceipt, writeContractRebaselineReceipt } from './phase-loop-todo-contract-rebaseline.mjs';
import { loadCliInput, validateTodoQueueIntegrity } from './phase-loop-todo-queue-integrity.mjs';
import { validateTodoDecomposition } from './guard-todo-decomposition.mjs';

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const stamp = () => new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
function args(argv) { const value = {}; for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith('--')) value[argv[i].slice(2)] = argv[++i]; return value; }
function writeAtomic(file, text) { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 }); fs.renameSync(tmp, file); }
function readPlan(file) {
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (plan.schema_version !== 1 || !plan.before?.todo_sha256 || !plan.before?.breakdown_sha256 || !Array.isArray(plan.todo_ids) || !plan.diagnostic) throw new Error('invalid transactional TODO migration plan');
  return plan;
}
function recoverInterrupted(repoRoot) {
  const root = path.join(repoRoot, '.brownie/private/phase-loop/todo-claims/transactional-migrations');
  let entries = []; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  const started = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name)).filter((directory) => {
    try { return JSON.parse(fs.readFileSync(path.join(directory, 'record.json'), 'utf8')).status === 'started'; } catch { return false; }
  });
  if (started.length !== 1) { if (started.length > 1) throw new Error('ambiguous interrupted transactional migrations'); return null; }
  const directory = started[0];
  return { directory, todo: fs.readFileSync(path.join(directory, 'todo.before.md'), 'utf8'), breakdown: fs.readFileSync(path.join(directory, 'todo-breakdown.before.md'), 'utf8') };
}

// Applies a precomputed two-file migration only when both exact input hashes
// match. Every write has snapshots and is reverted unless all guards pass.
export function migrateTodoTransaction({ repoRoot, planPath, afterTodoPath, afterBreakdownPath, runStamp = stamp() }) {
  const interrupted = recoverInterrupted(repoRoot);
  if (interrupted) {
    writeAtomic(path.join(repoRoot, '.brownie/todo.md'), interrupted.todo); writeAtomic(path.join(repoRoot, '.brownie/todo-breakdown.md'), interrupted.breakdown);
    writeAtomic(path.join(interrupted.directory, 'record.json'), `${JSON.stringify({ schema_version: 1, record_type: 'transactional_todo_migration', status: 'interrupted_reverted', rollback_snapshot: interrupted.directory }, null, 2)}\n`);
    return { applied: false, reason: 'interrupted_migration_reverted' };
  }
  const plan = readPlan(planPath);
  const todoFile = path.join(repoRoot, '.brownie/todo.md');
  const breakdownFile = path.join(repoRoot, '.brownie/todo-breakdown.md');
  const beforeTodo = fs.readFileSync(todoFile, 'utf8');
  const beforeBreakdown = fs.readFileSync(breakdownFile, 'utf8');
  const queueBaseline = loadCliInput({ repo: repoRoot, todo: '.brownie/todo.md', breakdown: '.brownie/todo-breakdown.md' });
  if (sha256(beforeTodo) !== plan.before.todo_sha256 || sha256(beforeBreakdown) !== plan.before.breakdown_sha256) return { applied: false, reason: 'baseline_hash_mismatch' };
  const afterTodo = fs.readFileSync(afterTodoPath, 'utf8');
  const afterBreakdown = fs.readFileSync(afterBreakdownPath, 'utf8');
  const key = sha256(`${plan.before.todo_sha256}\n${plan.before.breakdown_sha256}\n${sha256(afterTodo)}\n${sha256(afterBreakdown)}`);
  const directory = path.join(repoRoot, '.brownie/private/phase-loop/todo-claims/transactional-migrations', key);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'todo.before.md'), beforeTodo, { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'todo-breakdown.before.md'), beforeBreakdown, { mode: 0o600 });
  writeAtomic(path.join(directory, 'record.json'), `${JSON.stringify({ schema_version: 1, record_type: 'transactional_todo_migration', status: 'started', plan, rollback_snapshot: directory }, null, 2)}\n`);
  try {
    writeAtomic(todoFile, afterTodo); writeAtomic(breakdownFile, afterBreakdown);
    const receipt = buildContractRebaselineReceipt({ repoRoot, beforeTodoText: queueBaseline.todoBefore ?? beforeTodo, afterTodoText: afterTodo, beforeBreakdownText: queueBaseline.beforeBreakdownText ?? beforeBreakdown, afterBreakdownText: afterBreakdown, runStamp, eventKey: key, diagnostic: plan.diagnostic, todoIds: plan.todo_ids, verification: { repair_command: 'node scripts/phase-loop-todo-transactional-migrate.mjs', guard_command: 'node scripts/guard-todo-decomposition.mjs', integrity_command: 'pnpm -s phase-loop:todo-queue-integrity' } });
    const decompositionErrors = validateTodoDecomposition(repoRoot, '.brownie/todo.md', '.brownie/todo-breakdown.md');
    const integrity = validateTodoQueueIntegrity({ ...queueBaseline, todoAfter: afterTodo, afterBreakdownText: afterBreakdown, contractRebaselineRecords: receipt ? [...queueBaseline.contractRebaselineRecords, receipt] : queueBaseline.contractRebaselineRecords });
    if (decompositionErrors.length || !integrity.valid) throw new Error(JSON.stringify({ decompositionErrors, integrity }));
    const receiptPath = receipt && writeContractRebaselineReceipt(repoRoot, receipt);
    writeAtomic(path.join(directory, 'record.json'), `${JSON.stringify({ schema_version: 1, record_type: 'transactional_todo_migration', status: 'applied', plan, receipt_path: receiptPath, rollback_snapshot: directory }, null, 2)}\n`);
    return { applied: true, receipt_path: receiptPath, recovery_path: path.relative(repoRoot, directory) };
  } catch (error) {
    writeAtomic(todoFile, beforeTodo); writeAtomic(breakdownFile, beforeBreakdown);
    writeAtomic(path.join(directory, 'record.json'), `${JSON.stringify({ schema_version: 1, record_type: 'transactional_todo_migration', status: 'failed_reverted', plan, error: String(error?.message ?? error), rollback_snapshot: directory }, null, 2)}\n`);
    return { applied: false, reason: 'validation_failed_reverted', recovery_path: path.relative(repoRoot, directory) };
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const input = args(process.argv.slice(2));
  try { const result = migrateTodoTransaction({ repoRoot: path.resolve(input.repo ?? process.cwd()), planPath: path.resolve(input.plan), afterTodoPath: path.resolve(input['after-todo']), afterBreakdownPath: path.resolve(input['after-breakdown']), runStamp: input['run-stamp'] }); console.log(JSON.stringify(result, null, 2)); process.exit(result.applied ? 0 : 1); } catch (error) { console.error(JSON.stringify({ applied: false, error: String(error?.message ?? error) })); process.exit(1); }
}
