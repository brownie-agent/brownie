import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateBdkPublicHarness } from './guard-bdk-public-harness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('current public harness adapter contract is valid', () => {
  assert.deepEqual(validateBdkPublicHarness(), []);
});

test('public trajectory contract registers nonterminal repair feedback', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs/architecture/bdk-trajectory.schema.json'), 'utf8'));
  const eventTypes = schema.properties.events.items.properties.type.enum;
  assert(eventTypes.includes('todo.repair_feedback'));
  const adapter = fs.readFileSync(path.join(repoRoot, 'docs/architecture/bdk-public-harness-adapter.md'), 'utf8');
  assert(adapter.includes('`todo.repair_feedback`'));
});

test('rejects missing Patch only targets in TODO leaves', () => {
  const errors = validateBdkPublicHarness({
    todoPath: 'scripts/fixtures/bdk-public-harness-bad-todo.md',
    breakdownPath: 'scripts/fixtures/bdk-public-harness-breakdown.md'
  });
  assert(errors.some((error) => error.includes('Patch only target does not exist')));
});

test('rejects missing breakdown entries for derived TODO leaves', () => {
  const errors = validateBdkPublicHarness({
    todoPath: 'scripts/fixtures/bdk-public-harness-missing-breakdown-todo.md',
    breakdownPath: 'scripts/fixtures/bdk-public-harness-breakdown.md'
  });
  assert(errors.some((error) => error.includes('missing derived leaf TODO id')));
});

test('rejects malformed public harness trajectory JSONL', () => {
  const errors = validateBdkPublicHarness({
    trajectoryPath: 'scripts/fixtures/bdk-public-harness-bad-trajectory.jsonl'
  });
  assert(errors.some((error) => error.includes('claim_id is required')));
});
