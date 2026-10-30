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
    expectedAuthor: 'brownie-agent',
    expectedReviewer: 'globalpocket'
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
    else if (key === '--expected-author') { args.expectedAuthor = value; index += 1; }
    else if (key === '--expected-reviewer') { args.expectedReviewer = value; index += 1; }
    else throw new Error(`unknown_argument:${key}`);
  }
  return args;
}

function assertRecoveryInputs({ completion, snapshot, review, todoText, expectedAuthor, expectedReviewer }) {
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
  if (findBlock(todoText, targetId)) {
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

export function recoverLegacyRejectedCompletion({
  repoRoot,
  todoPath = defaultTodo,
  breakdownPath = defaultBreakdown,
  statePath = defaultState,
  completionPath,
  snapshotPath,
  reviewReceiptPath,
  expectedAuthor = 'brownie-agent',
  expectedReviewer = 'globalpocket',
  now = new Date().toISOString()
}) {
  const root = path.resolve(repoRoot);
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
      return {
        schema_version: 1,
        recovered: false,
        idempotent_recovery: true,
        recovery_id: preliminaryRecoveryId,
        claim_id: preliminaryClaimId,
        selected_todo_id: preliminaryTargetId,
        pr_url: review.pr_url
      };
    }
  }
  const input = assertRecoveryInputs({ completion, snapshot, review, todoText, expectedAuthor, expectedReviewer });
  const invalidations = existingInvalidations;
  const alreadyInvalidated = invalidations.some((record) => (
    record.selected_todo_id === input.targetId && record.invalidated_completion_claim_id === input.claimId
  ));
  const recoveryId = sha256(`${input.claimId}\n${sha256(input.selected)}\n${review.pr_url}\n${review.head_sha}`).slice(0, 24);
  const currentClaimPath = path.join(stateRoot, 'todo-claims', 'current.json');
  const currentClaim = fs.existsSync(currentClaimPath) ? readJson(currentClaimPath) : null;
  const currentStatus = currentClaim?.status;
  if (currentStatus === 'claimed' || currentStatus === 'in_progress') {
    if (!(currentClaim?.claim_id === input.claimId && currentClaim?.legacy_completion_recovery?.recovery_id === recoveryId)) {
      throw new Error('active_claim_must_be_preserved_before_legacy_recovery');
    }
  }

  const restoredParent = replaceCheckbox(input.parent, false);
  let restoredTodo = todoText;
  if (restoredParent !== input.parent) {
    const parentIndex = restoredTodo.indexOf(input.parent);
    if (parentIndex < 0) throw new Error('legacy_source_parent_not_unique');
    restoredTodo = `${restoredTodo.slice(0, parentIndex)}${restoredParent}${restoredTodo.slice(parentIndex + input.parent.length)}`;
  }
  restoredTodo = insertAfterBlock(restoredTodo, restoredParent, input.selected);

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
  const currentArchivePath = path.join(stateRoot, 'todo-claims', `legacy-completion-recovery-${recoveryId}-current-before.json`);
  const auditPath = path.join(recoveryDir, `${recoveryId}.json`);
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
      }
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
    recovered_at: now
  };

  // Write evidence before changing the queue.  A crash leaves the original
  // state plus an immutable audit trail; rerunning with the same inputs is
  // deterministic and never fabricates a different claim.
  atomicWrite(todoSnapshotPath, todoText, 0o600);
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
    recovery_id: recoveryId,
    claim_id: input.claimId,
    selected_todo_id: input.targetId,
    pr_url: review.pr_url,
    audit_path: path.relative(root, auditPath),
    invalidation_path: path.relative(root, invalidationPath),
    current_claim_path: path.relative(root, currentClaimPath),
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
            expectedAuthor: args.expectedAuthor,
            expectedReviewer: args.expectedReviewer
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
