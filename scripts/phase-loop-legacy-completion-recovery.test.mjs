import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  detectLegacyCompletionRecovery,
  attestLegacyMergedCompletion,
  recoverLegacyRejectedCompletion,
  reconcilePersistedReviewRework
} from './phase-loop-legacy-completion-recovery.mjs';
import { produceSemanticCompletionEvidence } from './phase-loop-delivery-integrity.mjs';

const target = `- [ ] E-target: Patch only \`scripts/target.mjs\`.
  Route: implementation.
  Source TODO: E-parent.
  Depends on: <none>.
  Completion condition: target behavior is implemented and verified.
  Forbidden changes: do not edit unrelated files.
  Verification: run \`node --test scripts/target.test.mjs\`.`;

const parent = `- [x] E-parent: historical parent.
  Route: implementation.
  Depends on: <none>.`;

const dependent = `- [ ] E-dependent: must wait for target.
  Route: implementation.
  Depends on: E-target.
  Completion condition: dependent behavior is implemented.
  Forbidden changes: do not edit unrelated files.
  Verification: run \`node --test scripts/dependent.test.mjs\`.`;

const actorDeployment = {
  schema_version: 1,
  repository: 'example-org/example-repo',
  roles: {
    implementation: { github_login: 'implementation-worker', branch_prefixes: ['implementation/'] },
    review: { github_login: 'reviewer-worker' },
    merge: { github_login: 'reviewer-worker' }
  },
  constraints: { require_independent_review: true }
};

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-legacy-completion-recovery-'));
  fs.mkdirSync(path.join(root, '.brownie'), { recursive: true });
  fs.writeFileSync(path.join(root, '.brownie/todo.md'), `# Queue\n\n${parent}\n\n${dependent}\n`);
  fs.writeFileSync(path.join(root, '.brownie/todo-breakdown.md'), '# Breakdown\n');
  const state = '.brownie/private/phase-loop';
  const completion = `${state}/todo-completions/legacy-claim.json`;
  const snapshot = `${state}/runs/legacy.claim.before-runtime.json`;
  const review = `${state}/legacy-review.json`;
  const mergeReceipt = `${state}/legacy-merge.json`;
  writeJson(path.join(root, completion), {
    schema_version: 1,
    claim_id: 'legacy-claim',
    selected_todo_id: 'E-target',
    selected_todo_first_line: target.split('\n')[0]
  });
  writeJson(path.join(root, snapshot), {
    claim_id: 'legacy-claim',
    selected_todo: target,
    baseline_todo_text: `# Queue\n\n${parent.replace('[x]', '[ ]')}\n\n${target}\n\n${dependent}\n`
  });
  writeJson(path.join(root, review), {
    schema_version: 1,
    pr_url: 'https://github.com/globalpocket/brownie/pull/793',
    state: 'OPEN',
    author: 'implementation-worker',
    head_sha: 'a'.repeat(40),
    latest_review: {
      author: 'reviewer-worker',
      state: 'CHANGES_REQUESTED',
      commit_id: 'a'.repeat(40),
      body: 'Implement the actual journey and record its output before requesting review again.'
    }
  });
  const semanticCompletionEvidence = produceSemanticCompletionEvidence({
    claim: { claim_id: 'legacy-claim', root_claim_id: 'legacy-claim', selected_todo: target },
    stdoutPayload: {
      ok: true,
      run: {
        completed: true,
        terminal_completion_evidence: { final_state: 'succeeded' },
        automation: { continuation_required: false }
      }
    },
    verification: {
      completed: true,
      results: [{ command: 'node --test scripts/target.test.mjs', exit_code: 0 }]
    }
  });
  if (!semanticCompletionEvidence) throw new Error('fixture_semantic_completion_evidence_missing');
  writeJson(path.join(root, mergeReceipt), {
    schema_version: 1,
    pr_url: 'https://github.com/globalpocket/brownie/pull/790',
    state: 'MERGED',
    author: 'implementation-worker',
    head_sha: 'b'.repeat(40),
    merge_commit: 'c'.repeat(40),
    merged_at: '2026-10-31T00:00:00.000Z',
    merged_by: 'reviewer-worker',
    latest_approval: {
      author: 'reviewer-worker',
      state: 'APPROVED',
      commit_id: 'b'.repeat(40)
    },
    ci: {
      passed: true,
      checks: [{ name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }]
    },
    semantic_completion_evidence: semanticCompletionEvidence
  });
  writeJson(path.join(root, `${state}/todo-claims/current.json`), {
    claim_id: 'unrelated-e23d',
    root_claim_id: 'unrelated-e23d',
    status: 'failed',
    selected_todo: dependent,
    failure_evidence: { reason: 'terminal_completion_evidence_missing' }
  });
  return { root, state, completion, snapshot, review, mergeReceipt, semanticCompletionEvidence, actorDeployment };
}

test('detect blocks a descendant whose absent prerequisite has only a legacy completion record', () => {
  const value = fixture();
  const result = detectLegacyCompletionRecovery({ repoRoot: value.root });
  assert.equal(result.blocked, true);
  assert.deepEqual(result.blockers[0]?.dependency_todo_ids, ['E-target']);
});

test('merged independent delivery can attest a legacy prerequisite without rewriting its historical record', () => {
  const value = fixture();
  const result = attestLegacyMergedCompletion({
    repoRoot: value.root,
    statePath: value.state,
    completionPath: value.completion,
    snapshotPath: value.snapshot,
    mergeReceiptPath: value.mergeReceipt,
    actorDeployment: value.actorDeployment,
    now: '2026-10-31T00:00:00.000Z'
  });
  assert.equal(result.attested, true, JSON.stringify(result));
  const durable = JSON.parse(fs.readFileSync(path.join(value.root, result.durable_record_path), 'utf8'));
  assert.equal(durable.schema_version, 2);
  assert.equal(durable.delivery_receipt.merged, true);
  assert.equal(detectLegacyCompletionRecovery({ repoRoot: value.root }).blocked, false);
  const retry = attestLegacyMergedCompletion({
    repoRoot: value.root,
    statePath: value.state,
    completionPath: value.completion,
    snapshotPath: value.snapshot,
    mergeReceiptPath: value.mergeReceipt,
    actorDeployment: value.actorDeployment
  });
  assert.equal(retry.idempotent_attestation, true);
});

test('legacy attestation fails closed when merged delivery does not cover every required verification command', () => {
  const value = fixture();
  const receipt = JSON.parse(fs.readFileSync(path.join(value.root, value.mergeReceipt), 'utf8'));
  receipt.semantic_completion_evidence.verification_results = [];
  writeJson(path.join(value.root, value.mergeReceipt), receipt);
  assert.throws(() => attestLegacyMergedCompletion({
    repoRoot: value.root,
    statePath: value.state,
    completionPath: value.completion,
    snapshotPath: value.snapshot,
    mergeReceiptPath: value.mergeReceipt,
    actorDeployment: value.actorDeployment
  }), /merged_delivery_receipt_invalid/);
  assert.equal(detectLegacyCompletionRecovery({ repoRoot: value.root }).blocked, true);
});

test('attesting a merged prerequisite allows a separately rejected dependent claim to be restored', () => {
  const value = fixture();
  const rejected = `- [ ] E-rejected: Patch only \`scripts/rejected.mjs\`.
  Route: implementation.
  Source TODO: E-parent.
  Depends on: E-target.
  Completion condition: rejected behavior is implemented and verified.
  Forbidden changes: do not edit unrelated files.
  Verification: run \`node --test scripts/rejected.test.mjs\`.`;
  const completion = `${value.state}/todo-completions/rejected-claim.json`;
  const snapshot = `${value.state}/runs/rejected.claim.before-runtime.json`;
  writeJson(path.join(value.root, completion), {
    schema_version: 1,
    claim_id: 'rejected-claim',
    selected_todo_id: 'E-rejected',
    selected_todo_first_line: rejected.split('\n')[0]
  });
  writeJson(path.join(value.root, snapshot), {
    claim_id: 'rejected-claim',
    selected_todo: rejected,
    baseline_todo_text: `# Queue\n\n${parent.replace('[x]', '[ ]')}\n\n${target}\n\n${rejected}\n\n${dependent}\n`
  });
  assert.equal(detectLegacyCompletionRecovery({ repoRoot: value.root }).blocked, true);
  attestLegacyMergedCompletion({
    repoRoot: value.root,
    statePath: value.state,
    completionPath: value.completion,
    snapshotPath: value.snapshot,
    mergeReceiptPath: value.mergeReceipt,
    actorDeployment: value.actorDeployment
  });
  const recovered = recoverLegacyRejectedCompletion({
    repoRoot: value.root,
    statePath: value.state,
    completionPath: completion,
    snapshotPath: snapshot,
    reviewReceiptPath: value.review,
    actorDeployment: value.actorDeployment
  });
  assert.equal(recovered.recovered, true, JSON.stringify(recovered));
  assert.equal(detectLegacyCompletionRecovery({ repoRoot: value.root }).blocked, false);
});

test('recovery restores the exact target, invalidates only the false receipt, archives the displaced claim, and preserves the same root claim', () => {
  const value = fixture();
  const result = recoverLegacyRejectedCompletion({
    repoRoot: value.root,
    statePath: value.state,
    completionPath: value.completion,
    snapshotPath: value.snapshot,
    reviewReceiptPath: value.review,
    actorDeployment: value.actorDeployment,
    now: '2026-10-31T00:00:00.000Z'
  });
  assert.equal(result.recovered, true, JSON.stringify(result));
  const todo = fs.readFileSync(path.join(value.root, '.brownie/todo.md'), 'utf8');
  assert(todo.includes(target));
  assert(todo.includes(parent.replace('[x]', '[ ]')));
  const invalidation = JSON.parse(fs.readFileSync(path.join(value.root, result.invalidation_path), 'utf8'));
  assert.equal(invalidation.invalidated_completion_claim_id, 'legacy-claim');
  const current = JSON.parse(fs.readFileSync(path.join(value.root, result.current_claim_path), 'utf8'));
  assert.equal(current.claim_id, 'legacy-claim');
  assert.equal(current.root_claim_id, 'legacy-claim');
  assert.equal(current.status, 'in_progress');
  assert.equal(current.review_rework.state, 'CHANGES_REQUESTED');
  assert.equal(current.review_rework_fresh_dispatch_pending, true);
  assert.equal(current.review_rework_fresh_dispatch_recovery_id, result.recovery_id);
  const archive = JSON.parse(fs.readFileSync(path.join(value.root, current.legacy_completion_recovery.archived_current_claim_path), 'utf8'));
  assert.equal(archive.claim_id, 'unrelated-e23d');
  assert.equal(archive.failure_evidence.reason, 'terminal_completion_evidence_missing');
  assert.equal(detectLegacyCompletionRecovery({ repoRoot: value.root }).blocked, false);

  const retry = recoverLegacyRejectedCompletion({
    repoRoot: value.root,
    statePath: value.state,
    completionPath: value.completion,
    snapshotPath: value.snapshot,
    reviewReceiptPath: value.review,
    actorDeployment: value.actorDeployment
  });
  assert.equal(retry.idempotent_recovery, true);
  assert.equal(retry.fresh_runtime_dispatch_required, true);
  assert.equal(retry.fresh_runtime_dispatch_marker_restored, false);

  // Older recovery records may predate the marker.  The idempotent path may
  // repair only the same live root claim and records that repair separately.
  delete current.review_rework_fresh_dispatch_pending;
  delete current.review_rework_fresh_dispatch_recovery_id;
  delete current.review_rework_fresh_dispatch_reason;
  delete current.review_rework_fresh_dispatch_requested_at;
  writeJson(path.join(value.root, result.current_claim_path), current);
  const repaired = recoverLegacyRejectedCompletion({
    repoRoot: value.root,
    statePath: value.state,
    completionPath: value.completion,
    snapshotPath: value.snapshot,
    reviewReceiptPath: value.review,
    actorDeployment: value.actorDeployment,
    now: '2026-10-31T00:01:00.000Z'
  });
  assert.equal(repaired.fresh_runtime_dispatch_required, true);
  assert.equal(repaired.fresh_runtime_dispatch_marker_restored, true);
  assert.ok(repaired.fresh_runtime_dispatch_repair_audit_path);
  const repairedClaim = JSON.parse(fs.readFileSync(path.join(value.root, result.current_claim_path), 'utf8'));
  assert.equal(repairedClaim.review_rework_fresh_dispatch_pending, true);
  assert.equal(repairedClaim.review_rework_fresh_dispatch_recovery_id, result.recovery_id);
  const repairAudit = JSON.parse(fs.readFileSync(path.join(value.root, repaired.fresh_runtime_dispatch_repair_audit_path), 'utf8'));
  assert.equal(repairAudit.recovery_id, result.recovery_id);
  assert.equal(repairAudit.reason, 'legacy_review_rework_claim_had_no_fresh_dispatch_marker');
});

test('idempotent recovery reclaims a terminal claim that displaced its review-rework root without duplicating the target', () => {
  const value = fixture();
  const first = recoverLegacyRejectedCompletion({
    repoRoot: value.root,
    statePath: value.state,
    completionPath: value.completion,
    snapshotPath: value.snapshot,
    reviewReceiptPath: value.review,
    actorDeployment: value.actorDeployment,
    now: '2026-10-31T00:00:00.000Z'
  });
  const currentPath = path.join(value.root, first.current_claim_path);
  writeJson(currentPath, {
    claim_id: 'later-terminal-claim',
    root_claim_id: 'later-terminal-claim',
    status: 'integrity_blocked',
    selected_todo: target,
    queue_generation: 2,
    failure_evidence: { reason: 'terminal_completion_evidence_missing' },
    status_history: [{
      status: 'integrity_blocked',
      updated_at: '2026-10-31T00:00:30.000Z'
    }]
  });

  const restored = recoverLegacyRejectedCompletion({
    repoRoot: value.root,
    statePath: value.state,
    completionPath: value.completion,
    snapshotPath: value.snapshot,
    reviewReceiptPath: value.review,
    actorDeployment: value.actorDeployment,
    now: '2026-10-31T00:01:00.000Z'
  });
  assert.equal(restored.recovered, true, JSON.stringify(restored));
  assert.equal(restored.idempotent_recovery, true);
  assert.equal(restored.idempotent_displacement, true);
  const archived = JSON.parse(fs.readFileSync(path.join(value.root, restored.displaced_claim_archive_path), 'utf8'));
  assert.equal(archived.claim_id, 'later-terminal-claim');
  assert.equal(archived.status, 'integrity_blocked');
  const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
  assert.equal(current.claim_id, 'legacy-claim');
  assert.equal(current.root_claim_id, 'legacy-claim');
  assert.equal(current.review_rework_fresh_dispatch_pending, true);
  const todo = fs.readFileSync(path.join(value.root, '.brownie/todo.md'), 'utf8');
  assert.equal((todo.match(/E-target:/gu) ?? []).length, 1);
});

test('reconciles persisted review feedback before a displaced terminal claim can become a fresh-looking TODO', () => {
  const value = fixture();
  const first = recoverLegacyRejectedCompletion({
    repoRoot: value.root,
    statePath: value.state,
    completionPath: value.completion,
    snapshotPath: value.snapshot,
    reviewReceiptPath: value.review,
    actorDeployment: value.actorDeployment,
    now: '2026-10-31T00:00:00.000Z'
  });
  const currentPath = path.join(value.root, first.current_claim_path);
  const reviewedRoot = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
  assert.equal(reviewedRoot.review_rework_fresh_dispatch_pending, true);
  const feedback = JSON.parse(fs.readFileSync(path.join(value.root, value.state, 'todo-repair-feedback.json'), 'utf8'));
  assert.equal(feedback.recovery_inputs.completion_record_path, value.completion);
  assert.equal(feedback.recovery_inputs.immutable_snapshot_path, value.snapshot);
  assert.equal(feedback.recovery_inputs.review_receipt_path, value.review);

  writeJson(path.join(value.root, value.state, 'todo-claims', 'stale-rebaseline-20261031T000010Z.json'), reviewedRoot);
  writeJson(currentPath, {
    claim_id: 'fresh-looking-terminal-claim',
    root_claim_id: 'fresh-looking-terminal-claim',
    status: 'integrity_blocked',
    selected_todo: target,
    status_history: [{
      requested_status: 'completed',
      status: 'integrity_blocked',
      updated_at: '2026-10-31T00:00:30.000Z'
    }]
  });

  const reconciled = reconcilePersistedReviewRework({
    repoRoot: value.root,
    statePath: value.state,
    actorDeployment: value.actorDeployment,
    now: '2026-10-31T00:01:00.000Z'
  });
  assert.equal(reconciled.applicable, true, JSON.stringify(reconciled));
  assert.equal(reconciled.recovered, true, JSON.stringify(reconciled));
  assert.equal(reconciled.idempotent_displacement, true, JSON.stringify(reconciled));
  const restored = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
  assert.equal(restored.claim_id, 'legacy-claim');
  assert.equal(restored.root_claim_id, 'legacy-claim');
  assert.equal(restored.review_rework.state, 'CHANGES_REQUESTED');
  assert.equal(restored.review_rework_fresh_dispatch_pending, true);
  const displaced = JSON.parse(fs.readFileSync(path.join(value.root, reconciled.displaced_claim_archive_path), 'utf8'));
  assert.equal(displaced.claim_id, 'fresh-looking-terminal-claim');
  assert.equal(displaced.status, 'integrity_blocked');
});

test('reconciliation preserves a live review-rework root without requiring a stale archive', () => {
  const value = fixture();
  const first = recoverLegacyRejectedCompletion({
    repoRoot: value.root,
    statePath: value.state,
    completionPath: value.completion,
    snapshotPath: value.snapshot,
    reviewReceiptPath: value.review,
    actorDeployment: value.actorDeployment,
    now: '2026-10-31T00:00:00.000Z'
  });
  const currentPath = path.join(value.root, first.current_claim_path);
  const reconciled = reconcilePersistedReviewRework({
    repoRoot: value.root,
    statePath: value.state,
    actorDeployment: value.actorDeployment,
    now: '2026-10-31T00:01:00.000Z'
  });
  assert.equal(reconciled.applicable, false, JSON.stringify(reconciled));
  assert.equal(reconciled.reason, 'review_rework_live_root_preserved');
  assert.equal(reconciled.fresh_runtime_dispatch_required, true);
  assert.equal(fs.existsSync(path.join(value.root, value.state, 'todo-claims', 'stale-rebaseline-20261031T000010Z.json')), false);
  const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
  assert.equal(current.claim_id, 'legacy-claim');
  assert.equal(current.review_rework_fresh_dispatch_pending, true);
});

test('reconciliation resolves review feedback only after same-root merged semantic delivery and durable TODO removal', () => {
  const value = fixture();
  const first = recoverLegacyRejectedCompletion({
    repoRoot: value.root,
    statePath: value.state,
    completionPath: value.completion,
    snapshotPath: value.snapshot,
    reviewReceiptPath: value.review,
    actorDeployment: value.actorDeployment,
    now: '2026-10-31T00:00:00.000Z'
  });
  const currentPath = path.join(value.root, first.current_claim_path);
  const completedClaim = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
  completedClaim.status = 'completed';
  completedClaim.review_rework = { required: false, resolved_at: '2026-10-31T00:01:00.000Z' };
  completedClaim.delivery_review = {
    pr_url: 'https://github.com/globalpocket/brownie/pull/806',
    author: 'implementation-worker',
    reviewer: 'reviewer-worker',
    merge_actor: 'reviewer-worker',
    merged: true,
    approved: true,
    ci_passed: true,
    semantic_completion_evidence: value.semanticCompletionEvidence
  };
  writeJson(currentPath, completedClaim);
  fs.writeFileSync(path.join(value.root, '.brownie/todo.md'), `# Queue\n\n${parent}\n\n${dependent}\n`);

  const reconciled = reconcilePersistedReviewRework({
    repoRoot: value.root,
    statePath: value.state,
    actorDeployment: value.actorDeployment,
    now: '2026-10-31T00:02:00.000Z'
  });
  assert.equal(reconciled.applicable, false, JSON.stringify(reconciled));
  assert.equal(reconciled.resolved, true, JSON.stringify(reconciled));
  const feedback = JSON.parse(fs.readFileSync(path.join(value.root, value.state, 'todo-repair-feedback.json'), 'utf8'));
  assert.equal(feedback.completed, true);
  assert.equal(feedback.resolution, 'independent_review_ci_merge_and_semantic_delivery_verified');
  assert.equal(feedback.resolution_delivery.pr_url, completedClaim.delivery_review.pr_url);
  assert.ok(fs.existsSync(path.join(value.root, feedback.archived_path)));

  const retry = reconcilePersistedReviewRework({
    repoRoot: value.root,
    statePath: value.state,
    actorDeployment: value.actorDeployment,
    now: '2026-10-31T00:03:00.000Z'
  });
  assert.equal(retry.applicable, false, JSON.stringify(retry));
  assert.equal(retry.reason, 'review_rework_feedback_already_resolved');
});

test('idempotent recovery refuses to replace a running foreign claim', () => {
  const value = fixture();
  const first = recoverLegacyRejectedCompletion({
    repoRoot: value.root,
    statePath: value.state,
    completionPath: value.completion,
    snapshotPath: value.snapshot,
    reviewReceiptPath: value.review,
    actorDeployment: value.actorDeployment
  });
  const currentPath = path.join(value.root, first.current_claim_path);
  writeJson(currentPath, {
    claim_id: 'active-foreign-claim',
    root_claim_id: 'active-foreign-claim',
    status: 'running',
    selected_todo: target
  });
  assert.throws(() => recoverLegacyRejectedCompletion({
    repoRoot: value.root,
    statePath: value.state,
    completionPath: value.completion,
    snapshotPath: value.snapshot,
    reviewReceiptPath: value.review,
    actorDeployment: value.actorDeployment
  }), /active_claim_must_be_preserved_before_legacy_recovery/);
  assert.equal(JSON.parse(fs.readFileSync(currentPath, 'utf8')).claim_id, 'active-foreign-claim');
});

test('idempotent recovery preserves claims awaiting review reconciliation', () => {
  for (const status of ['pr_pending_review', 'changes_requested']) {
    const value = fixture();
    const first = recoverLegacyRejectedCompletion({
      repoRoot: value.root,
      statePath: value.state,
      completionPath: value.completion,
      snapshotPath: value.snapshot,
      reviewReceiptPath: value.review,
      actorDeployment: value.actorDeployment
    });
    const currentPath = path.join(value.root, first.current_claim_path);
    const reviewClaim = {
      claim_id: 'review-pending-claim',
      root_claim_id: 'review-pending-claim',
      status,
      selected_todo: target,
      delivery_review: {
        pr_url: 'https://github.com/globalpocket/brownie/pull/999',
        semantic_completion_evidence: { claim_id: 'review-pending-claim' }
      }
    };
    writeJson(currentPath, reviewClaim);
    assert.throws(() => recoverLegacyRejectedCompletion({
      repoRoot: value.root,
      statePath: value.state,
      completionPath: value.completion,
      snapshotPath: value.snapshot,
      reviewReceiptPath: value.review,
      actorDeployment: value.actorDeployment
    }), /review_pending_claim_must_be_preserved_before_legacy_recovery/);
    assert.deepEqual(JSON.parse(fs.readFileSync(currentPath, 'utf8')), reviewClaim, status);
  }
});

test('idempotent recovery refuses an unproven terminal claim with merged delivery evidence', () => {
  const value = fixture();
  const first = recoverLegacyRejectedCompletion({
    repoRoot: value.root,
    statePath: value.state,
    completionPath: value.completion,
    snapshotPath: value.snapshot,
    reviewReceiptPath: value.review,
    actorDeployment: value.actorDeployment
  });
  const currentPath = path.join(value.root, first.current_claim_path);
  const completedClaim = {
    claim_id: 'completed-delivery-claim',
    root_claim_id: 'completed-delivery-claim',
    status: 'completed',
    selected_todo: target,
    delivery_review: {
      pr_url: 'https://github.com/globalpocket/brownie/pull/1000',
      approved: true,
      ci_passed: true,
      merged: true
    },
    status_history: [{
      status: 'completed',
      updated_at: '2026-10-31T00:01:00.000Z'
    }]
  };
  writeJson(currentPath, completedClaim);
  assert.throws(() => recoverLegacyRejectedCompletion({
    repoRoot: value.root,
    statePath: value.state,
    completionPath: value.completion,
    snapshotPath: value.snapshot,
    reviewReceiptPath: value.review,
    actorDeployment: value.actorDeployment
  }), /idempotent_recovery_requires_proven_terminal_displacement/);
  assert.deepEqual(JSON.parse(fs.readFileSync(currentPath, 'utf8')), completedClaim);
});

test('idempotent recovery completes an audited initial recovery interrupted after invalidation', () => {
  const value = fixture();
  const todoPath = path.join(value.root, '.brownie/todo.md');
  const currentPath = path.join(value.root, `${value.state}/todo-claims/current.json`);
  const todoBefore = fs.readFileSync(todoPath, 'utf8');
  const claimBefore = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
  const first = recoverLegacyRejectedCompletion({
    repoRoot: value.root,
    statePath: value.state,
    completionPath: value.completion,
    snapshotPath: value.snapshot,
    reviewReceiptPath: value.review,
    actorDeployment: value.actorDeployment,
    now: '2026-10-31T00:00:00.000Z'
  });
  fs.rmSync(path.join(value.root, first.audit_path));
  writeJson(currentPath, claimBefore);
  fs.writeFileSync(todoPath, todoBefore);

  const retry = recoverLegacyRejectedCompletion({
    repoRoot: value.root,
    statePath: value.state,
    completionPath: value.completion,
    snapshotPath: value.snapshot,
    reviewReceiptPath: value.review,
    actorDeployment: value.actorDeployment,
    now: '2026-10-31T00:01:00.000Z'
  });
  assert.equal(retry.recovered, true, JSON.stringify(retry));
  assert.equal(retry.idempotent_recovery, true);
  assert.equal(retry.idempotent_partial_initial_recovery, true);
  assert.equal(JSON.parse(fs.readFileSync(currentPath, 'utf8')).claim_id, 'legacy-claim');
});

test('recovery fails closed when the review receipt is not a same-head changes-requested decision', () => {
  const value = fixture();
  const receipt = JSON.parse(fs.readFileSync(path.join(value.root, value.review), 'utf8'));
  receipt.latest_review.state = 'APPROVED';
  writeJson(path.join(value.root, value.review), receipt);
  assert.throws(() => recoverLegacyRejectedCompletion({
    repoRoot: value.root,
    statePath: value.state,
    completionPath: value.completion,
    snapshotPath: value.snapshot,
    reviewReceiptPath: value.review,
    actorDeployment: value.actorDeployment
  }), /review_rejection_receipt_invalid/);
  const todo = fs.readFileSync(path.join(value.root, '.brownie/todo.md'), 'utf8');
  assert(!todo.includes(target));
  assert(todo.includes(parent));
});

test('recovery refuses a snapshot from another claim before any state mutation', () => {
  const value = fixture();
  const snapshot = JSON.parse(fs.readFileSync(path.join(value.root, value.snapshot), 'utf8'));
  snapshot.claim_id = 'other-claim';
  writeJson(path.join(value.root, value.snapshot), snapshot);
  assert.throws(() => recoverLegacyRejectedCompletion({
    repoRoot: value.root,
    statePath: value.state,
    completionPath: value.completion,
    snapshotPath: value.snapshot,
    reviewReceiptPath: value.review,
    actorDeployment: value.actorDeployment
  }), /immutable_snapshot_claim_does_not_match_legacy_completion/);
  const todo = fs.readFileSync(path.join(value.root, '.brownie/todo.md'), 'utf8');
  assert(!todo.includes(target));
  assert(todo.includes(parent));
});

test('recovery fails closed when the active deployment is unavailable', () => {
  const value = fixture();
  assert.throws(() => recoverLegacyRejectedCompletion({
    repoRoot: value.root,
    statePath: value.state,
    completionPath: value.completion,
    snapshotPath: value.snapshot,
    reviewReceiptPath: value.review
  }), /actor_deployment_invalid/);
});
