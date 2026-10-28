import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRepoRoot = path.resolve(__dirname, '..');
const defaultPolicyPath = 'docs/architecture/phase-loop-actor-separation-policy.json';

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function readText(repoRoot, relativePath, errors) {
  try {
    return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
  } catch (error) {
    errors.push(`${relativePath} must be readable: ${error.message}`);
    return '';
  }
}

function readJson(repoRoot, relativePath, errors) {
  try {
    return JSON.parse(readText(repoRoot, relativePath, errors));
  } catch (error) {
    errors.push(`${relativePath} must be readable JSON: ${error.message}`);
    return {};
  }
}

function requireValue(condition, errors, message) {
  if (!condition) {
    errors.push(message);
  }
}

export function runPhaseLoopActorSeparationGuard(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const policyPath = options.policyPath ?? defaultPolicyPath;
  const errors = [];
  const policy = options.policy ?? readJson(repoRoot, policyPath, errors);
  const packageJson = options.packageJson ?? readJson(repoRoot, 'package.json', errors);
  const vsixPackageJson = options.vsixPackageJson ?? readJson(repoRoot, 'extensions/brownie-vsix/package.json', errors);
  const gitignore = options.gitignore ?? readText(repoRoot, '.gitignore', errors);
  const createWindowsVm = options.createWindowsVm ?? readText(repoRoot, 'scripts/create-windows-release-vm.mjs', errors);
  const manageVmImages = options.manageVmImages ?? readText(repoRoot, 'scripts/manage-release-vm-images.mjs', errors);
  const bootstrapVms = options.bootstrapVms ?? readText(repoRoot, 'scripts/bootstrap-release-vms.mjs', errors);
  const phaseLoop = options.phaseLoop ?? readText(repoRoot, 'phase-loop.sh', errors);
  const actorPreflight = options.actorPreflight ?? readText(repoRoot, 'scripts/phase-loop-actor-preflight.mjs', errors);
  const prActorGuard = options.prActorGuard ?? readText(repoRoot, 'scripts/phase-loop-pr-actor-guard.mjs', errors);
  const actorDeployment = options.actorDeployment ?? readText(repoRoot, 'scripts/phase-loop-actor-deployment.mjs', errors);

  requireValue(policy.schema_version === 2, errors, `${policyPath} schema_version must be 2.`);
  requireValue(policy.policy_id === 'phase-loop-actor-separation-v2', errors, `${policyPath} policy_id must match.`);
  requireValue(policy.deployment?.default_path === '.brownie/phase-loop-actor-deployment.json', errors, `${policyPath} must name the deployment configuration path.`);
  requireValue(policy.deployment?.credential_default_path === '.brownie/private/phase-loop-actor-credentials.json', errors, `${policyPath} must name the private credential configuration path.`);
  const roles = policy.roles ?? {};
  const implementationResponsibility = roles.implementation ?? {};
  const reviewResponsibility = roles.review ?? {};
  const mergeResponsibility = roles.merge ?? {};
  for (const owner of [
    'select and claim one TODO',
    'decompose broad TODOs into implementation leaves when needed',
    'implement the selected TODO',
    'run bounded verification',
    'commit tracked workspace changes',
    'push the implementation branch',
    'create the pull request'
  ]) {
    requireValue(
      Array.isArray(implementationResponsibility.owns) && implementationResponsibility.owns.includes(owner),
      errors,
      `${policyPath} implementation role must own ${owner}.`
    );
  }
  requireValue(
    implementationResponsibility.must_stop_after === 'pull_request_created',
    errors,
    `${policyPath} implementation role must stop after pull_request_created.`
  );
  for (const forbidden of [
    'review its own pull request',
    'approve its own pull request',
    'merge pull requests',
    'relax branch protection'
  ]) {
    requireValue(
      Array.isArray(implementationResponsibility.must_not) && implementationResponsibility.must_not.includes(forbidden),
      errors,
      `${policyPath} implementation role must_not must include ${forbidden}.`
    );
  }
  for (const owner of [
    'review implementation pull requests',
    'request changes when CI, evidence, policy, or implementation is insufficient',
    'approve pull requests when the review is satisfied and the repository policy allows approval'
  ]) {
    requireValue(
      Array.isArray(reviewResponsibility.owns) && reviewResponsibility.owns.includes(owner),
      errors,
      `${policyPath} review role must own ${owner}.`
    );
  }
  requireValue(Array.isArray(reviewResponsibility.must_not) && reviewResponsibility.must_not.length > 0, errors, `${policyPath} review role must prohibit implementation work.`);
  requireValue(Array.isArray(mergeResponsibility.owns) && mergeResponsibility.owns.includes('merge pull requests after required checks and review policy are satisfied'), errors, `${policyPath} merge role must own guarded merge.`);
  requireValue(
    Array.isArray(policy.forbidden_success_claims) &&
      policy.forbidden_success_claims.some((claim) => /static review JSON/i.test(claim)),
    errors,
    `${policyPath} must forbid static review JSON as concrete GitHub review provenance.`
  );
  requireValue(
    Array.isArray(policy.forbidden_success_claims) &&
      policy.forbidden_success_claims.some((claim) => /configured implementation and review principals are the same/i.test(claim)),
    errors,
    `${policyPath} must forbid actor-collapse success claims.`
  );
  requireValue(
    Array.isArray(policy.requirements) &&
      policy.requirements.some((requirement) => requirement.includes('.brownie/private/')),
    errors,
    `${policyPath} requirements must place private local state under .brownie/private/.`
  );
  requireValue(
    Array.isArray(policy.requirements) &&
      policy.requirements.some((requirement) => /repository-private/u.test(requirement) && /host-default/u.test(requirement)),
    errors,
    `${policyPath} must require a repository-private implementation profile with no host-default fallback.`
  );

  requireValue(gitignore.includes('.brownie/private/'), errors, '.gitignore must ignore .brownie/private/.');
  requireValue(!/^\.brownie\/\s*$/m.test(gitignore), errors, '.gitignore must not ignore all of .brownie/.');
  for (const [owner, text] of [
    ['scripts/create-windows-release-vm.mjs', createWindowsVm],
    ['scripts/manage-release-vm-images.mjs', manageVmImages],
    ['scripts/bootstrap-release-vms.mjs', bootstrapVms]
  ]) {
    requireValue(text.includes('.brownie/private/'), errors, `${owner} must use .brownie/private/ for private local VM state.`);
    requireValue(!text.includes("'.brownie/vms") && !text.includes("'.brownie/vm-images"), errors, `${owner} must not use legacy .brownie/vms or .brownie/vm-images paths.`);
  }

  requireValue(packageJson.scripts?.['phase-loop:implementation-preflight'] === 'node scripts/phase-loop-actor-preflight.mjs --role implementation', errors, 'package.json must define phase-loop:implementation-preflight.');
  requireValue(packageJson.scripts?.['phase-loop:review-preflight'] === 'node scripts/phase-loop-actor-preflight.mjs --role review', errors, 'package.json must define phase-loop:review-preflight.');
  requireValue(packageJson.scripts?.['phase-loop:merge-preflight'] === 'node scripts/phase-loop-actor-preflight.mjs --role merge', errors, 'package.json must define phase-loop:merge-preflight.');
  requireValue(packageJson.scripts?.['guard:phase-loop-actor-separation'] === 'node scripts/guard-phase-loop-actor-separation.mjs', errors, 'package.json must define guard:phase-loop-actor-separation.');
  requireValue(packageJson.scripts?.['guard:phase-loop-actor-separation:test'] === 'node --test scripts/guard-phase-loop-actor-separation.test.mjs', errors, 'package.json must define guard:phase-loop-actor-separation:test.');
  requireValue(vsixPackageJson.scripts?.check?.includes('pnpm --workspace-root guard:phase-loop-actor-separation'), errors, 'VSIX check must invoke guard:phase-loop-actor-separation.');
  requireValue(vsixPackageJson.scripts?.check?.includes('pnpm --workspace-root guard:phase-loop-actor-separation:test'), errors, 'VSIX check must invoke guard:phase-loop-actor-separation:test.');
  requireValue(phaseLoop.includes('phase-loop-pr-actor-guard.mjs'), errors, 'phase-loop.sh must invoke the implementation PR actor guard before commit/push/PR creation.');
  requireValue(phaseLoop.includes('--print-gh-config-dir'), errors, 'phase-loop.sh must resolve a dedicated implementation GitHub profile before publish.');
  requireValue(phaseLoop.includes('GH_CONFIG_DIR="$implementation_gh_config_dir" gh pr create'), errors, 'phase-loop.sh must use the dedicated implementation GitHub profile for PR creation.');
  requireValue(actorPreflight.includes('loadPhaseLoopActorDeployment'), errors, 'actor preflight must load project actor deployment configuration.');
  requireValue(actorPreflight.includes('loadPhaseLoopActorCredentials'), errors, 'actor preflight must load local actor credential configuration.');
  requireValue(actorDeployment.includes('require_independent_review'), errors, 'actor deployment loader must enforce independent review when configured.');
  requireValue(!/expectedActor\s*=\s*['"][^'"]+['"]/u.test(prActorGuard), errors, 'phase-loop-pr-actor-guard.mjs must not default implementation PR creation to a fixed actor.');
  requireValue(prActorGuard.includes('validateImplementationPrActor'), errors, 'phase-loop-pr-actor-guard.mjs must validate the authenticated implementation PR actor.');

  return { errors, policyPath };
}

if (isMainModule()) {
  const result = runPhaseLoopActorSeparationGuard();
  if (result.errors.length > 0) {
    console.error('Phase-loop actor separation guard failed:');
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }
  console.log(`Phase-loop actor separation guard passed for ${result.policyPath}.`);
}
