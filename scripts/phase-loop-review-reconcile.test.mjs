import assert from 'node:assert/strict';
import test from 'node:test';
import { applyReviewReconciliation, reconcileReviewSnapshot } from './phase-loop-review-reconcile.mjs';

const claim = { claim_id: 'claim-1', root_claim_id: 'claim-1', selected_todo: '- [ ] T-1: implementation' };

function pr(overrides = {}) {
  return {
    number: 1,
    url: 'https://github.com/globalpocket/brownie/pull/1',
    author: { login: 'brownie-agent' },
    state: 'OPEN',
    mergedAt: null,
    headRefOid: 'a'.repeat(40),
    reviewDecision: 'REVIEW_REQUIRED',
    reviews: [],
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    ...overrides
  };
}

test('changes requested returns the same immutable claim to rework', () => {
  const reconciliation = reconcileReviewSnapshot({
    claim,
    pullRequest: pr({ reviews: [{ state: 'CHANGES_REQUESTED', author: { login: 'globalpocket' }, commit: { oid: 'a'.repeat(40) }, body: 'add journey evidence' }] }),
    reviewer: 'globalpocket',
    implementation: 'brownie-agent'
  });
  assert.equal(reconciliation.valid, true);
  assert.equal(reconciliation.status, 'changes_requested');
  const next = applyReviewReconciliation({ claim, reconciliation, runStamp: 'run-1' });
  assert.equal(next.claim_id, 'claim-1');
  assert.equal(next.root_claim_id, 'claim-1');
  assert.equal(next.review_rework.required, true);
  assert.equal(next.failure_history.at(-1).reason, 'independent_review_requested_changes');
});

test('passing CI and a PR do not complete without merge and independent approval', () => {
  const reconciliation = reconcileReviewSnapshot({ claim, pullRequest: pr(), reviewer: 'globalpocket', implementation: 'brownie-agent' });
  assert.equal(reconciliation.status, 'pr_pending_review');
  assert.equal(reconciliation.delivery_review.ci_passed, true);
});

test('only a merged approved CI-passing PR completes the claim', () => {
  const reconciliation = reconcileReviewSnapshot({
    claim,
    pullRequest: pr({
      state: 'MERGED',
      mergedAt: '2026-10-30T12:00:00Z',
      reviewDecision: 'APPROVED',
      reviews: [{ state: 'APPROVED', author: { login: 'globalpocket' }, commit: { oid: 'a'.repeat(40) } }]
    }),
    reviewer: 'globalpocket',
    implementation: 'brownie-agent'
  });
  assert.equal(reconciliation.status, 'completed');
  assert.equal(reconciliation.delivery_review.merged, true);
  assert.equal(reconciliation.delivery_review.approved, true);
});

test('an old changes-requested review cannot mask a later approval at the new head', () => {
  const oldHead = 'b'.repeat(40);
  const reconciliation = reconcileReviewSnapshot({
    claim,
    pullRequest: pr({
      state: 'MERGED',
      mergedAt: '2026-10-30T12:00:00Z',
      reviews: [
        { state: 'CHANGES_REQUESTED', author: { login: 'globalpocket' }, commit: { oid: oldHead }, body: 'old feedback' },
        { state: 'APPROVED', author: { login: 'globalpocket' }, commit: { oid: 'a'.repeat(40) }, body: 'resolved' }
      ]
    }),
    reviewer: 'globalpocket',
    implementation: 'brownie-agent'
  });
  assert.equal(reconciliation.status, 'completed');
});

test('the author cannot satisfy the independent review role', () => {
  const reconciliation = reconcileReviewSnapshot({ claim, pullRequest: pr(), reviewer: 'brownie-agent', implementation: 'brownie-agent' });
  assert.equal(reconciliation.valid, false);
  assert(reconciliation.errors.includes('reviewer_not_independent'));
});
