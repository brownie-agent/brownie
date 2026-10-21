import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readPullRequestEvent, validateImplementationPullRequest } from './phase-loop-pr-author-guard.mjs';

test('accepts brownie-agent implementation pull requests from the brownie-agent fork', () => {
  assert.deepEqual(validateImplementationPullRequest({ author: 'brownie-agent', headRef: 'brownie-agent/fix', headRepoOwner: 'brownie-agent', headRepoName: 'brownie' }), []);
});

test('rejects a globalpocket-authored implementation pull request', () => {
  assert.deepEqual(
    validateImplementationPullRequest({ author: 'globalpocket', headRef: 'brownie-agent/fix', headRepoOwner: 'brownie-agent', headRepoName: 'brownie' }),
    ['implementation pull requests on brownie-agent/fix require author brownie-agent; got globalpocket.']
  );
});

test('rejects an implementation branch whose head is in the base repository', () => {
  assert.deepEqual(
    validateImplementationPullRequest({ author: 'brownie-agent', headRef: 'brownie-agent/fix', headRepoOwner: 'globalpocket', headRepoName: 'brownie' }),
    ['implementation pull requests on brownie-agent/fix must originate from the brownie-agent fork; head repository owner was globalpocket.']
  );
});

test('does not apply implementation author policy to review branches', () => {
  assert.deepEqual(validateImplementationPullRequest({ author: 'globalpocket', headRef: 'codex/review' }), []);
});

test('fails closed for missing author on an implementation branch', () => {
  const eventPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-pr-author-')), 'event.json');
  fs.writeFileSync(eventPath, '{"pull_request":{"head":{}}}\n');
  const event = readPullRequestEvent(eventPath);
  assert.equal(event.author, '');
  assert.equal(event.headRef, '');
  assert.equal(event.error, 'pull_request.head.ref is required.');
});
