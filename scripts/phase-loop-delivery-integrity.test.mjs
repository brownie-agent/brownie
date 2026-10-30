import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completionConditionSha256,
  evaluateDeliveryHandoff,
  selectedTodoSha256,
  validateClaimLifecycleTransition
} from './phase-loop-delivery-integrity.mjs';

const selectedTodo = `- [ ] target-02: Patch only \`runtime.rs\`.
  Completion condition: the artifact journey persists a ledger and rejects stale replay.
  Verification: run \`node --test scripts/artifact-journey.test.mjs\`.`;
const claim = { claim_id: 'claim-02', root_claim_id: 'claim-02', selected_todo: selectedTodo };

function completedRun(evidence) {
  return {
    ok: true,
    run: {
      completed: true,
      automation: { continuation_required: false },
      semantic_completion_evidence: evidence
    }
  };
}

function validEvidence() {
  return {
    schema_version: 1,
    root_claim_id: 'claim-02',
    selected_todo_sha256: selectedTodoSha256(claim),
    completion_condition_sha256: completionConditionSha256(claim),
    verification_results: [{ command: 'node --test scripts/artifact-journey.test.mjs', exit_code: 0 }],
    observables: [{ kind: 'artifact_journey', sha256: 'a'.repeat(64) }]
  };
}

test('a process-success envelope cannot promote continuation_required to delivery success', () => {
  const result = evaluateDeliveryHandoff({
    claim,
    stdoutPayload: {
      ok: true,
      run: {
        completed: false,
        terminal_completion_evidence_missing: true,
        automation: { continuation_required: true }
      }
    }
  });
  assert.equal(result.process_ok, true);
  assert.equal(result.delivery_state, 'nonterminal');
  assert.equal(result.pr_handoff_allowed, false);
  assert.equal(result.completion_allowed, false);
  assert.deepEqual(result.reasons.sort(), [
    'continuation_required',
    'run_not_completed',
    'terminal_completion_evidence_missing'
  ]);
});

test('a completed run without claim-bound semantic evidence is integrity blocked', () => {
  const result = evaluateDeliveryHandoff({ claim, stdoutPayload: completedRun(null) });
  assert.equal(result.delivery_state, 'integrity_blocked');
  assert.equal(result.pr_handoff_allowed, false);
  assert(result.reasons.includes('semantic_evidence_schema_invalid'));
});

test('claim-bound semantic evidence permits review handoff but never declares delivery complete', () => {
  const result = evaluateDeliveryHandoff({ claim, stdoutPayload: completedRun(validEvidence()) });
  assert.equal(result.delivery_state, 'verification_passed');
  assert.equal(result.pr_handoff_allowed, true);
  assert.equal(result.completion_allowed, false);
});

test('irrelevant or stale proof cannot be reused for another TODO fingerprint', () => {
  const evidence = validEvidence();
  evidence.selected_todo_sha256 = 'b'.repeat(64);
  const result = evaluateDeliveryHandoff({ claim, stdoutPayload: completedRun(evidence) });
  assert.equal(result.pr_handoff_allowed, false);
  assert(result.reasons.includes('semantic_evidence_todo_mismatch'));
});

test('a completed claim requires approved CI-passing merged review', () => {
  const pending = validateClaimLifecycleTransition({
    previous: claim,
    next: { ...claim, status: 'completed' },
    review: { merged: false, approved: true, ci_passed: true }
  });
  assert.equal(pending.valid, false);
  assert(pending.errors.includes('completed_requires_merged_pr'));

  const merged = validateClaimLifecycleTransition({
    previous: claim,
    next: { ...claim, status: 'completed' },
    review: { merged: true, approved: true, ci_passed: true }
  });
  assert.equal(merged.valid, true, JSON.stringify(merged.errors));
});

test('review-requested changes preserve the immutable root claim and fingerprint', () => {
  const rework = validateClaimLifecycleTransition({
    previous: { ...claim, status: 'pr_pending_review' },
    next: { ...claim, status: 'changes_requested' }
  });
  assert.equal(rework.valid, true, JSON.stringify(rework.errors));

  const replacement = validateClaimLifecycleTransition({
    previous: claim,
    next: { ...claim, claim_id: 'replacement-claim', root_claim_id: 'replacement-claim', status: 'changes_requested' }
  });
  assert.equal(replacement.valid, false);
  assert(replacement.errors.includes('root_claim_id_changed'));
});
