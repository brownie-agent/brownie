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

const actorOptions = {
  expectedActor: 'implementation-bot',
  branchPrefixes: ['automation/'],
  expectedRepoName: 'example-repo',
  requireForkOwnerMatch: true
};

test('accepts configured implementation pull requests from a configured fork', () => {
  assert.deepEqual(validateImplementationPullRequest({ author: 'implementation-bot', headRef: 'automation/fix', headRepoOwner: 'implementation-bot', headRepoName: 'example-repo', ...actorOptions }), []);
});

test('rejects a review-authored implementation pull request', () => {
  assert.deepEqual(
    validateImplementationPullRequest({ author: 'reviewer-a', headRef: 'automation/fix', headRepoOwner: 'implementation-bot', headRepoName: 'example-repo', ...actorOptions }),
    ['implementation pull requests on automation/fix require author implementation-bot; got reviewer-a.']
  );
});

test('rejects an implementation branch whose head is in the base repository', () => {
  assert.deepEqual(
    validateImplementationPullRequest({ author: 'implementation-bot', headRef: 'automation/fix', headRepoOwner: 'example-org', headRepoName: 'example-repo', ...actorOptions }),
    ['implementation pull requests on automation/fix must originate from the implementation-bot fork; head repository owner was example-org.']
  );
});

test('does not apply implementation author policy to review branches', () => {
  assert.deepEqual(validateImplementationPullRequest({ author: 'reviewer-a', headRef: 'review/fix', ...actorOptions }), []);
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
    author: 'implementation-bot',
    headRef: 'automation/retry',
    headSha: '2222222222222222222222222222222222222222',
    headRepoOwner: 'implementation-bot',
    headRepoName: 'example-repo',
    rejectedHeadSha: '1111111111111111111111111111111111111111',
    rejectedPullRequestNumber: 666,
    ...actorOptions
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
