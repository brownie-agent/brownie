import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBrownieWorkProduct } from './guard-brownie-work-product.mjs';

const actorOptions = { expectedActor: 'implementation-bot' };

const todo = `- [ ] E-20a: Patch only \`scripts/target.mjs\`:
  Route: implementation.
  Source TODO: E-20.
  Depends on: <none>.
  Completion condition: the bounded target change is implemented and verified.
  Forbidden changes: do not edit \`scripts/forbidden.mjs\` or unrelated files.
  Verification: run \`pnpm --workspace-root check\`.`;

test('accepts bounded Brownie work product evidence', () => {
  assert.deepEqual(validateBrownieWorkProduct({
    actor: 'implementation-bot',
    selected_todo: todo,
    changed_files: ['scripts/target.mjs'],
    verification_commands_executed: ['pnpm --workspace-root check'],
    completion_condition_satisfied: true,
    todo_removed: true
  }, actorOptions), []);
});

test('rejects changed files outside patch-only scope', () => {
  const errors = validateBrownieWorkProduct({
    actor: 'implementation-bot',
    selected_todo: todo,
    changed_files: ['scripts/target.mjs', 'README.md'],
    verification_commands_executed: ['pnpm --workspace-root check']
  }, actorOptions);

  assert(errors.some((error) => error.includes('outside Patch only/Create only scope')), errors.join('\n'));
});

test('rejects forbidden changed files', () => {
  const errors = validateBrownieWorkProduct({
    actor: 'implementation-bot',
    selected_todo: todo,
    changed_files: ['scripts/forbidden.mjs'],
    verification_commands_executed: ['pnpm --workspace-root check']
  }, actorOptions);

  assert(errors.some((error) => error.includes('violates Forbidden changes')), errors.join('\n'));
});

test('rejects missing verification execution before completion', () => {
  const errors = validateBrownieWorkProduct({
    actor: 'implementation-bot',
    selected_todo: todo,
    changed_files: ['scripts/target.mjs'],
    verification_commands_executed: []
  }, actorOptions);

  assert(errors.some((error) => error.includes('required verification command was not executed')), errors.join('\n'));
});

test('rejects release-ready flips and non-implementation actors', () => {
  const errors = validateBrownieWorkProduct({
    actor: 'reviewer-a',
    selected_todo: todo,
    changed_files: ['scripts/target.mjs'],
    verification_commands_executed: ['pnpm --workspace-root check'],
    runtime_release_ready_changed: true
  }, actorOptions);

  assert(errors.some((error) => error.includes('implementation-bot')), errors.join('\n'));
  assert(errors.some((error) => error.includes('must not flip release-ready')), errors.join('\n'));
});

test('rejects TODO removal without completion satisfaction', () => {
  const errors = validateBrownieWorkProduct({
    actor: 'implementation-bot',
    selected_todo: todo,
    changed_files: ['scripts/target.mjs'],
    verification_commands_executed: ['pnpm --workspace-root check'],
    todo_removed: true,
    completion_condition_satisfied: false
  }, actorOptions);

  assert(errors.some((error) => error.includes('TODO removal requires completion_condition_satisfied=true')), errors.join('\n'));
});
