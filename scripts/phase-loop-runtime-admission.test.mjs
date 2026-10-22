import assert from 'node:assert/strict';
import test from 'node:test';
import { compareRuntimeAdmissionSnapshot, createRuntimeAdmission, validateRuntimeAdmission } from './phase-loop-runtime-admission.mjs';

const claim = {
  claim_id: 'todo-g543-abc',
  selected_todo: '- [ ] E-23b-target-02: Create only `scripts/example.test.mjs`',
  queue_generation: 543,
  queue_fingerprint: 'queue-fingerprint'
};

test('binds the selected TODO identity into a private runtime admission snapshot', () => {
  const admission = createRuntimeAdmission({ claim, runStamp: 'run-1' });
  assert.equal(admission.claim_id, claim.claim_id);
  assert.equal(admission.selected_todo_id, 'E-23b-target-02');
  assert.match(admission.selected_todo_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(admission.status, 'admitted');
});

test('requires explicit recovery when a claimed task disappears before execution', () => {
  const result = validateRuntimeAdmission(createRuntimeAdmission({ claim, runStamp: 'run-1' }), {
    run: { status: 'no_eligible_task', phase_loop_claim_id: claim.claim_id, stop_reason: 'terminal_task_failed' }
  });
  assert.equal(result.ok, false);
  assert.equal(result.snapshot_mismatch, true);
  assert.equal(result.reason, 'claimed_task_not_admitted');
});

test('rejects a matching claim ID when the runtime snapshot differs', () => {
  const admission = createRuntimeAdmission({ claim, runStamp: 'run-1' });
  const result = validateRuntimeAdmission(admission, {
    run: {
      status: 'task_executed',
      phase_loop_claim_id: claim.claim_id,
      phase_loop_selected_todo_id: admission.selected_todo_id,
      phase_loop_selected_todo_sha256: '0'.repeat(64),
      phase_loop_queue_generation: admission.queue_generation,
      phase_loop_queue_fingerprint: admission.queue_fingerprint,
    }
  });
  assert.equal(result.claim_matches, true);
  assert.equal(result.snapshot_mismatch, true);
  assert.equal(result.reason, 'runtime_admission_snapshot_mismatch');
});

test('rejects a claim snapshot drift before dispatch', () => {
  const admission = createRuntimeAdmission({ claim, runStamp: 'run-1' });
  const result = compareRuntimeAdmissionSnapshot(admission, {
    ...claim,
    selected_todo: `${claim.selected_todo}\nextra drift`,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatches, ['selected_todo_sha256']);
  assert.equal(result.reason, 'runtime_admission_snapshot_mismatch');
});

test('allows a nonterminal no-eligible result to use the existing bounded recovery path', () => {
  const result = validateRuntimeAdmission(createRuntimeAdmission({ claim, runStamp: 'run-1' }), {
    run: {
      status: 'no_eligible_task',
      phase_loop_claim_id: claim.claim_id,
      stop_reason: 'budget_exhausted',
      automation: { continuation_required: true }
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot_mismatch, false);
});

test('accepts a runtime result that proves task execution', () => {
  const result = validateRuntimeAdmission(createRuntimeAdmission({ claim, runStamp: 'run-1' }), {
    run: {
      status: 'task_executed',
      phase_loop_claim_id: claim.claim_id,
      task_id: 'task-1',
      execution: { started: true }
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.task_execution_confirmed, true);
});

test('rejects an execution result that omits the claim ID', () => {
  const result = validateRuntimeAdmission(createRuntimeAdmission({ claim, runStamp: 'run-1' }), {
    run: { status: 'task_executed', task_id: 'task-1', execution: { started: true } }
  });
  assert.equal(result.ok, false);
  assert.equal(result.claim_matches, false);
  assert.equal(result.reason, 'runtime_claim_snapshot_mismatch');
});

test('requires recovery when runtime reports a different claim', () => {
  const result = validateRuntimeAdmission(createRuntimeAdmission({ claim, runStamp: 'run-1' }), {
    run: { status: 'task_executed', phase_loop_claim_id: 'other-claim' }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'runtime_claim_snapshot_mismatch');
});
