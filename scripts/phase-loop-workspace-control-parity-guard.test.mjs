import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectWorkspaceControlParity } from './phase-loop-workspace-control-parity-guard.mjs';

function makeRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeManifest(root) {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/phase-loop-controller-source-manifest.json'), JSON.stringify({
    schema_version: 1,
    control_plane_paths: ['scripts/phase-loop-todo-queue-integrity.mjs', 'scripts/phase-loop-todo-state.mjs']
  }));
}

test('accepts an exact workspace copy of every control-plane helper', () => {
  const controlRoot = makeRoot('brownie-control-root-');
  const workspaceRoot = makeRoot('brownie-workspace-root-');
  writeManifest(controlRoot);
  for (const relativePath of ['scripts/phase-loop-todo-queue-integrity.mjs', 'scripts/phase-loop-todo-state.mjs']) {
    const source = path.join(controlRoot, relativePath);
    const target = path.join(workspaceRoot, relativePath);
    fs.writeFileSync(source, `approved ${relativePath}\n`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  const result = inspectWorkspaceControlParity({ controlRoot, workspaceRoot });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert(result.files.every((file) => file.matches));
});

test('fails closed on divergent or missing workspace control-plane helpers', () => {
  const controlRoot = makeRoot('brownie-control-root-');
  const workspaceRoot = makeRoot('brownie-workspace-root-');
  writeManifest(controlRoot);
  fs.writeFileSync(path.join(controlRoot, 'scripts/phase-loop-todo-queue-integrity.mjs'), 'approved queue guard\n');
  fs.writeFileSync(path.join(controlRoot, 'scripts/phase-loop-todo-state.mjs'), 'approved state helper\n');
  fs.mkdirSync(path.join(workspaceRoot, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'scripts/phase-loop-todo-queue-integrity.mjs'), 'stale queue guard\n');
  const result = inspectWorkspaceControlParity({ controlRoot, workspaceRoot });
  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes('phase-loop-todo-queue-integrity.mjs workspace control-plane source diverges')));
  assert(result.errors.some((error) => error.includes('phase-loop-todo-state.mjs workspace control-plane source is unavailable')));
});
