import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  approvedControllerSourcePaths,
  guardPhaseLoopSourceBaseline
} from './phase-loop-source-baseline-guard.mjs';

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-source-baseline-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Brownie test']);
  git(root, ['config', 'user.email', 'brownie@example.invalid']);
  for (const relativePath of approvedControllerSourcePaths) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `baseline source: ${relativePath}\n`);
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'approved controller baseline']);
  git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return root;
}

test('accepts controller source matching approved origin/main baseline', () => {
  const root = makeRepository();
  const result = guardPhaseLoopSourceBaseline({ repoRoot: root });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.files.every((file) => file.matches), true);
  assert.match(result.source_fingerprint, /^sha256:[0-9a-f]{64}$/u);
});

test('fails closed when a controller source diverges from approved origin/main', () => {
  const root = makeRepository();
  fs.appendFileSync(path.join(root, 'phase-loop.sh'), 'stale controller change\n');
  const result = guardPhaseLoopSourceBaseline({ repoRoot: root });
  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes('phase-loop.sh diverges from approved controller baseline origin/main')));
});

test('fails closed when approved origin/main baseline is unavailable', () => {
  const root = makeRepository();
  git(root, ['update-ref', '-d', 'refs/remotes/origin/main']);
  const result = guardPhaseLoopSourceBaseline({ repoRoot: root });
  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes('approved controller baseline origin/main could not be resolved')));
});

test('phase-loop refuses to enter a Brownie run before the source baseline guard passes', () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const controller = fs.readFileSync(path.join(repositoryRoot, 'phase-loop.sh'), 'utf8');
  const guardIndex = controller.indexOf('phase_loop_require_approved_controller_baseline');
  const runIndex = controller.indexOf('write_status "running" "Brownie run started');
  assert(guardIndex >= 0);
  assert(runIndex > guardIndex);
});
