import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { inspectWorkspaceBaseline } from './phase-loop-workspace-baseline-guard.mjs';

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-workspace-baseline-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Brownie test']);
  git(root, ['config', 'user.email', 'brownie@example.invalid']);
  fs.writeFileSync(path.join(root, 'README.md'), 'baseline\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'baseline']);
  git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return root;
}

test('accepts a workspace whose HEAD contains approved origin/main', () => {
  const root = makeRepository();
  fs.writeFileSync(path.join(root, 'README.md'), 'baseline\nnew work\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'new work']);
  const result = inspectWorkspaceBaseline({ workspaceRoot: root, refreshBaseline: false });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.baseline_is_ancestor, true);
});

test('fails closed when workspace HEAD predates approved origin/main', () => {
  const root = makeRepository();
  const oldHead = git(root, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(root, 'README.md'), 'baseline\nmain advance\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'main advance']);
  git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(root, ['checkout', '-q', '--detach', oldHead]);
  const result = inspectWorkspaceBaseline({ workspaceRoot: root, refreshBaseline: false });
  assert.equal(result.ok, false);
  assert.equal(result.baseline_is_ancestor, false);
  assert(result.errors.some((error) => error.includes('snapshot and explicitly rebaseline the workspace before claim')));
});

test('fails closed when the workspace baseline cannot be resolved', () => {
  const root = makeRepository();
  git(root, ['update-ref', '-d', 'refs/remotes/origin/main']);
  const result = inspectWorkspaceBaseline({ workspaceRoot: root, refreshBaseline: false });
  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes('workspace baseline origin/main could not be resolved')));
});
