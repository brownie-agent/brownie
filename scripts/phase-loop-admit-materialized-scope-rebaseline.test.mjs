import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { admitMaterializedScopeRebaseline, validateMaterializedScopeRebaseline } from './phase-loop-admit-materialized-scope-rebaseline.mjs';

function contract(firstLine) {
  return { id: 'E-fixture', first_line: firstLine, route: 'implementation', depends_on: '<none>', completion_condition: 'complete', forbidden_changes: 'none', verification: 'run `node --test`' };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-materialized-scope-'));
  const target = 'scripts/journey.mjs';
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, target), '// placeholder\n');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, target), 'utf8').trim(), 'utf8').digest('hex');
  const records = [{ target_todo_ids: ['E-fixture'], target_capture: { mode: 'legacy_pre_capture_materialization' }, target_snapshots: [{ operation: 'Create', path: target, exists_after: true, sha256_after: sha256 }] }];
  return { root, target, records };
}

test('admits only a captured Create-to-Patch materialization without target expansion', () => {
  const { root, target, records } = fixture();
  const snapshots = validateMaterializedScopeRebaseline({
    beforeContract: contract(`- [ ] E-fixture: Create only \`${target}\`, then patch only \`package.json\`:`),
    afterContract: contract(`- [ ] E-fixture: Patch only \`${target}\`, then patch only \`package.json\`:`),
    repoRoot: root,
    records
  });
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].path, target);
});

test('rejects added scope and uncaptured content', () => {
  const { root, target, records } = fixture();
  assert.throws(() => validateMaterializedScopeRebaseline({
    beforeContract: contract(`- [ ] E-fixture: Create only \`${target}\`:`),
    afterContract: contract(`- [ ] E-fixture: Patch only \`${target}\` and \`package.json\`:`),
    repoRoot: root,
    records
  }), /add, remove, or replace/u);
  fs.writeFileSync(path.join(root, target), '// changed\n');
  assert.throws(() => validateMaterializedScopeRebaseline({
    beforeContract: contract(`- [ ] E-fixture: Create only \`${target}\`:`),
    afterContract: contract(`- [ ] E-fixture: Patch only \`${target}\`:`),
    repoRoot: root,
    records
  }), /not bound/u);
});

test('writes an exact receipt for a captured Create-to-Patch contract drift', () => {
  const { root, target, records } = fixture();
  const before = `- [ ] E-fixture: Create only \`${target}\`, then patch only \`package.json\`:\n  Route: implementation.\n  Depends on: <none>.\n  Completion condition: complete.\n  Forbidden changes: none.\n  Verification: run \`node --test\`.\n`;
  const after = before.replace(`Create only \`${target}\`, then patch only \`package.json\``, `Patch only \`package.json\`, then patch only \`${target}\``);
  fs.mkdirSync(path.join(root, '.brownie'), { recursive: true });
  fs.mkdirSync(path.join(root, '.brownie/private/phase-loop/todo-claims/contract-rebaselines'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, '.brownie/todo.md'), before);
  fs.writeFileSync(path.join(root, '.brownie/todo-breakdown.md'), 'Dependency graph:\n');
  fs.writeFileSync(path.join(root, 'scripts/guard-todo-decomposition.mjs'), 'process.exit(0);\n');
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '.brownie/todo.md', '.brownie/todo-breakdown.md'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.name=Brownie', '-c', 'user.email=brownie@example.invalid', 'commit', '-m', 'baseline'], { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(path.join(root, '.brownie/todo.md'), after);
  fs.writeFileSync(path.join(root, '.brownie/private/phase-loop/todo-claims/contract-rebaselines/capture.json'), `${JSON.stringify(records[0])}\n`);
  const result = admitMaterializedScopeRebaseline({
    repoRoot: root,
    baselineRef: 'HEAD',
    todoId: 'E-fixture',
    runStamp: 'fixture-run',
    eventKey: 'fixture-event',
    diagnostic: 'fixture recovery'
  });
  assert.equal(result.applied, true);
  assert.equal(result.target_snapshots[0].path, target);
  assert.equal(fs.existsSync(path.join(root, result.receipt_path)), true);
});
