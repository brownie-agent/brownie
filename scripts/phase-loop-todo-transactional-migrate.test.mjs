import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

test('transactional migration refuses a stale two-file baseline without writes', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-transactional-migration-'));
  fs.mkdirSync(path.join(repo, '.brownie'), { recursive: true });
  const todo = path.join(repo, '.brownie/todo.md');
  const breakdown = path.join(repo, '.brownie/todo-breakdown.md');
  fs.writeFileSync(todo, '- [ ] T-1: Patch only `README.md`:\n  Route: implementation.\n  Depends on: <none>.\n  Completion condition: update README.\n  Forbidden changes: none.\n  Verification: run `node --version`.\n');
  fs.writeFileSync(breakdown, '# Brownie TODO breakdown\n');
  const plan = path.join(repo, 'plan.json');
  const afterTodo = path.join(repo, 'after-todo.md');
  const afterBreakdown = path.join(repo, 'after-breakdown.md');
  fs.writeFileSync(plan, JSON.stringify({ schema_version: 1, before: { todo_sha256: 'stale', breakdown_sha256: 'stale' }, todo_ids: ['T-1'], diagnostic: 'fixture' }));
  fs.writeFileSync(afterTodo, 'changed\n'); fs.writeFileSync(afterBreakdown, 'changed\n');
  const script = path.resolve('scripts/phase-loop-todo-transactional-migrate.mjs');
  assert.throws(() => execFileSync('node', [script, '--repo', repo, '--plan', plan, '--after-todo', afterTodo, '--after-breakdown', afterBreakdown], { encoding: 'utf8' }));
  assert.match(fs.readFileSync(todo, 'utf8'), /T-1/);
  assert.equal(fs.readFileSync(breakdown, 'utf8'), '# Brownie TODO breakdown\n');
});
