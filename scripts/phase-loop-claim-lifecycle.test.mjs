import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { claimLifecycleFields, readClaimSnapshot } from './phase-loop-claim-lifecycle.mjs';

test('claim snapshot API distinguishes present, absent, malformed, and deleted-race claims', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-claim-lifecycle-'));
  const present = path.join(root, 'present.json');
  const malformed = path.join(root, 'malformed.json');
  fs.writeFileSync(present, JSON.stringify({ claim_id: 'claim-1', selected_todo: '- [ ] T-1: task' }));
  fs.writeFileSync(malformed, '{not-json');

  assert.deepEqual(readClaimSnapshot(present), {
    ok: true,
    state: 'present',
    claim: { claim_id: 'claim-1', selected_todo: '- [ ] T-1: task' }
  });
  assert.equal(readClaimSnapshot(path.join(root, 'missing.json')).state, 'absent');
  assert.equal(readClaimSnapshot(malformed).state, 'malformed');
  const race = readClaimSnapshot(path.join(root, 'deleted.json'), {
    readFileSync: () => { const error = new Error('deleted during read'); error.code = 'ENOENT'; throw error; }
  });
  assert.equal(race.state, 'absent');
  assert.deepEqual(claimLifecycleFields(race), {
    claim_state: 'absent',
    claim_id: null,
    claim_error_code: 'ENOENT',
    claim_error_message: 'deleted during read'
  });
});

test('controller and task-ledger use the common claim snapshot API instead of direct claim reads', () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const taskLedger = fs.readFileSync(path.join(repoRoot, 'scripts/phase-loop-task-ledger.mjs'), 'utf8');
  const controller = fs.readFileSync(path.join(repoRoot, 'phase-loop.sh'), 'utf8');
  assert.match(taskLedger, /phase-loop-claim-lifecycle\.mjs/u);
  assert.doesNotMatch(taskLedger, /readFileSync\(claimPath/u);
  assert.match(controller, /claim_snapshot_json\(\)/u);
  assert.match(controller, /claim_lifecycle/u);
  assert.match(controller, /claim_snapshot_json.*?write_progress_state|write_progress_state.*?claim_snapshot_json/us);
});
