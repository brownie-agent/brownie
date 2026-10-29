import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateMaterializedScopeRebaseline } from './phase-loop-admit-materialized-scope-rebaseline.mjs';

function contract(firstLine) {
  return { id: 'E-fixture', first_line: firstLine, route: 'implementation', depends_on: '<none>', completion_condition: 'complete', forbidden_changes: 'none', verification: 'run `node --test`' };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-materialized-scope-'));
  const target = 'scripts/journey.mjs';
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, target), '// placeholder\n');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, target))).digest('hex');
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
