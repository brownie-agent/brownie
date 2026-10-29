import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { rebaselineWorkspaceToApprovedBaseline } from './phase-loop-workspace-baseline-rebaseline.mjs';

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function writeControllerManifest(root) {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'phase-loop.sh'), '#!/usr/bin/env bash\nexit 0\n');
  fs.writeFileSync(path.join(root, 'scripts/phase-loop-controller-source-manifest.json'), `${JSON.stringify({
    schema_version: 1,
    controller_source_paths: ['phase-loop.sh']
  }, null, 2)}\n`);
}

function makeRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-workspace-rebaseline-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Brownie test']);
  git(root, ['config', 'user.email', 'brownie@example.invalid']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.brownie/private/\nignored-local.txt\n');
  writeControllerManifest(root);
  fs.writeFileSync(path.join(root, 'README.md'), 'baseline\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'baseline']);
  git(root, ['branch', '-M', 'worker']);
  git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return root;
}

function advanceApprovedBaseline(root, file = 'approved.txt') {
  const oldHead = git(root, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(root, file), 'approved baseline advance\n');
  git(root, ['add', '--force', file]);
  git(root, ['commit', '-qm', 'approved baseline advance']);
  const approvedHead = git(root, ['rev-parse', 'HEAD']);
  git(root, ['update-ref', 'refs/remotes/origin/main', approvedHead]);
  git(root, ['checkout', '-q', '-B', 'worker', oldHead]);
  return { oldHead, approvedHead };
}

function stateDir(root) {
  return path.join(root, '.brownie/private/phase-loop');
}

test('fast-forwards only a strict approved descendant and preserves unrelated dirty state', () => {
  const root = makeRepository();
  const { oldHead, approvedHead } = advanceApprovedBaseline(root);
  fs.writeFileSync(path.join(root, 'operator-notes.txt'), 'preserve this dirty file\n');

  const result = rebaselineWorkspaceToApprovedBaseline({
    repoRoot: root,
    stateDir: stateDir(root),
    runStamp: 'test-safe-fast-forward',
    refreshBaseline: false,
    now: () => new Date('2026-10-29T10:00:00.000Z')
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.rebaselined, true);
  assert.equal(result.workspace_head_before, oldHead);
  assert.equal(result.workspace_head_after, approvedHead);
  assert.equal(git(root, ['rev-parse', 'HEAD']), approvedHead);
  assert.equal(fs.readFileSync(path.join(root, 'operator-notes.txt'), 'utf8'), 'preserve this dirty file\n');
  assert.equal(git(root, ['status', '--porcelain']).trim(), '?? operator-notes.txt');
  const audit = JSON.parse(fs.readFileSync(result.audit_path, 'utf8'));
  assert.equal(audit.status, 'applied');
  assert.deepEqual(audit.dirty_paths_before, ['operator-notes.txt']);
  assert.deepEqual(audit.dirty_paths_after, ['operator-notes.txt']);
});

test('refuses a fast-forward that would touch an existing dirty path', () => {
  const root = makeRepository();
  const { oldHead } = advanceApprovedBaseline(root, 'shared.txt');
  fs.writeFileSync(path.join(root, 'shared.txt'), 'operator-local change\n');

  const result = rebaselineWorkspaceToApprovedBaseline({
    repoRoot: root,
    stateDir: stateDir(root),
    refreshBaseline: false
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'dirty_paths_overlap_approved_baseline_delta');
  assert.deepEqual(result.overlapping_dirty_paths, ['shared.txt']);
  assert.equal(git(root, ['rev-parse', 'HEAD']), oldHead);
  assert.equal(fs.readFileSync(path.join(root, 'shared.txt'), 'utf8'), 'operator-local change\n');
});

test('refuses a fast-forward that would overwrite an ignored local file', () => {
  const root = makeRepository();
  const { oldHead } = advanceApprovedBaseline(root, 'ignored-local.txt');
  fs.writeFileSync(path.join(root, 'ignored-local.txt'), 'operator-local ignored contents\n');

  const result = rebaselineWorkspaceToApprovedBaseline({
    repoRoot: root,
    stateDir: stateDir(root),
    refreshBaseline: false
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'git_fast_forward_failed');
  assert.equal(git(root, ['rev-parse', 'HEAD']), oldHead);
  assert.equal(fs.readFileSync(path.join(root, 'ignored-local.txt'), 'utf8'), 'operator-local ignored contents\n');
  const audit = JSON.parse(fs.readFileSync(result.audit_path, 'utf8'));
  assert.equal(audit.status, 'failed');
  assert.equal(audit.failure_reason, 'git_fast_forward_failed');
});

test('refuses a dirty controller source even when the approved delta is elsewhere', () => {
  const root = makeRepository();
  const { oldHead } = advanceApprovedBaseline(root, 'approved.txt');
  fs.writeFileSync(path.join(root, 'phase-loop.sh'), '#!/usr/bin/env bash\necho local\n');

  const result = rebaselineWorkspaceToApprovedBaseline({
    repoRoot: root,
    stateDir: stateDir(root),
    refreshBaseline: false
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'dirty_controller_source_refuses_rebaseline');
  assert.deepEqual(result.dirty_controller_paths, ['phase-loop.sh']);
  assert.equal(git(root, ['rev-parse', 'HEAD']), oldHead);
});

test('marks a phase-loop shell update for process reload after rebaseline', () => {
  const root = makeRepository();
  advanceApprovedBaseline(root, 'phase-loop.sh');

  const result = rebaselineWorkspaceToApprovedBaseline({
    repoRoot: root,
    stateDir: stateDir(root),
    refreshBaseline: false
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.rebaselined, true);
  assert.equal(result.controller_shell_reload_required, true);
  const audit = JSON.parse(fs.readFileSync(result.audit_path, 'utf8'));
  assert.equal(audit.controller_shell_source_changed, true);
});

test('refuses diverged history instead of merging or resetting it', () => {
  const root = makeRepository();
  advanceApprovedBaseline(root, 'approved.txt');
  fs.writeFileSync(path.join(root, 'worker.txt'), 'worker-only commit\n');
  git(root, ['add', 'worker.txt']);
  git(root, ['commit', '-qm', 'worker-only commit']);
  const workerHead = git(root, ['rev-parse', 'HEAD']);

  const result = rebaselineWorkspaceToApprovedBaseline({
    repoRoot: root,
    stateDir: stateDir(root),
    refreshBaseline: false
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'workspace_history_diverged_from_approved_baseline');
  assert.equal(git(root, ['rev-parse', 'HEAD']), workerHead);
});

test('is a no-op when the workspace already contains the approved baseline', () => {
  const root = makeRepository();
  const result = rebaselineWorkspaceToApprovedBaseline({
    repoRoot: root,
    stateDir: stateDir(root),
    refreshBaseline: false
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.rebaselined, false);
  assert.equal(result.reason, 'workspace_already_contains_approved_baseline');
});

test('controller invokes workspace rebaseline before its approved-baseline guard', () => {
  const controller = fs.readFileSync(new URL('../phase-loop.sh', import.meta.url), 'utf8');
  const rebaselineCall = controller.indexOf('phase_loop_rebaseline_workspace_to_approved_baseline "$run_stamp"');
  const baselineGuard = controller.indexOf('if ! phase_loop_require_approved_controller_baseline; then');
  assert(rebaselineCall >= 0, 'controller must invoke the workspace rebaseline helper');
  assert(baselineGuard >= 0, 'controller must keep the approved baseline guard');
  assert(rebaselineCall < baselineGuard, 'workspace rebaseline must precede the approved baseline guard');
});

test('controller reloads its process before using a fast-forwarded phase-loop shell source', () => {
  const controller = fs.readFileSync(new URL('../phase-loop.sh', import.meta.url), 'utf8');
  assert.match(controller, /controller_shell_reload_required/u);
  assert.match(controller, /phase_loop_reload_supervisor_source\(\)/u);
  assert.match(controller, /exec \/bin\/bash "\$ROOT_DIR\/phase-loop\.sh" supervise/u);
  assert.match(controller, /exec \/bin\/bash "\$ROOT_DIR\/phase-loop\.sh" run-once/u);
});

test('controller reload detection canonicalizes an aliased workspace root', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-controller-reload-alias-'));
  const controllerRoot = path.join(sandbox, 'controller');
  const stateDir = path.join(sandbox, 'state');
  const fakeBin = path.join(sandbox, 'bin');
  fs.mkdirSync(path.join(controllerRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(controllerRoot, 'scripts/phase-loop-workspace-baseline-rebaseline.mjs'), '// fixture\n');
  const fakeNode = path.join(fakeBin, 'node');
  fs.writeFileSync(fakeNode, '#!/usr/bin/env bash\nprintf \'%s\\n\' \'{"ok":true,"rebaselined":true,"controller_shell_reload_required":true}\'\n');
  fs.chmodSync(fakeNode, 0o755);

  const controller = fs.readFileSync(new URL('../phase-loop.sh', import.meta.url), 'utf8');
  const start = controller.indexOf('phase_loop_rebaseline_workspace_to_approved_baseline() {');
  const end = controller.indexOf('\nphase_loop_rebaseline_stale_claim()', start);
  assert(start >= 0 && end > start, 'workspace rebaseline shell helper must be extractable');
  const helper = controller.slice(start, end);
  const workspaceAlias = `${controllerRoot}${path.sep}..${path.sep}controller`;
  const output = execFileSync('bash', ['-ceu', `${helper}\nnow_utc() { printf \'2026-10-29T00:00:00Z\'; }\nphase_loop_rebaseline_workspace_to_approved_baseline test-run\nprintf \'%s\\n\' "$PHASE_LOOP_CONTROLLER_SHELL_RELOAD_REQUIRED"`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ROOT_DIR: controllerRoot,
      PHASE_LOOP_WORKSPACE_ROOT: workspaceAlias,
      PHASE_LOOP_APPROVED_CONTROLLER_BASELINE: 'origin/main',
      STATE_DIR: stateDir,
      SUPERVISOR_LOG: path.join(stateDir, 'logs', 'supervisor.log'),
      PHASE_LOOP_CONTROLLER_SHELL_RELOAD_REQUIRED: '0',
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`
    }
  }).trim();
  assert.equal(output, '1');
});
