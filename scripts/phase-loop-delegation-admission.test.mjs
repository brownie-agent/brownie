import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { delegationAdmissionStatus, recordDelegationAdmission } from './phase-loop-delegation-admission.mjs';

function fixture(feedback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-delegation-admission-'));
  const feedbackPath = path.join(root, 'repair-feedback.json');
  const auditPath = path.join(root, 'delegation-admission.jsonl');
  fs.writeFileSync(feedbackPath, JSON.stringify(feedback));
  return { feedbackPath, auditPath };
}

const requiredActor = 'implementation-bot';

test('admits a configured implementation controller-maintenance handoff without a second approval gate', () => {
  const paths = fixture({
    kind: 'phase_loop_delegation_pending',
    completed: false,
    selected_todo: '- [ ] controller-maintenance-ledger-recovery: repair the phase loop',
    delegation: { required_actor: requiredActor, acknowledgement_required: true, status: 'pending' }
  });
  const result = recordDelegationAdmission({ ...paths, requiredActor, now: '2026-10-18T03:00:00.000Z' });
  assert.equal(result.ok, true);
  assert.equal(result.recorded, true);
  assert.equal(result.record.required_actor, requiredActor);
  assert.equal(result.record.alternative_unavailable, true);
  assert.equal(result.record.authority, 'existing_controller_maintenance_implementation_policy');
  assert.equal(result.record.acknowledgement_due_at, '2026-10-18T03:30:00.000Z');
  assert.deepEqual(delegationAdmissionStatus({ ...paths, requiredActor, now: '2026-10-18T03:10:00.000Z' }), {
    ok: true,
    pending: true,
    state: 'awaiting_acknowledgement',
    required_actor: requiredActor,
    acknowledgement_due_at: '2026-10-18T03:30:00.000Z',
    admission_id: result.record.admission_id
  });
  assert.equal(delegationAdmissionStatus({ ...paths, requiredActor, now: '2026-10-18T03:30:00.000Z' }).state, 'overdue');
  // Compatibility for an audit record written before deadline persistence was
  // introduced: the receipt timestamp remains the authoritative clock.
  const legacy = { ...result.record };
  delete legacy.acknowledgement_due_at;
  fs.writeFileSync(paths.auditPath, `${JSON.stringify(legacy)}\n`);
  assert.deepEqual(delegationAdmissionStatus({ ...paths, requiredActor, now: '2026-10-18T03:10:00.000Z' }), {
    ok: true,
    pending: true,
    state: 'awaiting_acknowledgement',
    required_actor: requiredActor,
    acknowledgement_due_at: '2026-10-18T03:30:00.000Z',
    admission_id: result.record.admission_id
  });
  const second = recordDelegationAdmission({ ...paths, requiredActor, now: '2026-10-18T03:01:00.000Z' });
  assert.deepEqual(second, { ok: true, recorded: false, reason: 'already_received', record: legacy });
});

test('does not admit unrelated or malformed handoffs as implementation work', () => {
  const unrelated = fixture({ kind: 'other', delegation: { required_actor: requiredActor } });
  assert.deepEqual(recordDelegationAdmission({ ...unrelated, requiredActor }), { ok: true, recorded: false, reason: 'not_pending_implementation_handoff' });
  const malformed = fixture({ kind: 'phase_loop_delegation_pending', delegation: { required_actor: 'reviewer-a', status: 'pending' } });
  assert.deepEqual(recordDelegationAdmission({ ...malformed, requiredActor }), { ok: true, recorded: false, reason: 'not_pending_implementation_handoff' });
  const missing = fixture({ kind: 'phase_loop_delegation_pending', delegation: { required_actor: requiredActor, status: 'pending' } });
  assert.deepEqual(recordDelegationAdmission({ ...missing, requiredActor }), { ok: true, recorded: false, reason: 'not_pending_implementation_handoff' });
});

test('controller records handoff admission before preserving the fail-closed pending gate', () => {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const controller = fs.readFileSync(path.join(repoRoot, 'phase-loop.sh'), 'utf8');
  assert.match(controller, /phase-loop-delegation-admission\.mjs.*record/us);
  assert.match(controller, /delegation_admission_failed/u);
  assert.match(controller, /--actor "\$PHASE_LOOP_EXPECTED_ACTOR"/u);
  assert.match(controller, /phase_loop_delegation_blocker_detail\(\)/u);
  assert.match(controller, /implementation delegation is \{phase\}/u);
  assert.match(controller, /implementation-delegation-\$run_stamp/u);
});
