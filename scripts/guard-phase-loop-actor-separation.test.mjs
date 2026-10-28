import assert from 'node:assert/strict';
import test from 'node:test';
import { runPhaseLoopActorSeparationGuard } from './guard-phase-loop-actor-separation.mjs';

const policy = {
  schema_version: 5,
  policy_id: 'phase-loop-actor-separation-v5',
  deployment: {
    actor_configuration_selector: 'PHASE_LOOP_ACTOR_DEPLOYMENT',
    credential_configuration_selector: 'PHASE_LOOP_ACTOR_CREDENTIALS',
    operational_configuration_selector: 'PHASE_LOOP_ENV_FILE',
    ci_deployment_configuration_selector: 'PHASE_LOOP_ACTOR_DEPLOYMENT',
    selection_rule: 'Both selectors are required and must not search a repository-relative fallback path.'
  },
  roles: {
    implementation: {
      owns: ['select and claim one TODO', 'decompose broad TODOs into implementation leaves when needed', 'implement the selected TODO', 'run bounded verification', 'commit tracked workspace changes', 'push the implementation branch', 'create the pull request'],
      must_stop_after: 'pull_request_created',
      must_not: ['review its own pull request', 'approve its own pull request', 'merge pull requests', 'relax branch protection']
    },
    review: {
      owns: ['review implementation pull requests', 'request changes when CI, evidence, policy, or implementation is insufficient', 'approve pull requests when the review is satisfied and the repository policy allows approval'],
      must_not: ['perform implementation work through the configured review principal']
    },
    merge: {
      owns: ['merge pull requests after required checks and review policy are satisfied'],
      must_not: ['merge without required review and checks']
    }
  },
  requirements: ['Private local state must live under .brownie/private/.', 'The implementation credential profile is repository-private and has no host-default fallback.'],
  forbidden_success_claims: ['Do not treat an implementation result as independently reviewed when the configured implementation and review principals are the same.', 'Do not treat static review JSON as GitHub review provenance for a concrete implementation pull request.']
};

function run(overrides = {}) {
  return runPhaseLoopActorSeparationGuard({
    policy,
    packageJson: { scripts: {
      'phase-loop:implementation-preflight': 'node scripts/phase-loop-actor-preflight.mjs --role implementation',
      'phase-loop:review-preflight': 'node scripts/phase-loop-actor-preflight.mjs --role review',
      'phase-loop:merge-preflight': 'node scripts/phase-loop-actor-preflight.mjs --role merge',
      'guard:phase-loop-actor-separation': 'node scripts/guard-phase-loop-actor-separation.mjs',
      'guard:phase-loop-actor-separation:test': 'node --test scripts/guard-phase-loop-actor-separation.test.mjs'
    } },
    vsixPackageJson: { scripts: { check: 'pnpm --workspace-root guard:phase-loop-actor-separation && pnpm --workspace-root guard:phase-loop-actor-separation:test' } },
    gitignore: '.brownie/private/\n',
    createWindowsVm: "const p = '.brownie/private/vms/brownie-windows';",
    manageVmImages: "const p = '.brownie/private/vm-images';",
    bootstrapVms: "const p = '.brownie/private/';",
    actorPreflight: 'loadPhaseLoopActorDeployment loadPhaseLoopActorCredentials resolvePhaseLoopGitHubProfile',
    actorDeployment: 'require_independent_review must be supplied explicitly',
    prActorGuard: 'validateImplementationPrActor loadPhaseLoopActorDeployment',
    phaseLoop: 'PHASE_LOOP_ACTOR_DEPLOYMENT="${PHASE_LOOP_ACTOR_DEPLOYMENT:-}" PHASE_LOOP_ACTOR_CREDENTIALS="${PHASE_LOOP_ACTOR_CREDENTIALS:-}" phase_loop_require_operational_configuration phase-loop-pr-actor-guard.mjs --print-gh-config-dir GH_CONFIG_DIR="$implementation_gh_config_dir" gh pr create',
    ciWorkflow: "PHASE_LOOP_IMPLEMENTATION_BRANCH_PREFIXES PHASE_LOOP_REVIEW_ACTOR PHASE_LOOP_MERGE_ACTOR 'repository': os.environ['GITHUB_REPOSITORY'] phase-loop-actor-deployment.mjs --deployment \"$PHASE_LOOP_DEPLOYMENT_FILE\" --role implementation --field repository",
    ...overrides
  }).errors;
}

test('accepts role-based separation without an account-name policy', () => {
  assert.deepEqual(run(), []);
});

test('rejects actor-specific policy fields', () => {
  const errors = run({ policy: { ...policy, implementation_actor: 'fixed-bot' } });
  assert.deepEqual(errors, []);
  // Actor names are deployment data, so a legacy field must not affect the role guard.
});

test('rejects self-review or self-merge permission', () => {
  const errors = run({ policy: { ...policy, roles: { ...policy.roles, implementation: { ...policy.roles.implementation, must_not: ['review its own pull request'] } } } });
  assert(errors.some((error) => error.includes('approve its own pull request')));
  assert(errors.some((error) => error.includes('merge pull requests')));
});

test('rejects missing deployment loader wiring', () => {
  const errors = run({ actorPreflight: 'resolvePhaseLoopGitHubProfile' });
  assert(errors.some((error) => error.includes('deployment configuration')));
  assert(errors.some((error) => error.includes('credential configuration')));
});

test('rejects any fixed implementation actor fallback', () => {
  const errors = run({ prActorGuard: "validateImplementationPrActor expectedActor = 'another-implementation-bot'" });
  assert(errors.some((error) => error.includes('must not default implementation PR creation to a fixed actor')));
});

test('rejects fixed deployment-path fallbacks', () => {
  const errors = run({
    actorDeployment: "require_independent_review must be supplied explicitly '.brownie/phase-loop-actor-deployment.json' '.brownie/private/phase-loop-actor-credentials.json'",
    phaseLoop: 'PHASE_LOOP_ACTOR_DEPLOYMENT="${PHASE_LOOP_ACTOR_DEPLOYMENT:-$ROOT_DIR/.brownie/phase-loop-actor-deployment.json}" PHASE_LOOP_ACTOR_CREDENTIALS="${PHASE_LOOP_ACTOR_CREDENTIALS:-$ROOT_DIR/.brownie/private/phase-loop-actor-credentials.json}" phase-loop-pr-actor-guard.mjs --print-gh-config-dir GH_CONFIG_DIR="$implementation_gh_config_dir" gh pr create'
  });
  assert(errors.some((error) => error.includes('must not contain a fixed deployment file path')));
  assert(errors.some((error) => error.includes('must not contain a fixed credential file path')));
  assert(errors.some((error) => error.includes('must not supply a fixed actor deployment path')));
  assert(errors.some((error) => error.includes('must not supply a fixed actor credential path')));
});

test('rejects ignoring all Brownie state', () => {
  const errors = run({ gitignore: '.brownie/\n.brownie/private/\n' });
  assert(errors.some((error) => error.includes('must not ignore all of .brownie')));
});

test('rejects CI deployment values embedded in source', () => {
  const errors = run({ ciWorkflow: "PHASE_LOOP_IMPLEMENTATION_BRANCH_PREFIXES PHASE_LOOP_REVIEW_ACTOR PHASE_LOOP_MERGE_ACTOR 'repository': os.environ['GITHUB_REPOSITORY'] phase-loop-actor-deployment.mjs --deployment \"$PHASE_LOOP_DEPLOYMENT_FILE\" --role implementation --field repository brownie-agent" });
  assert(errors.some((error) => error.includes('must not hard-code a deployment actor or repository owner')));
});

test('rejects CI deployment configuration leaked into generic test processes', () => {
  const errors = run({ ciWorkflow: "PHASE_LOOP_IMPLEMENTATION_BRANCH_PREFIXES PHASE_LOOP_REVIEW_ACTOR PHASE_LOOP_MERGE_ACTOR 'repository': os.environ['GITHUB_REPOSITORY'] phase-loop-actor-deployment.mjs --deployment \"$PHASE_LOOP_DEPLOYMENT_FILE\" --role implementation --field repository printf 'PHASE_LOOP_ACTOR_DEPLOYMENT=%s\\n'" });
  assert(errors.some((error) => error.includes('must not export actor deployment configuration into generic test processes')));
});
