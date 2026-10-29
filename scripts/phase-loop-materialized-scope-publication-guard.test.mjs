import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { protectedContract } from './phase-loop-todo-contract-rebaseline.mjs';
import { guardMaterializedScopePublication } from './phase-loop-materialized-scope-publication-guard.mjs';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function todo(firstLine) {
  return `${firstLine}\n  Route: implementation.\n  Depends on: <none>.\n  Completion condition: complete.\n  Forbidden changes: none.\n  Verification: run \`node --test\`.\n`;
}

function receipt({ id, before, after, target, placeholderSha256, runStamp }) {
  return {
    schema_version: 1,
    record_type: 'todo_contract_rebaseline',
    status: 'approved',
    target_todo_ids: [id],
    contract_changes: [{
      todo_id: id,
      changed_fields: ['first_line'],
      before_contract: protectedContract(before),
      after_contract: protectedContract(after)
    }],
    cause_run: { run_stamp: runStamp, event_key: `${runStamp}-event`, diagnostic_sha256: 'a'.repeat(64) },
    target_capture: { mode: 'legacy_materialized_scope_operation_rebaseline' },
    target_snapshots: [{ operation: 'Patch', path: target, exists_before: true, sha256_before: placeholderSha256, exists_after: true, sha256_after: placeholderSha256 }]
  };
}

function writeReceipt(root, value) {
  const directory = path.join(root, '.brownie/private/phase-loop/todo-claims/contract-rebaselines');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${value.cause_run.run_stamp}.json`), `${JSON.stringify(value)}\n`);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-materialized-publication-'));
  const id = 'E-fixture';
  const target = 'scripts/journey.mjs';
  const before = todo(`- [ ] ${id}: Create only \`${target}\`:`);
  const after = todo(`- [ ] ${id}: Patch only \`${target}\`:`);
  fs.mkdirSync(path.join(root, '.brownie'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, '.brownie/todo.md'), before);
  fs.writeFileSync(path.join(root, '.brownie/todo-breakdown.md'), 'Dependency graph:\n');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Brownie test']);
  git(root, ['config', 'user.email', 'brownie@example.invalid']);
  git(root, ['add', '.brownie/todo.md', '.brownie/todo-breakdown.md']);
  git(root, ['commit', '-qm', 'baseline']);
  const targetPath = path.join(root, target);
  fs.writeFileSync(targetPath, '// brownie bounded create-only proposal\n');
  const placeholderSha256 = sha256File(targetPath);
  fs.writeFileSync(targetPath, 'export const journey = "implemented";\n');
  fs.writeFileSync(path.join(root, '.brownie/todo.md'), after);
  writeReceipt(root, receipt({ id, before, after, target, placeholderSha256, runStamp: 'fixture-run' }));
  return { root, id, target, before, after };
}

test('is a no-op when no approved materialized-scope transition exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-materialized-publication-empty-'));
  const result = guardMaterializedScopePublication({ repoRoot: root, applyIndex: true });
  assert.equal(result.valid, true, JSON.stringify(result, null, 2));
  assert.equal(result.applied, false);
  assert.deepEqual(result.checked, []);
  assert.deepEqual(result.auto_staged_todo_ids, []);
});

test('stages only the approved TODO transition once the implementation target is staged', () => {
  const { root, id, target, after } = fixture();
  git(root, ['add', target]);
  const result = guardMaterializedScopePublication({ repoRoot: root, applyIndex: true });
  assert.equal(result.valid, true, JSON.stringify(result, null, 2));
  assert.equal(result.applied, true);
  assert.deepEqual(result.auto_staged_todo_ids, [id]);
  assert.equal(git(root, ['show', ':.brownie/todo.md']), after.trim());
  assert.deepEqual(git(root, ['diff', '--cached', '--name-only']).split('\n').sort(), ['.brownie/todo.md', target].sort());
});

test('fails before mutating the index when the materialized implementation target is absent from the candidate', () => {
  const { root } = fixture();
  const result = guardMaterializedScopePublication({ repoRoot: root, applyIndex: true });
  assert.equal(result.valid, false);
  assert(result.errors.some((error) => error.code === 'materialized_scope_target_not_staged'));
  assert.equal(git(root, ['diff', '--cached', '--name-only']), '');
});

test('rejects an index contract that is neither the recorded before-state nor after-state', () => {
  const { root, target, after } = fixture();
  fs.writeFileSync(path.join(root, '.brownie/todo.md'), todo('- [ ] E-fixture: Patch only `scripts/other.mjs`:'));
  git(root, ['add', '.brownie/todo.md', target]);
  fs.writeFileSync(path.join(root, '.brownie/todo.md'), after);
  const result = guardMaterializedScopePublication({ repoRoot: root, applyIndex: true });
  assert.equal(result.valid, false);
  assert(result.errors.some((error) => error.code === 'materialized_scope_index_contract_mismatch'));
});

test('applies an approved multi-receipt Create-to-Patch chain without broad staging', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-materialized-publication-chain-'));
  const id = 'E-chain';
  const firstTarget = 'scripts/first.mjs';
  const secondTarget = 'scripts/second.mjs';
  const before = todo(`- [ ] ${id}: Create only \`${firstTarget}\`, then create only \`${secondTarget}\`:`);
  const middle = todo(`- [ ] ${id}: Patch only \`${firstTarget}\`, then create only \`${secondTarget}\`:`);
  const after = todo(`- [ ] ${id}: Patch only \`${firstTarget}\`, then patch only \`${secondTarget}\`:`);
  fs.mkdirSync(path.join(root, '.brownie'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, '.brownie/todo.md'), before);
  fs.writeFileSync(path.join(root, '.brownie/todo-breakdown.md'), 'Dependency graph:\n');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Brownie test']);
  git(root, ['config', 'user.email', 'brownie@example.invalid']);
  git(root, ['add', '.brownie/todo.md', '.brownie/todo-breakdown.md']);
  git(root, ['commit', '-qm', 'baseline']);
  const firstPath = path.join(root, firstTarget);
  const secondPath = path.join(root, secondTarget);
  fs.writeFileSync(firstPath, '// brownie bounded create-only proposal\n');
  const firstPlaceholder = sha256File(firstPath);
  fs.writeFileSync(secondPath, '// brownie bounded create-only proposal\n');
  const secondPlaceholder = sha256File(secondPath);
  fs.writeFileSync(firstPath, 'export const first = true;\n');
  fs.writeFileSync(secondPath, 'export const second = true;\n');
  fs.writeFileSync(path.join(root, '.brownie/todo.md'), after);
  writeReceipt(root, receipt({ id, before, after: middle, target: firstTarget, placeholderSha256: firstPlaceholder, runStamp: 'chain-first' }));
  writeReceipt(root, receipt({ id, before: middle, after, target: secondTarget, placeholderSha256: secondPlaceholder, runStamp: 'chain-second' }));
  git(root, ['add', firstTarget, secondTarget]);
  const result = guardMaterializedScopePublication({ repoRoot: root, applyIndex: true });
  assert.equal(result.valid, true, JSON.stringify(result, null, 2));
  assert.equal(git(root, ['show', ':.brownie/todo.md']), after.trim());
  assert.deepEqual(result.checked[0].receipt_run_stamps, ['chain-first', 'chain-second']);
});
