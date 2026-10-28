import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPhaseLoopActorDeployment, roleActor, roleBranchPrefixes } from './phase-loop-actor-deployment.mjs';

export const implementationBranchPrefixes = Object.freeze([]);

export function validateImplementationPullRequestRemediation({
  headSha,
  rejectedHeadSha,
  rejectedPullRequestNumber
} = {}) {
  const priorSha = typeof rejectedHeadSha === 'string' ? rejectedHeadSha.trim() : '';
  if (!priorSha && rejectedPullRequestNumber === undefined) return [];

  const retrySha = typeof headSha === 'string' ? headSha.trim() : '';
  const rejectedLabel = rejectedPullRequestNumber === undefined
    ? 'the rejected implementation pull request'
    : `rejected implementation pull request #${rejectedPullRequestNumber}`;
  if (!priorSha) {
    return [`${rejectedLabel} remediation requires the rejected head SHA; record it and create a fresh successor commit before retrying.`];
  }
  if (!retrySha) {
    return [`${rejectedLabel} remediation requires a fresh successor SHA; push a new commit on top of ${priorSha.slice(0, 12)} before retrying.`];
  }
  if (retrySha === priorSha) {
    return [`${rejectedLabel} remediation must use a fresh successor SHA; ${retrySha.slice(0, 12)} is still the rejected head. Push a new commit on top of ${priorSha.slice(0, 12)} and retry.`];
  }
  return [];
}

export function validateImplementationPullRequest({
  author,
  headRef,
  headSha,
  headRepoOwner,
  headRepoName,
  rejectedHeadSha,
  rejectedPullRequestNumber,
  expectedActor,
  branchPrefixes = implementationBranchPrefixes,
  expectedRepoName,
  requireForkOwnerMatch = false
} = {}) {
  const normalizedHeadRef = typeof headRef === 'string' ? headRef.trim() : '';
  if (!expectedActor) return ['implementation pull request validation requires a configured implementation GitHub actor.'];
  if (!branchPrefixes.some((prefix) => normalizedHeadRef.startsWith(prefix))) return [];

  const normalizedAuthor = typeof author === 'string' ? author.trim() : '';
  if (!normalizedAuthor) {
    return [`implementation pull requests on ${normalizedHeadRef} require author ${expectedActor}; no author was detected.`];
  }
  if (normalizedAuthor !== expectedActor) {
    return [`implementation pull requests on ${normalizedHeadRef} require author ${expectedActor}; got ${normalizedAuthor}.`];
  }
  const normalizedOwner = typeof headRepoOwner === 'string' ? headRepoOwner.trim() : '';
  if (requireForkOwnerMatch && normalizedOwner !== expectedActor) {
    return [`implementation pull requests on ${normalizedHeadRef} must originate from the ${expectedActor} fork; head repository owner was ${normalizedOwner || '(unknown)'}.`];
  }
  const normalizedRepo = typeof headRepoName === 'string' ? headRepoName.trim().replace(/\.git$/u, '') : '';
  if (expectedRepoName && normalizedRepo !== expectedRepoName) {
    return [`implementation pull requests on ${normalizedHeadRef} must originate from ${expectedActor}/${expectedRepoName}; head repository was ${normalizedOwner || '(unknown)'}/${normalizedRepo || '(unknown)'}.`];
  }
  return validateImplementationPullRequestRemediation({ headSha, rejectedHeadSha, rejectedPullRequestNumber });
}

export function readPullRequestEvent(eventPath) {
  try {
    const event = JSON.parse(fs.readFileSync(path.resolve(eventPath), 'utf8'));
    if (!event?.pull_request || typeof event.pull_request.head?.ref !== 'string' || !event.pull_request.head.ref.trim()) {
      return { author: '', headRef: '', error: 'pull_request.head.ref is required.' };
    }
    return {
      author: event?.pull_request?.user?.login ?? '',
      headRef: event?.pull_request?.head?.ref ?? '',
      headSha: event?.pull_request?.head?.sha ?? '',
      headRepoOwner: event?.pull_request?.head?.repo?.owner?.login ?? '',
      headRepoName: event?.pull_request?.head?.repo?.name ?? '',
      rejectedHeadSha: process.env.PHASE_LOOP_REJECTED_HEAD_SHA ?? '',
      rejectedPullRequestNumber: process.env.PHASE_LOOP_REJECTED_PR_NUMBER || undefined
    };
  } catch (error) {
    return { author: '', headRef: '', error: error.message };
  }
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  const eventPath = process.argv.includes('--event-path')
    ? process.argv[process.argv.indexOf('--event-path') + 1]
    : process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    console.error('Implementation pull-request author guard failed: GITHUB_EVENT_PATH is required.');
    process.exit(1);
  }
  const deploymentResult = loadPhaseLoopActorDeployment({
    repoRoot: process.env.GITHUB_WORKSPACE ? path.resolve(process.env.GITHUB_WORKSPACE) : process.cwd()
  });
  if (!deploymentResult.ok) {
    console.error(`Implementation pull-request author guard failed: ${deploymentResult.errors.join(' ')}`);
    process.exit(1);
  }
  const implementation = deploymentResult.deployment.roles.implementation;
  const event = readPullRequestEvent(eventPath);
  const errors = event.error
    ? [`implementation pull-request event could not be read: ${event.error}`]
    : validateImplementationPullRequest({
      ...event,
      expectedActor: roleActor(deploymentResult.deployment, 'implementation'),
      branchPrefixes: roleBranchPrefixes(deploymentResult.deployment, 'implementation'),
      expectedRepoName: deploymentResult.deployment.repository.split('/')[1],
      requireForkOwnerMatch: implementation.require_fork_owner_match === true
    });
  if (errors.length > 0) {
    console.error('Implementation pull-request author guard failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(`Implementation pull-request author guard passed for ${event.headRef || 'non-implementation branch'}.`);
}
