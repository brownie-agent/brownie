import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { reconcileCompletedTodoProjection } from './phase-loop-todo-completion-reconcile.mjs';

const todoId = 'E-completed-projection';
const todo = `- [ ] ${todoId}: preserve the contract\n  - Route: implement\n  - Depends on: <none>.\n`;

test('archives only a non-invalidated durable completion from the live queue with rollback evidence', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-completion-projection-'));
  fs.mkdirSync(path.join(repo, '.brownie/private/phase-loop/todo-completions'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.brownie/todo.md'), todo);
  fs.writeFileSync(path.join(repo, '.brownie/private/phase-loop/todo-completions/receipt.json'), JSON.stringify({ selected_todo_id: todoId, claim_id: 'claim-1' }));
  const result = reconcileCompletedTodoProjection({ repoRoot: repo, runStamp: 'run-fixture' });
  assert.equal(result.applied, true, JSON.stringify(result));
  assert.deepEqual(result.completed_todo_ids, [todoId]);
  assert.doesNotMatch(fs.readFileSync(path.join(repo, '.brownie/todo.md'), 'utf8'), /E-completed-projection/);
  assert.equal(fs.existsSync(path.join(repo, result.recovery_path, 'todo.before.md')), true);
});

test('does not project a completion that has an exact durable invalidation', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-completion-projection-invalidated-'));
  fs.mkdirSync(path.join(repo, '.brownie/private/phase-loop/todo-completions'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.brownie/private/phase-loop/todo-completion-invalidations'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.brownie/todo.md'), todo);
  fs.writeFileSync(path.join(repo, '.brownie/private/phase-loop/todo-completions/receipt.json'), JSON.stringify({ selected_todo_id: todoId, claim_id: 'claim-1' }));
  fs.writeFileSync(path.join(repo, '.brownie/private/phase-loop/todo-completion-invalidations/invalidation.json'), JSON.stringify({ record_type: 'todo_completion_invalidation', selected_todo_id: todoId, invalidated_completion_claim_id: 'claim-1', reason: 'fixture' }));
  const result = reconcileCompletedTodoProjection({ repoRoot: repo });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'no_completed_todo_projection_drift');
  assert.match(fs.readFileSync(path.join(repo, '.brownie/todo.md'), 'utf8'), /- \[ \] E-completed-projection/);
});
