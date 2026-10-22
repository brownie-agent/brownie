import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  readPullRequestEvent,
  validateImplementationPullRequest,
  validateImplementationPullRequestRemediation
} from './phase-loop-pr-author-guard.mjs';

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

test('accepts a retry with an isolated successor SHA', () => {
  assert.deepEqual(validateImplementationPullRequest({
    author: 'brownie-agent',
    headRef: 'brownie-agent/retry',
    headSha: '2222222222222222222222222222222222222222',
    headRepoOwner: 'brownie-agent',
    headRepoName: 'brownie',
    rejectedHeadSha: '1111111111111111111111111111111111111111',
    rejectedPullRequestNumber: 666
  }), []);
});

test('diagnoses same-SHA remediation with actionable successor-commit guidance', () => {
  const errors = validateImplementationPullRequestRemediation({
    headSha: '1111111111111111111111111111111111111111',
    rejectedHeadSha: '1111111111111111111111111111111111111111',
    rejectedPullRequestNumber: 666
  });
  assert.deepEqual(errors, [
    'rejected implementation pull request #666 remediation must use a fresh successor SHA; 111111111111 is still the rejected head. Push a new commit on top of 111111111111 and retry.'
  ]);
});

test('requires the rejected SHA when a remediation PR is identified', () => {
  assert.match(
    validateImplementationPullRequestRemediation({ rejectedPullRequestNumber: 666 })[0],
    /record it and create a fresh successor commit/u
  );
});
