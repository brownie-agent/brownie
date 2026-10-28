import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRepoRoot = path.resolve(__dirname, '..');
const defaultPolicyPath = 'docs/architecture/phase-loop-actor-separation-policy.json';

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function parseArgs(argv) {
  const options = {
    role: null,
    repoRoot: defaultRepoRoot,
    policyPath: defaultPolicyPath,
    printGhConfigDir: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    } else if (arg === '--role') {
      options.role = argv[++index] ?? null;
    } else if (arg === '--repo-root') {
      options.repoRoot = path.resolve(argv[++index] ?? '');
    } else if (arg === '--policy') {
      options.policyPath = argv[++index] ?? '';
    } else if (arg === '--print-gh-config-dir') {
      options.printGhConfigDir = true;
    } else {
      throw new Error(`Unknown phase-loop actor preflight argument: ${arg}`);
    }
  }
  return options;
}

function run(repoRoot, command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    passed: result.status === 0
  };
}

function readJson(repoRoot, relativePath, errors) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
  } catch (error) {
    errors.push(`${relativePath} must be readable JSON: ${error.message}`);
    return {};
  }
}

function parseRepository(remoteUrl) {
  if (typeof remoteUrl !== 'string' || remoteUrl.trim() === '') {
    return null;
  }
  const sshMatch = remoteUrl.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }
  try {
    const url = new URL(remoteUrl);
    if (url.hostname !== 'github.com') {
      return null;
    }
    const parts = url.pathname.replace(/^\/|\.git$/g, '').split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  } catch {
    return null;
  }
}

function commandStdout(repoRoot, command, args, env) {
  const result = run(repoRoot, command, args, env);
  return result.passed ? result.stdout.trim() : null;
}

function expectedActorForRole(policy, role) {
  if (role === 'implementation') {
    return policy.implementation_actor;
  }
  if (role === 'review' || role === 'merge') {
    return role === 'review' ? policy.review_actor : policy.merge_actor;
  }
  return null;
}

function branchPrefixesForRole(policy, role) {
  if (role === 'implementation') {
    return Array.isArray(policy.implementation_branch_prefixes) ? policy.implementation_branch_prefixes : [];
  }
  if (role === 'review' || role === 'merge') {
    return Array.isArray(policy.review_branch_prefixes) ? policy.review_branch_prefixes : [];
  }
  return [];
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function profileEnvironmentVariable(role) {
  if (role === 'implementation') return 'PHASE_LOOP_IMPLEMENTATION_GH_CONFIG_DIR';
  if (role === 'review') return 'PHASE_LOOP_REVIEW_GH_CONFIG_DIR';
  if (role === 'merge') return 'PHASE_LOOP_MERGE_GH_CONFIG_DIR';
  return null;
}

// Resolve an account profile without ever reading its token file.  Implementation
// credentials are repository-private and must not silently fall back to the
// owner/default gh account.  Review and merge may use an explicitly selected
// profile or the host default, but still have to pass the actor check below.
export function resolvePhaseLoopGitHubProfile(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const role = options.role;
  const actor = String(options.actor ?? '').trim();
  const env = options.env ?? process.env;
  const envName = profileEnvironmentVariable(role);
  const privateRoot = path.resolve(repoRoot, '.brownie/private');
  const implementationDefault = path.join(privateRoot, `gh-${actor}`);
  const requested = envName && typeof env[envName] === 'string' && env[envName].trim()
    ? env[envName].trim()
    : role === 'implementation'
      ? implementationDefault
      : (typeof env.GH_CONFIG_DIR === 'string' && env.GH_CONFIG_DIR.trim() ? env.GH_CONFIG_DIR.trim() : null);

  if (!requested) {
    return {
      ok: true,
      profile_id: 'host-default',
      github_config_dir: null,
      env: { ...env }
    };
  }

  const configDir = path.resolve(repoRoot, requested);
  if (role === 'implementation' && !isInside(privateRoot, configDir)) {
    return {
      ok: false,
      code: 'implementation_github_profile_outside_private_root',
      message: 'Implementation GitHub profile must remain under .brownie/private/.'
    };
  }
  try {
    if (!fs.statSync(configDir).isDirectory()) throw new Error('not a directory');
  } catch {
    return {
      ok: false,
      code: 'github_profile_missing',
      message: `GitHub profile for ${role} is unavailable; configure ${envName ?? 'GH_CONFIG_DIR'} before dispatch.`
    };
  }
  return {
    ok: true,
    profile_id: role === 'implementation' ? `private-${actor}` : 'explicit-or-host-default',
    github_config_dir: configDir,
    env: { ...env, GH_CONFIG_DIR: configDir }
  };
}

export function validatePhaseLoopActorPreflight(state, options = {}) {
  const errors = [];
  const role = options.role;
  const policy = options.policy ?? {};
  const expectedActor = expectedActorForRole(policy, role);
  const forbiddenActors = new Set(
    role === 'implementation'
      ? [policy.review_actor, policy.merge_actor].filter(Boolean)
      : [policy.implementation_actor].filter(Boolean)
  );

  if (!['implementation', 'review', 'merge'].includes(role)) {
    errors.push('role must be implementation, review, or merge.');
  }
  if (!expectedActor) {
    errors.push(`policy must define an expected actor for role ${role ?? '(missing)'}.`);
  }
  if (state.repository !== policy.repository) {
    errors.push(`remote origin must resolve to ${policy.repository}; got ${state.repository ?? '(unknown)'}.`);
  }
  if (!state.githubActor) {
    errors.push('authenticated GitHub actor must be available via gh api user.');
  } else if (state.githubActor !== expectedActor) {
    errors.push(`${role} role must use GitHub actor ${expectedActor}; got ${state.githubActor}.`);
  }
  if (state.githubActor && forbiddenActors.has(state.githubActor)) {
    errors.push(`${role} role must not run under forbidden actor ${state.githubActor}.`);
  }

  if (role === 'implementation') {
    if (!state.branch || state.branch === 'main') {
      errors.push('implementation role must run from a non-main implementation branch.');
    }
    const prefixes = branchPrefixesForRole(policy, role);
    if (state.branch && prefixes.length > 0 && !prefixes.some((prefix) => state.branch.startsWith(prefix))) {
      errors.push(`implementation branch ${state.branch} must start with one of: ${prefixes.join(', ')}.`);
    }
  }

  return errors;
}

export function collectPhaseLoopActorState(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const profile = options.profile ?? { ok: true, env: options.env ?? process.env, profile_id: 'unspecified', github_config_dir: null };
  const commandEnv = profile.env ?? options.env ?? process.env;
  const remoteUrl = commandStdout(repoRoot, 'git', ['config', '--get', 'remote.origin.url'], commandEnv);
  return {
    repository: parseRepository(remoteUrl),
    remoteUrlPresent: Boolean(remoteUrl),
    branch: commandStdout(repoRoot, 'git', ['branch', '--show-current'], commandEnv),
    head: commandStdout(repoRoot, 'git', ['rev-parse', 'HEAD'], commandEnv),
    githubActor: profile.ok === false ? null : commandStdout(repoRoot, 'gh', ['api', 'user', '--jq', '.login'], commandEnv),
    githubProfile: profile.profile_id ?? 'unspecified'
  };
}

export function runPhaseLoopActorPreflight(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const policyPath = options.policyPath ?? defaultPolicyPath;
  const errors = [];
  const policy = options.policy ?? readJson(repoRoot, policyPath, errors);
  const expectedActor = expectedActorForRole(policy, options.role);
  const profile = options.profile ?? resolvePhaseLoopGitHubProfile({
    repoRoot,
    role: options.role,
    actor: expectedActor,
    env: options.env
  });
  if (profile.ok === false) errors.push(profile.message);
  const state = options.state ?? collectPhaseLoopActorState({ repoRoot, profile, env: options.env });
  errors.push(...validatePhaseLoopActorPreflight(state, { role: options.role, policy }));
  return { errors, policyPath, role: options.role, state, profile };
}

if (isMainModule()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = runPhaseLoopActorPreflight(options);
    if (result.errors.length > 0) {
      console.error('Phase-loop actor preflight failed:');
      for (const error of result.errors) {
        console.error(`- ${error}`);
      }
      process.exit(1);
    }
    if (options.printGhConfigDir) {
      if (!result.profile.github_config_dir) {
        throw new Error('selected GitHub profile does not have an explicit GH_CONFIG_DIR.');
      }
      process.stdout.write(`${result.profile.github_config_dir}\n`);
      process.exit(0);
    }
    process.stdout.write(
      `${JSON.stringify({ policy: result.policyPath, role: result.role, actor: result.state.githubActor, profile: result.profile.profile_id, branch: result.state.branch, status: 'passed' }, null, 2)}\n`
    );
  } catch (error) {
    console.error(`Phase-loop actor preflight failed: ${error.message}`);
    process.exit(1);
  }
}
