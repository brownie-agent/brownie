import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const implementationBranchPrefixes = Object.freeze(['brownie-agent/', 'phase-loop/']);

export function validateImplementationPullRequest({
  author,
  headRef,
  headRepoOwner,
  headRepoName,
  expectedActor = 'brownie-agent',
  branchPrefixes = implementationBranchPrefixes,
  expectedRepoName = 'brownie'
} = {}) {
  const normalizedHeadRef = typeof headRef === 'string' ? headRef.trim() : '';
  if (!branchPrefixes.some((prefix) => normalizedHeadRef.startsWith(prefix))) return [];

  const normalizedAuthor = typeof author === 'string' ? author.trim() : '';
  if (!normalizedAuthor) {
    return [`implementation pull requests on ${normalizedHeadRef} require author ${expectedActor}; no author was detected.`];
  }
  if (normalizedAuthor !== expectedActor) {
    return [`implementation pull requests on ${normalizedHeadRef} require author ${expectedActor}; got ${normalizedAuthor}.`];
  }
  const normalizedOwner = typeof headRepoOwner === 'string' ? headRepoOwner.trim() : '';
  if (normalizedOwner !== expectedActor) {
    return [`implementation pull requests on ${normalizedHeadRef} must originate from the ${expectedActor} fork; head repository owner was ${normalizedOwner || '(unknown)'}.`];
  }
  const normalizedRepo = typeof headRepoName === 'string' ? headRepoName.trim().replace(/\.git$/u, '') : '';
  if (normalizedRepo !== expectedRepoName) {
    return [`implementation pull requests on ${normalizedHeadRef} must originate from ${expectedActor}/${expectedRepoName}; head repository was ${normalizedOwner || '(unknown)'}/${normalizedRepo || '(unknown)'}.`];
  }
  return [];
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
      headRepoOwner: event?.pull_request?.head?.repo?.owner?.login ?? '',
      headRepoName: event?.pull_request?.head?.repo?.name ?? ''
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
  const event = readPullRequestEvent(eventPath);
  const errors = event.error
    ? [`implementation pull-request event could not be read: ${event.error}`]
    : validateImplementationPullRequest(event);
  if (errors.length > 0) {
    console.error('Implementation pull-request author guard failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(`Implementation pull-request author guard passed for ${event.headRef || 'non-implementation branch'}.`);
}
