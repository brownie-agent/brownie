import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  resolvePhaseLoopGitHubProfile,
  validatePhaseLoopActorPreflight
} from './phase-loop-actor-preflight.mjs';

const policy = {
  repository: 'globalpocket/brownie',
  implementation_actor: 'brownie-agent',
  review_actor: 'globalpocket',
  merge_actor: 'globalpocket',
  implementation_branch_prefixes: ['brownie-agent/', 'phase-loop/'],
  review_branch_prefixes: ['codex/']
};

test('controller passes the implementation workspace to actor preflight', () => {
  const controller = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'phase-loop.sh'), 'utf8');
  assert.match(controller, /phase-loop-actor-preflight\.mjs" --role implementation --repo-root "\$PHASE_LOOP_WORKSPACE_ROOT"/u);
  assert.match(controller, /--print-gh-config-dir/u);
  assert.match(controller, /GH_CONFIG_DIR="\$implementation_gh_config_dir" gh pr create/u);
});

test('implementation resolves only the repository-private brownie-agent profile', () => {
  const repo = fs.mkdtempSync(path.join(process.cwd(), '.test-actor-profile-'));
  try {
    fs.mkdirSync(path.join(repo, '.brownie/private/gh-brownie-agent'), { recursive: true });
    const profile = resolvePhaseLoopGitHubProfile({
      repoRoot: repo,
      role: 'implementation',
      actor: 'brownie-agent',
      env: { GH_CONFIG_DIR: '/must-not-be-used' }
    });
    assert.equal(profile.ok, true);
    assert.equal(profile.profile_id, 'private-brownie-agent');
    assert.equal(profile.github_config_dir, path.join(repo, '.brownie/private/gh-brownie-agent'));
    assert.equal(profile.env.GH_CONFIG_DIR, profile.github_config_dir);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('implementation rejects a credential profile outside repository private state', () => {
  const repo = fs.mkdtempSync(path.join(process.cwd(), '.test-actor-profile-'));
  try {
    const profile = resolvePhaseLoopGitHubProfile({
      repoRoot: repo,
      role: 'implementation',
      actor: 'brownie-agent',
      env: { PHASE_LOOP_IMPLEMENTATION_GH_CONFIG_DIR: '/tmp/not-brownie-private' }
    });
    assert.equal(profile.ok, false);
    assert.equal(profile.code, 'implementation_github_profile_outside_private_root');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('accepts brownie-agent implementation actor on implementation branch', () => {
  const errors = validatePhaseLoopActorPreflight({
    repository: 'globalpocket/brownie',
    githubActor: 'brownie-agent',
    branch: 'brownie-agent/fix-release-evidence'
  }, { role: 'implementation', policy });
  assert.deepEqual(errors, []);
});

test('rejects globalpocket implementation actor', () => {
  const errors = validatePhaseLoopActorPreflight({
    repository: 'globalpocket/brownie',
    githubActor: 'globalpocket',
    branch: 'brownie-agent/fix-release-evidence'
  }, { role: 'implementation', policy });
  assert(errors.some((error) => error.includes('must use GitHub actor brownie-agent')));
  assert(errors.some((error) => error.includes('forbidden actor globalpocket')));
});

test('rejects implementation from main or codex review branch', () => {
  const mainErrors = validatePhaseLoopActorPreflight({
    repository: 'globalpocket/brownie',
    githubActor: 'brownie-agent',
    branch: 'main'
  }, { role: 'implementation', policy });
  assert(mainErrors.some((error) => error.includes('non-main implementation branch')));

  const codexErrors = validatePhaseLoopActorPreflight({
    repository: 'globalpocket/brownie',
    githubActor: 'brownie-agent',
    branch: 'codex/review-only'
  }, { role: 'implementation', policy });
  assert(codexErrors.some((error) => error.includes('must start with one of')));
});

test('accepts globalpocket review actor and rejects brownie-agent review actor', () => {
  const accepted = validatePhaseLoopActorPreflight({
    repository: 'globalpocket/brownie',
    githubActor: 'globalpocket',
    branch: 'codex/review'
  }, { role: 'review', policy });
  assert.deepEqual(accepted, []);

  const rejected = validatePhaseLoopActorPreflight({
    repository: 'globalpocket/brownie',
    githubActor: 'brownie-agent',
    branch: 'brownie-agent/fix'
  }, { role: 'review', policy });
  assert(rejected.some((error) => error.includes('must use GitHub actor globalpocket')));
  assert(rejected.some((error) => error.includes('forbidden actor brownie-agent')));
});

test('rejects unknown repository and missing GitHub actor', () => {
  const errors = validatePhaseLoopActorPreflight({
    repository: 'someone/else',
    githubActor: null,
    branch: 'brownie-agent/fix'
  }, { role: 'implementation', policy });
  assert(errors.some((error) => error.includes('remote origin must resolve')));
  assert(errors.some((error) => error.includes('authenticated GitHub actor must be available')));
});
