import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  detectLegacyCompletionRecovery,
  attestLegacyMergedCompletion,
  recoverLegacyRejectedCompletion
} from './phase-loop-legacy-completion-recovery.mjs';

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

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
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
    semantic_completion_evidence: {
      schema_version: 1,
      root_claim_id: 'legacy-claim',
      selected_todo_sha256: sha256(target),
      completion_condition_sha256: sha256('target behavior is implemented and verified'),
      verification_results: [{ command: 'node --test scripts/target.test.mjs', exit_code: 0 }],
      observables: [{ kind: 'pull_request_diff', sha256: 'd'.repeat(64) }]
    }
  });
  writeJson(path.join(root, `${state}/todo-claims/current.json`), {
    claim_id: 'unrelated-e23d',
    root_claim_id: 'unrelated-e23d',
    status: 'failed',
    selected_todo: dependent,
    failure_evidence: { reason: 'terminal_completion_evidence_missing' }
  });
  return { root, state, completion, snapshot, review, mergeReceipt, actorDeployment };
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
