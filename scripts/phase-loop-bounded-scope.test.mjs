import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedScopeEntries, boundedScopeValues, boundedScopes } from './phase-loop-bounded-scope.mjs';

const mixedClause = '- [ ] E-scope: Patch only `scripts/one.mjs` and `scripts/one.test.mjs`, then patch only `package.json` and `.github/workflows/release.yml`: invoke them.';

test('parses every mixed-case bounded operation clause in source order', () => {
  assert.deepEqual(boundedScopeEntries(mixedClause), [
    { operation: 'patch', path: 'scripts/one.mjs' },
    { operation: 'patch', path: 'scripts/one.test.mjs' },
    { operation: 'patch', path: 'package.json' },
    { operation: 'patch', path: '.github/workflows/release.yml' }
  ]);
  assert.deepEqual(boundedScopes(mixedClause), [
    'scripts/one.mjs',
    'scripts/one.test.mjs',
    'package.json',
    '.github/workflows/release.yml'
  ]);
});

test('keeps patch and create targets distinct without accepting prose paths', () => {
  const line = '- [ ] E-scope: create only `scripts/new.mjs`, then PATCH ONLY `scripts/existing.mjs`: do not edit `README.md`.';
  assert.deepEqual(boundedScopeValues(line, 'create'), ['scripts/new.mjs']);
  assert.deepEqual(boundedScopeValues(line, 'Patch only'), ['scripts/existing.mjs']);
  assert.deepEqual(boundedScopes(line), ['scripts/new.mjs', 'scripts/existing.mjs']);
});

test('preserves every Oxford-comma bounded target before the next operation', () => {
  const line = '- [ ] E-scope: Patch only `scripts/one.mjs`, `scripts/one.test.mjs`, and `package.json`, then patch only `.github/workflows/release.yml`: invoke them.';
  assert.deepEqual(boundedScopeEntries(line), [
    { operation: 'patch', path: 'scripts/one.mjs' },
    { operation: 'patch', path: 'scripts/one.test.mjs' },
    { operation: 'patch', path: 'package.json' },
    { operation: 'patch', path: '.github/workflows/release.yml' }
  ]);
});
