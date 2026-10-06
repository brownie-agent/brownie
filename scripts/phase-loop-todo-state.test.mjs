import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTodoState } from './phase-loop-todo-state.mjs';

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
