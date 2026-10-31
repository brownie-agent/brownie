import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  durableCompletionRecordReceipt,
  readTodoCompletionRecords,
  readTrackedBreakdownReplanRecords,
  resolveTodoState
} from './phase-loop-todo-state.mjs';

const parent = `- [x] E-parent: Parent split anchor:
  Route: implementation.
  Source TODO: review.
  Depends on: <none>.`;
const childOne = `- [ ] E-child-1: Patch only \`scripts/a.mjs\`:
  Route: implementation.
  Source TODO: E-parent.
  Depends on: <none>.`;
const childTwo = `- [ ] E-child-2: Patch only \`scripts/b.mjs\`:
  Route: implementation.
  Source TODO: E-parent.
  Depends on: E-child-1.`;
const replan = {
  record_type: 'todo_replan',
  operation: 'split_parent_into_children',
  parent_status: 'superseded_by_children',
  parent_todo_id: 'E-parent',
  generated_child_ids: ['E-child-1', 'E-child-2']
};

test('Source TODO is lineage and never inherits completion', () => {
  const state = resolveTodoState({ todoText: `${parent}\n\n${childOne}\n` });

  assert(state.completedIds.has('E-parent'));
  assert(!state.completedIds.has('E-child-1'));
});

test('superseded parent is not completed or dependency-resolved while children remain pending', () => {
  const state = resolveTodoState({
    todoText: `${parent}\n\n${childOne}\n\n${childTwo}\n`,
    replanRecords: [replan],
    completionRecords: [{
      selected_todo_id: 'E-child-1',
      reason: 'source_parent_completed',
      source_todo_id: 'E-parent'
    }]
  });

  assert(state.supersededIds.has('E-parent'));
  assert(!state.completedIds.has('E-parent'));
  assert(!state.resolvedIds.has('E-parent'));
  assert(!state.completedIds.has('E-child-1'));
  assert.equal(state.invalidatedCompletionRecords.length, 1);
});

test('superseded parent resolves only after every generated child completes', () => {
  const state = resolveTodoState({
    todoText: parent,
    replanRecords: [replan],
    completionRecords: [
      { selected_todo_id: 'E-child-1', reason: 'verified_completion' },
      { selected_todo_id: 'E-child-2', reason: 'verified_completion' }
    ]
  });

  assert(state.supersededIds.has('E-parent'));
  assert(!state.completedIds.has('E-parent'));
  assert(state.resolvedIds.has('E-parent'));
});

test('an exact durable invalidation retracts only its matching completion receipt', () => {
  const state = resolveTodoState({
    todoText: childOne,
    completionRecords: [
      { claim_id: 'claim-invalidated', selected_todo_id: 'E-child-1', reason: 'verified_completion' },
      { claim_id: 'claim-retained', selected_todo_id: 'E-child-1', reason: 'verified_completion' }
    ],
    completionInvalidationRecords: [{
      record_type: 'todo_completion_invalidation',
      selected_todo_id: 'E-child-1',
      invalidated_completion_claim_id: 'claim-invalidated',
      reason: 'dirty_target_automatic_apply_reverted'
    }]
  });

  assert(state.completedIds.has('E-child-1'));
  assert.equal(state.invalidatedCompletionRecords.length, 1);
});

test('an invalidation retracts a false completion when it is the only receipt', () => {
  const state = resolveTodoState({
    todoText: childOne,
    completionRecords: [{ claim_id: 'claim-false', selected_todo_id: 'E-child-1', reason: 'verified_completion' }],
    completionInvalidationRecords: [{
      record_type: 'todo_completion_invalidation',
      selected_todo_id: 'E-child-1',
      invalidated_completion_claim_id: 'claim-false',
      reason: 'dirty_target_automatic_apply_reverted'
    }]
  });

  assert(!state.completedIds.has('E-child-1'));
  assert.equal(state.invalidatedCompletionRecords.length, 1);
});

test('an absent dependency backed only by a legacy completion record remains identifiable for recovery', () => {
  const state = resolveTodoState({
    todoText: `- [ ] E-dependent: blocked by historical prerequisite.
  Depends on: E-erased.
`,
    completionRecords: [{
      schema_version: 1,
      claim_id: 'legacy-claim',
      selected_todo_id: 'E-erased'
    }]
  });

  assert(state.completedIds.has('E-erased'));
  assert(state.unverifiedArchivedCompletionIds.has('E-erased'));
  assert.equal(state.unverifiedCompletionRecords[0]?.reason, 'legacy_completion_record_without_delivery_receipt');
});

test('a schema-v2 completion requires an internally consistent durable review receipt', () => {
  const record = {
    schema_version: 2,
    claim_id: 'claim-verified',
    root_claim_id: 'claim-verified',
    selected_todo_id: 'E-verified',
    selected_todo_sha256: 'a'.repeat(64),
    delivery_receipt: {
      schema_version: 1,
      claim_id: 'claim-verified',
      root_claim_id: 'claim-verified',
      selected_todo_sha256: 'a'.repeat(64),
      author: 'brownie-agent',
      reviewer: 'globalpocket',
      merge_actor: 'globalpocket',
      approved: true,
      ci_passed: true,
      merged: true,
      semantic_completion_evidence: {
        schema_version: 1,
        root_claim_id: 'claim-verified',
        selected_todo_sha256: 'a'.repeat(64),
        completion_condition_sha256: 'b'.repeat(64),
        verification_results: [{ command: 'node --test fixture.mjs', exit_code: 0 }],
        observables: [{ kind: 'fixture', sha256: 'c'.repeat(64) }]
      }
    }
  };
  assert.equal(durableCompletionRecordReceipt(record).valid, true);
  assert.equal(durableCompletionRecordReceipt({ ...record, delivery_receipt: { ...record.delivery_receipt, merged: false } }).valid, false);
});

test('claim-id and run-stamp aliases do not duplicate one logical completion receipt', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-todo-completion-alias-'));
  const directory = path.join(repoRoot, '.brownie/private/phase-loop/todo-completions');
  fs.mkdirSync(directory, { recursive: true });
  const record = { schema_version: 1, claim_id: 'claim-alias', selected_todo_id: 'E-alias' };
  fs.writeFileSync(path.join(directory, 'claim-alias.json'), JSON.stringify(record));
  fs.writeFileSync(path.join(directory, 'run-stamp.json'), JSON.stringify(record));
  assert.equal(readTodoCompletionRecords(repoRoot).length, 1);
});

test('a generated child cannot belong to multiple superseded parents', () => {
  const state = resolveTodoState({
    todoText: `${parent}\n\n${childOne}\n`,
    replanRecords: [
      replan,
      { ...replan, parent_todo_id: 'E-other-parent', generated_child_ids: ['E-child-1'] }
    ]
  });

  assert(state.errors.some((error) => error.code === 'todo_child_has_multiple_parents'));
});

test('an orphaned historical child warns without resolving its parent or stopping unrelated work', () => {
  const state = resolveTodoState({
    todoText: '- [ ] E-24-unrelated: independent work',
    replanRecords: [{
      ...replan,
      parent_todo_id: 'E-23-parent',
      generated_child_ids: ['E-23-missing-child']
    }]
  });

  assert.deepEqual(state.errors, []);
  assert.equal(state.warnings[0]?.code, 'superseded_parent_child_has_no_live_or_terminal_state');
  assert.equal(state.resolvedIds.has('E-23-parent'), false);
});

test('tracked no-eligible split keeps its checked parent unresolved until every target completes', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-todo-state-'));
  fs.mkdirSync(path.join(repoRoot, '.brownie'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.brownie/todo-breakdown.md'), `# Breakdown

## E-23a-release-artifact-portable-archive no-eligible multi-target split

Parent TODO: E-23a-release-artifact-portable-archive: - [ ] parent

Targets:

- E-23a-release-artifact-portable-archive-target-01: \`scripts/a.mjs\`
- E-23a-release-artifact-portable-archive-target-02: \`scripts/b.mjs\`
- E-23a-release-artifact-portable-archive-target-03: \`.github/workflows/release.yml\`

Dependency graph:

- E-23a-release-artifact-portable-archive-target-01: <none>
`);

  const [trackedReplan] = readTrackedBreakdownReplanRecords(repoRoot);
  assert.equal(trackedReplan.parent_todo_id, 'E-23a-release-artifact-portable-archive');
  assert.deepEqual(trackedReplan.generated_child_ids, [
    'E-23a-release-artifact-portable-archive-target-01',
    'E-23a-release-artifact-portable-archive-target-02',
    'E-23a-release-artifact-portable-archive-target-03'
  ]);

  const state = resolveTodoState({
    todoText: '- [x] E-23a-release-artifact-portable-archive: checked dependency anchor',
    replanRecords: [trackedReplan],
    completionRecords: [{
      selected_todo_id: 'E-23a-release-artifact-portable-archive-target-01',
      reason: 'verified_completion'
    }]
  });

  assert(state.supersededIds.has('E-23a-release-artifact-portable-archive'));
  assert(!state.completedIds.has('E-23a-release-artifact-portable-archive'));
  assert(!state.resolvedIds.has('E-23a-release-artifact-portable-archive'));
});

test('tracked replans are read from the queue-specific breakdown path', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-todo-state-root-'));
  const queueRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-todo-state-queue-'));
  fs.mkdirSync(path.join(repoRoot, '.brownie'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.brownie/todo-breakdown.md'), `# Breakdown

## E-collision no-eligible multi-target split

Targets:
- E-collision-target-01: \`wrong.mjs\`
`);
  const queueBreakdownPath = path.join(queueRoot, 'todo-breakdown.md');
  fs.writeFileSync(queueBreakdownPath, '# Queue-specific breakdown\n');

  assert.deepEqual(readTrackedBreakdownReplanRecords(repoRoot, queueBreakdownPath), []);
});
