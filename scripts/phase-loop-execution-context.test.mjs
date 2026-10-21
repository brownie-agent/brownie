import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { bindExecutionContext } from './phase-loop-execution-context.mjs';

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-context-'));
  fs.mkdirSync(path.join(root, '.brownie'), { recursive: true });
  fs.writeFileSync(path.join(root, '.brownie/todo.md'), '- [ ] C-1: Patch only `README.md`\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  return root;
}

test('binds workspace-derived defaults and writes bounded audit', () => {
  const workspace = repo();
  const result = bindExecutionContext({ workspaceRoot: workspace, controllerRoot: workspace });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.context.state_root, path.join(workspace, '.brownie/private/phase-loop'));
  assert.equal(result.context.cli_root, path.join(workspace, 'target/debug/brownie'));
  assert(result.audit.length <= 8192);
});

test('rejects stale controller and cross-workspace state before dispatch', () => {
  const workspace = repo();
  const result = bindExecutionContext({ workspaceRoot: workspace, controllerRoot: path.join(workspace, 'deleted-controller'), stateRoot: path.join(os.tmpdir(), 'foreign-state') });
  assert.equal(result.valid, false);
  assert(result.errors.some((entry) => entry.code === 'controller_root_stale'));
  assert(result.errors.some((entry) => entry.code === 'state_controller_root_mismatch'));
});
