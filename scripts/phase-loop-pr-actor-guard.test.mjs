import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  readAuthenticatedActor,
  validateImplementationPrActor
} from './phase-loop-pr-actor-guard.mjs';

test('accepts brownie-agent as the implementation PR actor', () => {
  assert.deepEqual(validateImplementationPrActor('brownie-agent'), []);
});

test('rejects globalpocket before implementation PR creation', () => {
  const errors = validateImplementationPrActor('globalpocket');
  assert.deepEqual(errors, ['implementation PR creation requires GitHub actor brownie-agent; got globalpocket.']);
});

test('fails closed when GitHub actor lookup fails', () => {
  const result = readAuthenticatedActor({
    run: () => ({ status: 1, stdout: '', stderr: 'not authenticated' })
  });
  assert.equal(result.actor, '');
  assert.equal(result.error, 'not authenticated');
});

test('rechecks the authenticated actor before push and PR creation', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const source = fs.readFileSync(path.join(root, 'phase-loop.sh'), 'utf8');
  const pushIndex = source.indexOf('git -c credential.helper= -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $BROWNIE_AGENT_AUTH" push');
  const createIndex = source.indexOf('gh pr create --base "$PHASE_LOOP_PR_BASE"');
  const guardIndices = [];
  let cursor = 0;
  while ((cursor = source.indexOf('phase_loop_require_implementation_pr_actor', cursor)) >= 0) {
    guardIndices.push(cursor);
    cursor += 1;
  }
  assert.ok(pushIndex > 0);
  assert.ok(createIndex > pushIndex);
  assert.ok(guardIndices.some((index) => index < pushIndex && pushIndex - index < 1000));
  assert.ok(guardIndices.some((index) => index < createIndex && createIndex - index < 1000));
});
