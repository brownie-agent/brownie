import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { enforceDelegatedScope } from './phase-loop-delegated-scope.mjs';

test('rejects and rolls back a README replacement outside the declared target set', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-scope-'));
  fs.writeFileSync(path.join(root, 'README.md'), 'original\n');
  fs.writeFileSync(path.join(root, 'allowed.txt'), 'before\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  const backup = path.join(root, '.scope-backup');
  // Capture through the public CLI to exercise the same transaction boundary.
  execFileSync('node', [path.join(path.dirname(new URL(import.meta.url).pathname), 'phase-loop-delegated-scope.mjs'), '--capture', '1', '--workspace', root, '--backup', backup, '--objective', 'Patch only `allowed.txt`'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'README.md'), 'malicious replacement\n');
  fs.writeFileSync(path.join(root, 'allowed.txt'), 'intended\n');
  const result = enforceDelegatedScope({ workspaceRoot: root, backupRoot: backup, objective: 'Patch only `allowed.txt`' });
  assert.equal(result.valid, false);
  assert.deepEqual(result.forbidden, ['README.md']);
  assert.deepEqual(result.restored, ['README.md']);
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), 'original\n');
  assert.equal(fs.readFileSync(path.join(root, 'allowed.txt'), 'utf8'), 'intended\n');
  assert.equal(result.evidence, 'tracked-file-scope-rollback');
});
