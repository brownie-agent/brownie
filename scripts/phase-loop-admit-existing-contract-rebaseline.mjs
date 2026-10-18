#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildContractRebaselineReceipt,
  contractMap,
  writeContractRebaselineReceipt
} from './phase-loop-todo-contract-rebaseline.mjs';
import { readAllTodoReplanRecords, resolveTodoState } from './phase-loop-todo-state.mjs';

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

function runGuard(repoRoot) {
  execFileSync(process.execPath, ['scripts/guard-todo-decomposition.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function dependencies(block) {
  const line = String(block ?? '').split('\n').map((entry) => entry.trim()).find((entry) => entry.startsWith('Depends on:'));
  if (!line) return [];
  return line.slice('Depends on:'.length).trim().replace(/[.]$/u, '').split(/\s*,\s*/u).filter((entry) => entry && entry !== '<none>');
}

function validateRebaselineShape({ beforeTodoText, afterTodoText, repoRoot, breakdownPath }) {
  const before = contractMap(beforeTodoText);
  const after = contractMap(afterTodoText);
  const state = resolveTodoState({
    todoText: afterTodoText,
    replanRecords: readAllTodoReplanRecords(repoRoot, { breakdownPath }),
    completionRecords: []
  });
  const childrenByParent = new Map();
  for (const record of state.replanRecords) {
    childrenByParent.set(record.parent_todo_id, new Set(record.generated_child_ids));
  }
  const changes = [];
  for (const [id, beforeBlock] of before) {
    const afterBlock = after.get(id);
    if (!afterBlock) continue;
    // A checked block is terminal evidence, not a live queue contract.  The
    // existing-drift admission only authorizes surviving unchecked queue
    // items; its completion transition is recorded separately by the normal
    // completion/replan ledgers.
    if (/^(?:[-*]|\d+[.)])\s+\[[xX]\]\s+/u.test(afterBlock)) continue;
    const beforeDeps = dependencies(beforeBlock);
    const afterDeps = dependencies(afterBlock);
    if (beforeDeps.join(', ') === afterDeps.join(', ')) continue;
    if (beforeDeps.length === 0 || afterDeps.length === 0) {
      throw new Error(`unsupported existing contract rebaseline shape for ${id}`);
    }
    const parent = beforeDeps.find((dependency) => !afterDeps.includes(dependency)) ?? beforeDeps[0];
    const children = childrenByParent.get(parent);
    if (!children || !afterDeps.every((dependency) => children.has(dependency))) {
      throw new Error(`contract rebaseline for ${id} does not match an approved live child frontier of ${parent}`);
    }
    if (!afterDeps.every((dependency) => state.liveIds.has(dependency) || state.completedIds.has(dependency))) {
      throw new Error(`contract rebaseline for ${id} points at a non-live or non-completed child`);
    }
    changes.push({ id, parent, beforeDeps, afterDeps });
  }
  if (changes.length === 0) throw new Error('no surviving TODO contract rebaseline found');
  return changes;
}

export function admitExistingContractRebaseline({
  repoRoot,
  baselineRef,
  runStamp,
  eventKey,
  diagnostic
}) {
  const todoPath = path.join(repoRoot, '.brownie/todo.md');
  const breakdownPath = path.join(repoRoot, '.brownie/todo-breakdown.md');
  const beforeTodoText = gitShow(repoRoot, baselineRef, '.brownie/todo.md');
  const beforeBreakdownText = gitShow(repoRoot, baselineRef, '.brownie/todo-breakdown.md');
  const afterTodoText = fs.readFileSync(todoPath, 'utf8');
  const afterBreakdownText = fs.readFileSync(breakdownPath, 'utf8');
  const changes = validateRebaselineShape({ beforeTodoText, afterTodoText, repoRoot, breakdownPath });
  runGuard(repoRoot);
  const receipt = buildContractRebaselineReceipt({
    repoRoot,
    beforeTodoText,
    afterTodoText,
    beforeBreakdownText,
    afterBreakdownText,
    todoIds: changes.map((change) => change.id),
    runStamp,
    eventKey,
    diagnostic,
    verification: {
      repair_command: 'node scripts/phase-loop-admit-existing-contract-rebaseline.mjs',
      guard_command: 'node scripts/guard-todo-decomposition.mjs',
      integrity_command: 'pnpm -s phase-loop:todo-queue-integrity'
    }
  });
  const receiptPath = writeContractRebaselineReceipt(repoRoot, receipt);
  return { applied: true, receipt_path: receiptPath, changes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = admitExistingContractRebaseline({
      repoRoot: path.resolve(args.repo ?? process.cwd()),
      baselineRef: args['baseline-ref'] ?? 'HEAD',
      runStamp: args['run-stamp'],
      eventKey: args['event-key'],
      diagnostic: args.diagnostic
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ applied: false, error: error?.message ?? String(error) }, null, 2));
    process.exit(1);
  }
}
