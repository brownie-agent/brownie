#!/usr/bin/env node
/**
 * Recover the one historical shape that predates durable delivery receipts:
 * a completion record erased a leaf although its PR was later rejected.
 *
 * This is deliberately an explicit, audited transaction.  It never guesses a
 * PR from a TODO; the caller supplies the exact completion record, immutable
 * pre-run snapshot, and independently observed review receipt.  Normal queue
 * selection is separately blocked while this shape exists.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  readAllTodoReplanRecords,
  readTodoCompletionInvalidationRecords,
  readTodoCompletionRecords,
  resolveTodoState
} from './phase-loop-todo-state.mjs';
import { loadPhaseLoopActorDeployment, roleActor } from './phase-loop-actor-deployment.mjs';
import { completionConditionSha256 } from './phase-loop-delivery-integrity.mjs';
import { validateTodoQueueIntegrity } from './phase-loop-todo-queue-integrity.mjs';

const defaultTodo = '.brownie/todo.md';
const defaultBreakdown = '.brownie/todo-breakdown.md';
const defaultState = '.brownie/private/phase-loop';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function atomicWrite(filePath, contents, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, contents, { mode });
  fs.renameSync(temporary, filePath);
}

function atomicJson(filePath, value, mode = 0o600) {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

function todoBlocks(text) {
  const source = String(text ?? '');
  const starts = [...source.matchAll(/^(?:[-*]|\d+[.)])\s+\[[ xX]\]\s+/gmu)].map((match) => match.index);
  return starts.map((start, index) => source.slice(start, starts[index + 1] ?? source.length).trimEnd());
}

function todoId(block) {
  const firstLine = String(block ?? '').split('\n')[0]?.trim() ?? '';
  return firstLine.replace(/^(?:[-*]|\d+[.)])\s+\[[ xX]\]\s+/u, '').split(':')[0]?.trim() ?? '';
}

function lineValue(block, label) {
  const line = String(block ?? '').split('\n').map((value) => value.trim())
    .find((value) => value.startsWith(`${label}:`));
  return line ? line.slice(label.length + 1).trim().replace(/[.]$/u, '') : '';
}

function sourceTodoId(block) {
  return lineValue(block, 'Source TODO').split(':')[0]?.trim().replace(/[.,;]+$/u, '') ?? '';
}

function findBlock(text, id) {
  const matches = todoBlocks(text).filter((block) => todoId(block) === id);
  if (matches.length > 1) {
    throw new Error(`ambiguous_todo_id:${id}`);
  }
  return matches[0] ?? null;
}

function replaceCheckbox(block, checked) {
  return String(block).replace(/^(\s*(?:[-*]|\d+[.)])\s+)\[[ xX]\]/u, `$1[${checked ? 'x' : ' '}]`);
}

function insertAfterBlock(text, block, addition) {
  const index = text.indexOf(block);
  if (index < 0 || text.indexOf(block, index + block.length) >= 0) {
    throw new Error('recovery_parent_block_not_unique');
  }
  const end = index + block.length;
  return `${text.slice(0, end).replace(/\n*$/u, '')}\n\n${addition.trimEnd()}${text.slice(end)}`
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/\s*$/u, '\n');
}

function reviewRejectionValid(review, expectedAuthor, expectedReviewer) {
  const latest = review?.latest_review;
  const valid = (
    review?.schema_version === 1
    && typeof review?.pr_url === 'string' && review.pr_url
    && review?.state === 'OPEN'
    && review?.author === expectedAuthor
    && typeof review?.head_sha === 'string' && /^[a-f0-9]{40}$/u.test(review.head_sha)
    && latest && latest.author === expectedReviewer
    && latest.state === 'CHANGES_REQUESTED'
    && latest.commit_id === review.head_sha
    && typeof latest.body === 'string' && latest.body.trim()
  );
  return { valid, reason: valid ? null : 'review_rejection_receipt_invalid' };
}

function verificationCommands(block) {
  return [...lineValue(block, 'Verification').matchAll(/`([^`]+)`/gu)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

// A v1 completion may be retained as historical evidence only.  This is the
// deliberately narrow upgrade path for a separate, independently reviewed
// and merged delivery: it requires the immutable claim snapshot, the active
// deployment roles, same-head approval, a reviewer merge, complete CI, and
// evidence for every concrete command in the original TODO verification line.
// It appends a v2 record instead of rewriting history.
function mergedDeliveryReceiptValid(receipt, { claimId, selected, expectedAuthor, expectedReviewer }) {
  const approval = receipt?.latest_approval;
  const semantic = receipt?.semantic_completion_evidence;
  const selectedHash = sha256(selected);
  const completionConditionHash = completionConditionSha256({ selected_todo: selected });
  const verification = Array.isArray(semantic?.verification_results)
    ? semantic.verification_results
    : [];
  const observables = Array.isArray(semantic?.observables) ? semantic.observables : [];
  const requiredCommands = verificationCommands(selected);
  const commandsCovered = requiredCommands.every((command) => verification.some((result) => (
    result?.command === command && result?.exit_code === 0
  )));
  const valid = (
    receipt?.schema_version === 1
    && typeof receipt?.pr_url === 'string' && receipt.pr_url
    && receipt?.state === 'MERGED'
    && receipt?.author === expectedAuthor
    && typeof receipt?.head_sha === 'string' && /^[a-f0-9]{40}$/u.test(receipt.head_sha)
    && typeof receipt?.merge_commit === 'string' && /^[a-f0-9]{40}$/u.test(receipt.merge_commit)
    && typeof receipt?.merged_at === 'string' && receipt.merged_at
    && receipt?.merged_by === expectedReviewer
    && approval?.author === expectedReviewer
    && approval?.state === 'APPROVED'
    && approval?.commit_id === receipt.head_sha
    && receipt?.ci?.passed === true
    && Array.isArray(receipt.ci.checks) && receipt.ci.checks.length > 0
    && receipt.ci.checks.every((check) => check?.status === 'COMPLETED' && check?.conclusion === 'SUCCESS')
    && semantic?.schema_version === 1
    && semantic.root_claim_id === claimId
    && semantic.selected_todo_sha256 === selectedHash
    && semantic.completion_condition_sha256 === completionConditionHash
    && verification.length > 0
    && verification.every((result) => result && typeof result.command === 'string' && result.command && result.exit_code === 0)
    && commandsCovered
    && observables.length > 0
    && observables.every((observable) => observable && observable.kind && typeof observable.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(observable.sha256))
  );
  return { valid, reason: valid ? null : 'merged_delivery_receipt_invalid' };
}

function legacyDependencyBlocks(repoRoot, todoText, breakdownPath) {
  const state = resolveTodoState({
    todoText,
    replanRecords: readAllTodoReplanRecords(repoRoot, { breakdownPath }),
    completionRecords: readTodoCompletionRecords(repoRoot),
    completionInvalidationRecords: readTodoCompletionInvalidationRecords(repoRoot)
  });
  const blocked = [];
  for (const block of todoBlocks(todoText)) {
    if (!/^\s*(?:[-*]|\d+[.)])\s+\[\s\]/u.test(block)) continue;
    const dependencies = lineValue(block, 'Depends on').split(',').map((value) => value.trim()).filter((value) => value && value !== '<none>');
    const unsafe = dependencies.filter((dependency) => state.unverifiedArchivedCompletionIds.has(dependency));
    if (unsafe.length > 0) {
      blocked.push({
        todo_id: todoId(block),
        dependency_todo_ids: unsafe,
        completion_records: state.unverifiedCompletionRecords.filter((record) => unsafe.includes(record.selected_todo_id))
      });
    }
  }
  return { state, blocked };
}

export function detectLegacyCompletionRecovery({ repoRoot, todoPath = defaultTodo, breakdownPath = defaultBreakdown }) {
  const root = path.resolve(repoRoot);
  const todo = readText(path.resolve(root, todoPath));
  const result = legacyDependencyBlocks(root, todo, path.resolve(root, breakdownPath));
  return {
    schema_version: 1,
    blocked: result.blocked.length > 0,
    blockers: result.blocked,
    unverified_archived_completion_ids: [...result.state.unverifiedArchivedCompletionIds].sort()
  };
}

function parseArgs(argv) {
  const args = {
    mode: argv[2] ?? 'detect',
    repo: process.cwd(),
    todo: defaultTodo,
    breakdown: defaultBreakdown,
    state: defaultState,
    actorDeployment: null
  };
  for (let index = 3; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--repo') { args.repo = value; index += 1; }
    else if (key === '--todo') { args.todo = value; index += 1; }
    else if (key === '--breakdown') { args.breakdown = value; index += 1; }
    else if (key === '--state') { args.state = value; index += 1; }
    else if (key === '--completion') { args.completion = value; index += 1; }
    else if (key === '--snapshot') { args.snapshot = value; index += 1; }
    else if (key === '--review-receipt') { args.reviewReceipt = value; index += 1; }
    else if (key === '--merge-receipt') { args.mergeReceipt = value; index += 1; }
    else if (key === '--actor-deployment') { args.actorDeployment = value; index += 1; }
    else throw new Error(`unknown_argument:${key}`);
  }
  return args;
}

function recoveryActors({ repoRoot, actorDeploymentPath, actorDeployment }) {
  const loaded = loadPhaseLoopActorDeployment({
    repoRoot,
    deploymentPath: actorDeploymentPath,
    deployment: actorDeployment
  });
  if (!loaded.ok) {
    throw new Error(`actor_deployment_invalid:${loaded.errors.join(';')}`);
  }
  const implementation = roleActor(loaded.deployment, 'implementation');
  const review = roleActor(loaded.deployment, 'review');
  if (!implementation || !review) {
    throw new Error('actor_deployment_missing_recovery_roles');
  }
  return { implementation, review, deploymentPath: loaded.deploymentPath };
}

function assertRecoveryInputs({ completion, snapshot, review, todoText, expectedAuthor, expectedReviewer, allowLiveTarget = false }) {
  const claimId = typeof completion?.claim_id === 'string' ? completion.claim_id : '';
  const targetId = typeof completion?.selected_todo_id === 'string' ? completion.selected_todo_id : '';
  if (!claimId || !targetId || completion?.schema_version >= 2) {
    throw new Error('legacy_completion_record_required');
  }
  const selected = typeof snapshot?.selected_todo === 'string' ? snapshot.selected_todo.trimEnd() : '';
  const baseline = typeof snapshot?.baseline_todo_text === 'string' ? snapshot.baseline_todo_text : '';
  if (!selected || todoId(selected) !== targetId || !baseline.includes(selected)) {
    throw new Error('immutable_snapshot_does_not_match_legacy_completion');
  }
  if (snapshot?.claim_id !== claimId) {
    throw new Error('immutable_snapshot_claim_does_not_match_legacy_completion');
  }
  const selectedFirstLine = selected.split('\n')[0] ?? '';
  if (
    (snapshot?.selected_todo_id && snapshot.selected_todo_id !== targetId)
    || (snapshot?.selected_todo_first_line && snapshot.selected_todo_first_line !== selectedFirstLine)
    || (snapshot?.selected_todo_sha256 && snapshot.selected_todo_sha256 !== sha256(selected))
    || (completion?.selected_todo_first_line && completion.selected_todo_first_line !== selectedFirstLine)
  ) {
    throw new Error('immutable_snapshot_selected_todo_does_not_match_legacy_completion');
  }
  const liveTarget = findBlock(todoText, targetId);
  if (liveTarget && (!allowLiveTarget || sha256(liveTarget) !== sha256(selected))) {
    throw new Error('legacy_target_is_already_live');
  }
  const parentId = sourceTodoId(selected);
  if (!parentId) throw new Error('legacy_target_source_parent_missing');
  const parent = findBlock(todoText, parentId);
  if (!parent) throw new Error('legacy_source_parent_not_live');
  const reviewValidation = reviewRejectionValid(review, expectedAuthor, expectedReviewer);
  if (!reviewValidation.valid) throw new Error(reviewValidation.reason);
  return { claimId, targetId, selected, parentId, parent };
}

function assertLegacyAttestationInputs({ completion, snapshot, mergeReceipt, todoText, expectedAuthor, expectedReviewer }) {
  const claimId = typeof completion?.claim_id === 'string' ? completion.claim_id : '';
  const targetId = typeof completion?.selected_todo_id === 'string' ? completion.selected_todo_id : '';
  if (!claimId || !targetId || completion?.schema_version >= 2) {
    throw new Error('legacy_completion_record_required');
  }
  const selected = typeof snapshot?.selected_todo === 'string' ? snapshot.selected_todo.trimEnd() : '';
  const baseline = typeof snapshot?.baseline_todo_text === 'string' ? snapshot.baseline_todo_text : '';
  if (!selected || todoId(selected) !== targetId || !baseline.includes(selected)) {
    throw new Error('immutable_snapshot_does_not_match_legacy_completion');
  }
  if (snapshot?.claim_id !== claimId) {
    throw new Error('immutable_snapshot_claim_does_not_match_legacy_completion');
  }
  const selectedFirstLine = selected.split('\n')[0] ?? '';
  if (
    (snapshot?.selected_todo_id && snapshot.selected_todo_id !== targetId)
    || (snapshot?.selected_todo_first_line && snapshot.selected_todo_first_line !== selectedFirstLine)
    || (snapshot?.selected_todo_sha256 && snapshot.selected_todo_sha256 !== sha256(selected))
    || (completion?.selected_todo_first_line && completion.selected_todo_first_line !== selectedFirstLine)
  ) {
    throw new Error('immutable_snapshot_selected_todo_does_not_match_legacy_completion');
  }
  if (findBlock(todoText, targetId)) {
    throw new Error('legacy_target_is_already_live');
  }
  const receiptValidation = mergedDeliveryReceiptValid(mergeReceipt, {
    claimId,
    selected,
    expectedAuthor,
    expectedReviewer
  });
  if (!receiptValidation.valid) throw new Error(receiptValidation.reason);
  return { claimId, targetId, selected };
}

export function attestLegacyMergedCompletion({
  repoRoot,
  todoPath = defaultTodo,
  statePath = defaultState,
  completionPath,
  snapshotPath,
  mergeReceiptPath,
  actorDeploymentPath,
  actorDeployment,
  now = new Date().toISOString()
}) {
  const root = path.resolve(repoRoot);
  const actors = recoveryActors({ repoRoot: root, actorDeploymentPath, actorDeployment });
  const todoFile = path.resolve(root, todoPath);
  const stateRoot = path.resolve(root, statePath);
  const completionFile = path.resolve(root, completionPath);
  const snapshotFile = path.resolve(root, snapshotPath);
  const receiptFile = path.resolve(root, mergeReceiptPath);
  const completion = readJson(completionFile);
  const snapshot = readJson(snapshotFile);
  const mergeReceipt = readJson(receiptFile);
  const todoText = readText(todoFile);
  const input = assertLegacyAttestationInputs({
    completion,
    snapshot,
    mergeReceipt,
    todoText,
    expectedAuthor: actors.implementation,
    expectedReviewer: actors.review
  });
  const receiptId = sha256(`${input.claimId}\n${sha256(input.selected)}\n${mergeReceipt.pr_url}\n${mergeReceipt.merge_commit}`).slice(0, 24);
  const completionDir = path.join(stateRoot, 'todo-completions');
  const recordPath = path.join(completionDir, `durable-legacy-${input.claimId}-${receiptId}.json`);
  if (fs.existsSync(recordPath)) {
    return {
      schema_version: 1,
      attested: false,
      idempotent_attestation: true,
      claim_id: input.claimId,
      selected_todo_id: input.targetId,
      durable_record_path: path.relative(root, recordPath)
    };
  }
  const deliveryReceipt = {
    schema_version: 1,
    claim_id: input.claimId,
    root_claim_id: input.claimId,
    selected_todo_sha256: sha256(input.selected),
    approved: true,
    ci_passed: true,
    merged: true,
    author: actors.implementation,
    reviewer: actors.review,
    merge_actor: actors.review,
    pr_url: mergeReceipt.pr_url,
    pr_head_sha: mergeReceipt.head_sha,
    merge_commit: mergeReceipt.merge_commit,
    merged_at: mergeReceipt.merged_at,
    semantic_completion_evidence: mergeReceipt.semantic_completion_evidence
  };
  const record = {
    schema_version: 2,
    record_type: 'legacy_completion_delivery_attestation',
    claim_id: input.claimId,
    root_claim_id: input.claimId,
    selected_todo_id: input.targetId,
    selected_todo_first_line: input.selected.split('\n')[0],
    selected_todo_sha256: sha256(input.selected),
    reason: 'historical_completion_attested_by_independent_merged_delivery',
    delivery_receipt: deliveryReceipt,
    attestation: {
      receipt_id: receiptId,
      legacy_completion_path: path.relative(root, completionFile),
      immutable_snapshot_path: path.relative(root, snapshotFile),
      merge_receipt_path: path.relative(root, receiptFile),
      completion_record_sha256: sha256(readText(completionFile)),
      snapshot_sha256: sha256(readText(snapshotFile)),
      merge_receipt_sha256: sha256(readText(receiptFile)),
      attested_at: now
    }
  };
  const auditPath = path.join(stateRoot, 'legacy-completion-attestations', `${receiptId}.json`);
  const audit = {
    schema_version: 1,
    record_type: 'legacy_completion_delivery_attestation',
    receipt_id: receiptId,
    claim_id: input.claimId,
    selected_todo_id: input.targetId,
    durable_record_path: path.relative(root, recordPath),
    pr_url: mergeReceipt.pr_url,
    merge_commit: mergeReceipt.merge_commit,
    reviewer: actors.review,
    attested_at: now
  };
  atomicJson(recordPath, record);
  atomicJson(auditPath, audit);
  return {
    schema_version: 1,
    attested: true,
    claim_id: input.claimId,
    selected_todo_id: input.targetId,
    durable_record_path: path.relative(root, recordPath),
    audit_path: path.relative(root, auditPath),
    actor_deployment_path: actors.deploymentPath ? path.relative(root, actors.deploymentPath) : null
  };
}

function isLiveMatchingReviewReworkClaim({ currentClaim, claimId, selected, recoveryId }) {
  return Boolean(
    currentClaim
    && currentClaim.claim_id === claimId
    && currentClaim.root_claim_id === claimId
    && currentClaim.legacy_completion_recovery?.recovery_id === recoveryId
    && currentClaim.review_rework?.required === true
    && currentClaim.review_rework?.state === 'CHANGES_REQUESTED'
    && sha256(currentClaim.selected_todo) === sha256(selected)
    && ['claimed', 'in_progress'].includes(currentClaim.status)
  );
}

function isProvenTerminalDisplacement({ currentClaim, claimId, selected, invalidation }) {
  const terminalTransition = Array.isArray(currentClaim?.status_history)
    ? currentClaim.status_history.at(-1)
    : null;
  const invalidatedAt = Date.parse(invalidation?.invalidated_at ?? '');
  const terminalAt = Date.parse(terminalTransition?.updated_at ?? '');
  return Boolean(
    currentClaim
    && currentClaim.claim_id !== claimId
    && currentClaim.root_claim_id !== claimId
    && currentClaim.status === 'integrity_blocked'
    && currentClaim.delivery_review == null
    && sha256(currentClaim.selected_todo) === sha256(selected)
    && terminalTransition?.status === 'integrity_blocked'
    && Number.isFinite(invalidatedAt)
    && Number.isFinite(terminalAt)
    && terminalAt >= invalidatedAt
  );
}

function isAuditedPartialInitialRecovery({ stateRoot, todoText, input, review, currentClaim, invalidation, recoveryId }) {
  if (findBlock(todoText, input.targetId)) return false;
  const recoverableCurrentStatus = currentClaim == null
    || ['failed', 'integrity_blocked', 'stale_snapshot_rejected'].includes(currentClaim.status);
  if (!recoverableCurrentStatus || currentClaim?.delivery_review != null) return false;
  const todoSnapshotPath = path.join(stateRoot, 'legacy-completion-recoveries', `${recoveryId}.todo-before.md`);
  if (!fs.existsSync(todoSnapshotPath)) return false;
  let snapshotMatches;
  try {
    snapshotMatches = sha256(readText(todoSnapshotPath)) === sha256(todoText);
  } catch {
    return false;
  }
  return Boolean(
    snapshotMatches
    && invalidation?.schema_version === 1
    && invalidation.record_type === 'todo_completion_invalidation'
    && invalidation.selected_todo_id === input.targetId
    && invalidation.invalidated_completion_claim_id === input.claimId
    && invalidation.reason === 'legacy_completion_rejected_by_independent_review'
    && invalidation.recovery_id === recoveryId
    && invalidation.pr_url === review.pr_url
    && invalidation.review_state === review.latest_review.state
    && invalidation.review_head_sha === review.head_sha
  );
}

function ensureReviewReworkFreshDispatch({
  root,
  stateRoot,
  currentClaimPath,
  currentClaim,
  claimId,
  selected,
  recoveryId,
  prUrl,
  reviewer,
  now
}) {
  const sameRecoveredClaim = isLiveMatchingReviewReworkClaim({ currentClaim, claimId, selected, recoveryId });
  if (!sameRecoveredClaim) {
    throw new Error('idempotent_recovery_requires_live_matching_review_rework_claim');
  }
  if (typeof currentClaim.review_rework_fresh_dispatch_activated_run_stamp === 'string'
    && currentClaim.review_rework_fresh_dispatch_activated_run_stamp) {
    return {
      fresh_runtime_dispatch_required: false,
      fresh_runtime_dispatch_marker_restored: false,
      fresh_runtime_dispatch_activated_run_stamp: currentClaim.review_rework_fresh_dispatch_activated_run_stamp
    };
  }
  if (currentClaim.review_rework_fresh_dispatch_pending === true) {
    return {
      fresh_runtime_dispatch_required: true,
      fresh_runtime_dispatch_marker_restored: false
    };
  }

  // v1 recovery records created before this marker existed can be repaired
  // only while their exact root claim remains live.  Record the repair before
  // publishing it, so a crash is auditable and rerunning is deterministic.
  const auditPath = path.join(stateRoot, 'legacy-completion-fresh-dispatch-repairs', `${recoveryId}.json`);
  const audit = {
    schema_version: 1,
    record_type: 'legacy_completion_review_rework_fresh_dispatch_repair',
    recovery_id: recoveryId,
    claim_id: claimId,
    pr_url: prUrl,
    reviewer,
    reason: 'legacy_review_rework_claim_had_no_fresh_dispatch_marker',
    repaired_at: now
  };
  if (!fs.existsSync(auditPath)) atomicJson(auditPath, audit);
  const repairedClaim = {
    ...currentClaim,
    review_rework_fresh_dispatch_pending: true,
    review_rework_fresh_dispatch_recovery_id: recoveryId,
    review_rework_fresh_dispatch_reason: 'legacy_completion_rejected_by_independent_review',
    review_rework_fresh_dispatch_requested_at: now,
    status_history: [
      ...(Array.isArray(currentClaim.status_history) ? currentClaim.status_history : []),
      {
        status: 'fresh_runtime_dispatch_required',
        updated_at: now,
        note: 'review-rework recovery invalidated a stale Runtime continuation and requires an admitted fresh run'
      }
    ],
    updated_at: now
  };
  atomicJson(currentClaimPath, repairedClaim);
  return {
    fresh_runtime_dispatch_required: true,
    fresh_runtime_dispatch_marker_restored: true,
    fresh_runtime_dispatch_repair_audit_path: path.relative(root, auditPath)
  };
}

export function recoverLegacyRejectedCompletion({
  repoRoot,
  todoPath = defaultTodo,
  breakdownPath = defaultBreakdown,
  statePath = defaultState,
  completionPath,
  snapshotPath,
  reviewReceiptPath,
  actorDeploymentPath,
  actorDeployment,
  now = new Date().toISOString()
}) {
  const root = path.resolve(repoRoot);
  const actors = recoveryActors({ repoRoot: root, actorDeploymentPath, actorDeployment });
  const expectedAuthor = actors.implementation;
  const expectedReviewer = actors.review;
  const todoFile = path.resolve(root, todoPath);
  const breakdownFile = path.resolve(root, breakdownPath);
  const stateRoot = path.resolve(root, statePath);
  const completionFile = path.resolve(root, completionPath);
  const snapshotFile = path.resolve(root, snapshotPath);
  const reviewFile = path.resolve(root, reviewReceiptPath);
  const completion = readJson(completionFile);
  const snapshot = readJson(snapshotFile);
  const review = readJson(reviewFile);
  const todoText = readText(todoFile);
  const currentClaimPath = path.join(stateRoot, 'todo-claims', 'current.json');
  const preliminaryClaimId = typeof completion?.claim_id === 'string' ? completion.claim_id : '';
  const preliminaryTargetId = typeof completion?.selected_todo_id === 'string' ? completion.selected_todo_id : '';
  const preliminarySelected = typeof snapshot?.selected_todo === 'string' ? snapshot.selected_todo.trimEnd() : '';
  const preliminaryReview = reviewRejectionValid(review, expectedAuthor, expectedReviewer);
  const preliminaryRecoveryId = preliminaryClaimId && preliminarySelected && preliminaryReview.valid
    ? sha256(`${preliminaryClaimId}\n${sha256(preliminarySelected)}\n${review.pr_url}\n${review.head_sha}`).slice(0, 24)
    : '';
  const existingInvalidations = readTodoCompletionInvalidationRecords(root);
  if (preliminaryTargetId && findBlock(todoText, preliminaryTargetId)) {
    const alreadyRecovered = existingInvalidations.some((record) => (
      record.selected_todo_id === preliminaryTargetId
      && record.invalidated_completion_claim_id === preliminaryClaimId
    ));
    if (alreadyRecovered) {
      const currentClaim = fs.existsSync(currentClaimPath) ? readJson(currentClaimPath) : null;
      if (!isLiveMatchingReviewReworkClaim({
        currentClaim,
        claimId: preliminaryClaimId,
        selected: preliminarySelected,
        recoveryId: preliminaryRecoveryId
      })) {
        // A prior recovery may itself have been displaced by a stale
        // rebaseline.  Fall through to the audited restoration path below;
        // it refuses an active foreign claim and archives any terminal one.
      } else {
      const freshDispatch = ensureReviewReworkFreshDispatch({
        root,
        stateRoot,
        currentClaimPath,
        currentClaim,
        claimId: preliminaryClaimId,
        selected: preliminarySelected,
        recoveryId: preliminaryRecoveryId,
        prUrl: review.pr_url,
        reviewer: expectedReviewer,
        now
      });
      return {
        schema_version: 1,
        recovered: false,
        idempotent_recovery: true,
        recovery_id: preliminaryRecoveryId,
        claim_id: preliminaryClaimId,
        selected_todo_id: preliminaryTargetId,
        pr_url: review.pr_url,
        ...freshDispatch
      };
      }
    }
  }
  const alreadyInvalidatedPrecheck = existingInvalidations.some((record) => (
    record.selected_todo_id === preliminaryTargetId
    && record.invalidated_completion_claim_id === preliminaryClaimId
  ));
  const input = assertRecoveryInputs({
    completion,
    snapshot,
    review,
    todoText,
    expectedAuthor,
    expectedReviewer,
    allowLiveTarget: alreadyInvalidatedPrecheck
  });
  const invalidations = existingInvalidations;
  const alreadyInvalidated = invalidations.some((record) => (
    record.selected_todo_id === input.targetId && record.invalidated_completion_claim_id === input.claimId
  ));
  const invalidation = invalidations.find((record) => (
    record.selected_todo_id === input.targetId && record.invalidated_completion_claim_id === input.claimId
  ));
  const recoveryId = sha256(`${input.claimId}\n${sha256(input.selected)}\n${review.pr_url}\n${review.head_sha}`).slice(0, 24);
  const currentClaim = fs.existsSync(currentClaimPath) ? readJson(currentClaimPath) : null;
  const currentStatus = currentClaim?.status;
  // A claim awaiting review, or carrying newly requested changes, has a
  // durable PR handoff that phase-loop.sh must reconcile.  It is neither a
  // terminal displacement nor a recoverable copy of an earlier rejection;
  // replacing it would discard the current delivery evidence and restart
  // implementation before that review is resolved.
  if (['pr_pending_review', 'changes_requested'].includes(currentStatus)) {
    throw new Error('review_pending_claim_must_be_preserved_before_legacy_recovery');
  }
  if (['claimed', 'in_progress', 'running'].includes(currentStatus)) {
    if (!(currentClaim?.claim_id === input.claimId && currentClaim?.legacy_completion_recovery?.recovery_id === recoveryId)) {
      throw new Error('active_claim_must_be_preserved_before_legacy_recovery');
    }
  }
  const partialInitialRecovery = alreadyInvalidated && isAuditedPartialInitialRecovery({
    stateRoot,
    todoText,
    input,
    review,
    currentClaim,
    invalidation,
    recoveryId
  });
  if (alreadyInvalidated && !isLiveMatchingReviewReworkClaim({
    currentClaim,
    claimId: input.claimId,
    selected: input.selected,
    recoveryId
  }) && !isProvenTerminalDisplacement({
    currentClaim,
    claimId: input.claimId,
    selected: input.selected,
    invalidation
  }) && !partialInitialRecovery) {
    throw new Error('idempotent_recovery_requires_proven_terminal_displacement');
  }

  const restoredParent = replaceCheckbox(input.parent, false);
  let restoredTodo = todoText;
  const existingTarget = findBlock(restoredTodo, input.targetId);
  if (existingTarget) {
    if (sha256(existingTarget) !== sha256(input.selected)) {
      throw new Error('recovery_existing_target_does_not_match_immutable_snapshot');
    }
    const existingParent = findBlock(restoredTodo, input.parentId);
    if (!existingParent || !/^(?:[-*]|\d+[.)])\s+\[ \]\s+/mu.test(existingParent)) {
      throw new Error('recovery_existing_target_requires_unchecked_source_parent');
    }
  } else {
    if (restoredParent !== input.parent) {
      const parentIndex = restoredTodo.indexOf(input.parent);
      if (parentIndex < 0) throw new Error('legacy_source_parent_not_unique');
      restoredTodo = `${restoredTodo.slice(0, parentIndex)}${restoredParent}${restoredTodo.slice(parentIndex + input.parent.length)}`;
    }
    restoredTodo = insertAfterBlock(restoredTodo, restoredParent, input.selected);
  }

  const proposedInvalidation = {
    schema_version: 1,
    record_type: 'todo_completion_invalidation',
    selected_todo_id: input.targetId,
    invalidated_completion_claim_id: input.claimId,
    reason: 'legacy_completion_rejected_by_independent_review',
    recovery_id: recoveryId,
    pr_url: review.pr_url,
    review_state: review.latest_review.state,
    review_head_sha: review.head_sha,
    invalidated_at: now
  };
  const completionRecords = readTodoCompletionRecords(root);
  const replanRecords = readAllTodoReplanRecords(root, { breakdownPath: breakdownFile });
  const stateAfter = resolveTodoState({
    todoText: restoredTodo,
    replanRecords,
    completionRecords,
    completionInvalidationRecords: alreadyInvalidated ? invalidations : [...invalidations, proposedInvalidation]
  });
  const queueValidation = validateTodoQueueIntegrity({
    todoBefore: todoText,
    todoAfter: restoredTodo,
    afterBreakdownText: fs.existsSync(breakdownFile) ? readText(breakdownFile) : null,
    completedTodoIds: [...stateAfter.completedIds],
    unverifiedArchivedCompletionRecords: stateAfter.unverifiedCompletionRecords
      .filter((record) => stateAfter.unverifiedArchivedCompletionIds.has(record.selected_todo_id)),
    todoReplanRecords: replanRecords
  });
  if (!queueValidation.valid) {
    throw new Error(`recovery_queue_validation_failed:${queueValidation.errors.map((error) => error.code).join(',')}`);
  }

  const recoveryDir = path.join(stateRoot, 'legacy-completion-recoveries');
  const invalidationPath = path.join(stateRoot, 'todo-completion-invalidations', `${input.claimId}-${recoveryId}.json`);
  const displacedClaimDigest = currentClaim ? sha256(JSON.stringify(currentClaim)).slice(0, 16) : null;
  const idempotentDisplacement = alreadyInvalidated && !partialInitialRecovery && !isLiveMatchingReviewReworkClaim({
    currentClaim,
    claimId: input.claimId,
    selected: input.selected,
    recoveryId
  });
  const archiveSuffix = idempotentDisplacement
    ? `displaced-after-idempotent-${displacedClaimDigest}`
    : 'current-before';
  const currentArchivePath = path.join(stateRoot, 'todo-claims', `legacy-completion-recovery-${recoveryId}-${archiveSuffix}.json`);
  const auditPath = path.join(recoveryDir, idempotentDisplacement
    ? `${recoveryId}-idempotent-displacement-${displacedClaimDigest}.json`
    : `${recoveryId}.json`);
  const todoSnapshotPath = path.join(recoveryDir, `${recoveryId}.todo-before.md`);
  const feedbackPath = path.join(stateRoot, 'todo-repair-feedback.json');
  const restoredClaim = {
    schema_version: 1,
    claim_id: input.claimId,
    root_claim_id: input.claimId,
    status: 'in_progress',
    selected_todo: input.selected,
    selected_todo_sha256: sha256(input.selected),
    queue_fingerprint: sha256(restoredTodo),
    queue_generation: currentClaim?.queue_generation ?? null,
    baseline_todo_text: restoredTodo,
    baseline_diff_files: Array.isArray(currentClaim?.baseline_diff_files) ? currentClaim.baseline_diff_files : [],
    // Review rejection invalidates the prior Runtime continuation, not merely
    // its completion claim.  The controller must issue a fresh `run` and may
    // clear this marker only after that new session is admitted.
    review_rework_fresh_dispatch_pending: true,
    review_rework_fresh_dispatch_recovery_id: recoveryId,
    review_rework_fresh_dispatch_reason: 'legacy_completion_rejected_by_independent_review',
    review_rework_fresh_dispatch_requested_at: now,
    legacy_completion_recovery: {
      recovery_id: recoveryId,
      invalidated_completion_claim_id: input.claimId,
      completion_record_path: path.relative(root, completionFile),
      immutable_snapshot_path: path.relative(root, snapshotFile),
      review_receipt_path: path.relative(root, reviewFile),
      pr_url: review.pr_url,
      pr_head_sha: review.head_sha,
      reviewer: expectedReviewer,
      review_state: review.latest_review.state,
      archived_current_claim_path: currentClaim ? path.relative(root, currentArchivePath) : null,
      recovered_at: now
    },
    review_rework: {
      required: true,
      reviewer: expectedReviewer,
      state: review.latest_review.state,
      feedback: review.latest_review.body,
      pr_url: review.pr_url,
      head_sha: review.head_sha
    },
    status_history: [
      {
        status: 'legacy_completion_invalidated',
        updated_at: now,
        note: 'historical completion record lacked a durable delivery receipt and its independently reviewed PR was changes-requested'
      },
      {
        status: 'in_progress',
        updated_at: now,
        note: 'same root claim restored for review-directed reimplementation'
      },
      ...(idempotentDisplacement ? [{
        status: 'legacy_completion_recovery_reasserted',
        updated_at: now,
        note: 'terminal claim that displaced the review-rework root was archived before restoring the same root claim'
      }] : [])
    ],
    updated_at: now
  };
  const feedback = {
    schema_version: 1,
    kind: 'phase_loop_review_rework_required',
    completed: false,
    claim_id: input.claimId,
    root_claim_id: input.claimId,
    selected_todo_first_line: input.selected.split('\n')[0],
    reason: 'legacy_completion_rejected_by_independent_review',
    pr_url: review.pr_url,
    reviewer: expectedReviewer,
    review_state: review.latest_review.state,
    review_head_sha: review.head_sha,
    feedback: review.latest_review.body,
    recovery_id: recoveryId,
    fresh_runtime_dispatch_required: true,
    updated_at: now
  };
  const audit = {
    schema_version: 1,
    record_type: 'legacy_completion_recovery',
    recovery_id: recoveryId,
    claim_id: input.claimId,
    selected_todo_id: input.targetId,
    source_parent_todo_id: input.parentId,
    pr_url: review.pr_url,
    review_state: review.latest_review.state,
    reviewer: expectedReviewer,
    completion_record_sha256: sha256(readText(completionFile)),
    snapshot_sha256: sha256(readText(snapshotFile)),
    review_receipt_sha256: sha256(readText(reviewFile)),
    todo_before_sha256: sha256(todoText),
    todo_after_sha256: sha256(restoredTodo),
    archived_current_claim_path: currentClaim ? path.relative(root, currentArchivePath) : null,
    invalidation_path: path.relative(root, invalidationPath),
    fresh_runtime_dispatch_required: true,
    idempotent_displacement: idempotentDisplacement,
    idempotent_partial_initial_recovery: partialInitialRecovery,
    recovered_at: now
  };

  // Write evidence before changing the queue.  A crash leaves the original
  // state plus an immutable audit trail; rerunning with the same inputs is
  // deterministic and never fabricates a different claim.
  if (!fs.existsSync(todoSnapshotPath)) atomicWrite(todoSnapshotPath, todoText, 0o600);
  if (currentClaim && !fs.existsSync(currentArchivePath)) atomicJson(currentArchivePath, currentClaim);
  if (!alreadyInvalidated) atomicJson(invalidationPath, proposedInvalidation);
  atomicJson(auditPath, audit);
  atomicJson(currentClaimPath, restoredClaim);
  atomicJson(feedbackPath, feedback);
  atomicWrite(todoFile, restoredTodo, 0o600);

  return {
    schema_version: 1,
    recovered: true,
    idempotent_recovery: alreadyInvalidated,
    idempotent_partial_initial_recovery: partialInitialRecovery,
    recovery_id: recoveryId,
    claim_id: input.claimId,
    selected_todo_id: input.targetId,
    pr_url: review.pr_url,
    fresh_runtime_dispatch_required: true,
    actor_deployment_path: actors.deploymentPath ? path.relative(root, actors.deploymentPath) : null,
    audit_path: path.relative(root, auditPath),
    invalidation_path: path.relative(root, invalidationPath),
    current_claim_path: path.relative(root, currentClaimPath),
    displaced_claim_archive_path: currentClaim ? path.relative(root, currentArchivePath) : null,
    idempotent_displacement: idempotentDisplacement,
    queue_validation: queueValidation
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    const args = parseArgs(process.argv);
    const root = path.resolve(args.repo);
    const result = args.mode === 'detect'
      ? detectLegacyCompletionRecovery({ repoRoot: root, todoPath: args.todo, breakdownPath: args.breakdown })
      : args.mode === 'recover'
        ? recoverLegacyRejectedCompletion({
            repoRoot: root,
            todoPath: args.todo,
            breakdownPath: args.breakdown,
            statePath: args.state,
            completionPath: args.completion,
            snapshotPath: args.snapshot,
            reviewReceiptPath: args.reviewReceipt,
            actorDeploymentPath: args.actorDeployment
          })
        : args.mode === 'attest'
          ? attestLegacyMergedCompletion({
              repoRoot: root,
              todoPath: args.todo,
              statePath: args.state,
              completionPath: args.completion,
              snapshotPath: args.snapshot,
              mergeReceiptPath: args.mergeReceipt,
              actorDeploymentPath: args.actorDeployment
            })
        : (() => { throw new Error(`unknown_mode:${args.mode}`); })();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      schema_version: 1,
      recovered: false,
      error: error?.message ?? String(error)
    }, null, 2));
    process.exit(76);
  }
}
