import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildSelfUpdateObjective, dispatchSelfUpdate, evaluateSelfUpdateEligibility } from './phase-loop-self-update.mjs';

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-self-update-'));
  fs.mkdirSync(path.join(repo, '.brownie/private/phase-loop'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'target/debug'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.brownie/todo.md'), '- [ ] E-test: Patch only `scripts/example.mjs`:\n  Route: implementation.\n');
  fs.writeFileSync(path.join(repo, '.brownie/todo-breakdown.md'), '# breakdown\n');
  fs.writeFileSync(path.join(repo, 'target/debug/brownie'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(repo, 'package.json'), '{}\n');
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, '.brownie/private/phase-loop/status.json'), JSON.stringify({ status: 'no_progress' }));
  return repo;
}

test('plans a self-update only while the phase loop is stopped and source tree is clean', () => {
  const repo = makeRepo();
  const eligibility = evaluateSelfUpdateEligibility({ repoRoot: repo, request: 'Repair controller policy contradiction.' });
  assert.equal(eligibility.eligible, true, JSON.stringify(eligibility));
  const objective = buildSelfUpdateObjective({ request: 'Repair controller policy contradiction.', eligibility });
  assert.match(objective, /do not edit .brownie\/todo\.md/u);
  assert.match(objective, /Repair controller policy contradiction/u);
});

test('refuses self-update when user source changes are present', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'user-change.txt'), 'preserve me\n');
  const eligibility = evaluateSelfUpdateEligibility({ repoRoot: repo, request: 'Repair controller policy contradiction.' });
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reason, 'non_brownie_workspace_changes_present');
});

test('dispatches Brownie through an immutable private objective and records the result', () => {
  const repo = makeRepo();
  let invocation;
  const result = dispatchSelfUpdate({
    repoRoot: repo,
    request: 'Repair controller policy contradiction.',
    now: () => new Date('2026-10-09T00:00:00.000Z'),
    run(command, args, options) {
      if (command === 'git') return spawnSync(command, args, options);
      invocation = { command, args, options };
      return { status: 0, stdout: '{"ok":true}', stderr: '' };
    }
  });
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(result.ok, true);
  assert.deepEqual(invocation.args.slice(0, 3), ['--json', 'run', '--file']);
  assert.equal(fs.existsSync(path.join(repo, result.objective_path)), true);
  assert.equal(fs.existsSync(path.join(repo, result.result_path)), true);
});
