#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultRepoRoot = path.resolve(__dirname, '..');

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolveConfiguredPath(repoRoot, requested) {
  const value = typeof requested === 'string' && requested.trim() ? requested.trim() : null;
  return value ? path.resolve(repoRoot, value) : null;
}

export function validateActorDeployment(deployment = {}) {
  const errors = [];
  const roles = deployment.roles && typeof deployment.roles === 'object' ? deployment.roles : {};
  if (deployment.schema_version !== 1) errors.push('actor deployment schema_version must be 1.');
  if (!/^[^/\s]+\/[^/\s]+$/u.test(String(deployment.repository ?? ''))) {
    errors.push('actor deployment repository must be an owner/name GitHub slug.');
  }
  for (const role of ['implementation', 'review', 'merge']) {
    const entry = roles[role] && typeof roles[role] === 'object' ? roles[role] : {};
    if (!String(entry.github_login ?? '').trim()) {
      errors.push(`actor deployment role ${role} must define github_login.`);
    }
  }
  const implementation = String(roles.implementation?.github_login ?? '').trim();
  const review = String(roles.review?.github_login ?? '').trim();
  if (deployment.constraints?.require_independent_review !== false && implementation && implementation === review) {
    errors.push('actor deployment implementation and review github_login values must differ.');
  }
  const prefixes = roles.implementation?.branch_prefixes;
  if (!Array.isArray(prefixes) || prefixes.length === 0 || prefixes.some((prefix) => !String(prefix).trim())) {
    errors.push('actor deployment implementation role must define non-empty branch_prefixes.');
  }
  return errors;
}

export function loadPhaseLoopActorDeployment(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const env = options.env ?? process.env;
  const requested = options.deploymentPath ?? env.PHASE_LOOP_ACTOR_DEPLOYMENT;
  const deploymentPath = resolveConfiguredPath(repoRoot, requested);
  if (!deploymentPath) {
    if (options.deployment) {
      const errors = validateActorDeployment(options.deployment);
      return { ok: errors.length === 0, deploymentPath: null, deployment: options.deployment, errors };
    }
    return {
      ok: false,
      deploymentPath: null,
      deployment: null,
      errors: ['actor deployment must be supplied explicitly with --deployment or PHASE_LOOP_ACTOR_DEPLOYMENT.']
    };
  }
  try {
    const deployment = options.deployment ?? readJson(deploymentPath);
    const errors = validateActorDeployment(deployment);
    return { ok: errors.length === 0, deploymentPath, deployment, errors };
  } catch (error) {
    return {
      ok: false,
      deploymentPath,
      deployment: null,
      errors: [`actor deployment is unreadable: ${error.message}`]
    };
  }
}

export function loadPhaseLoopActorCredentials(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  // Credentials are deployment-local control-plane state.  The checked-out
  // workspace can be an isolated target, so do not infer their location from
  // that target when the caller provides a control-plane credentials root.
  const credentialsRoot = path.resolve(options.credentialsRoot ?? repoRoot);
  const env = options.env ?? process.env;
  const privateRoot = path.resolve(credentialsRoot, '.brownie/private');
  const requested = options.credentialsPath ?? env.PHASE_LOOP_ACTOR_CREDENTIALS;
  const credentialsPath = resolveConfiguredPath(credentialsRoot, requested);
  if (!credentialsPath) {
    if (options.credentials) {
      if (options.credentials.schema_version !== 1 || !options.credentials.roles || typeof options.credentials.roles !== 'object') {
        return { ok: false, credentialsPath: null, credentials: null, errors: ['actor credential configuration must define schema_version 1 and roles.'] };
      }
      return { ok: true, credentialsPath: null, credentials: options.credentials, errors: [] };
    }
    return {
      ok: false,
      credentialsPath: null,
      credentials: null,
      errors: ['actor credentials must be supplied explicitly with --credentials or PHASE_LOOP_ACTOR_CREDENTIALS.']
    };
  }
  if (!inside(privateRoot, credentialsPath)) {
    return { ok: false, credentialsPath, credentials: null, errors: ['actor credential configuration must remain under .brownie/private/.'] };
  }
  try {
    const credentials = options.credentials ?? readJson(credentialsPath);
    if (credentials.schema_version !== 1 || !credentials.roles || typeof credentials.roles !== 'object') {
      return { ok: false, credentialsPath, credentials: null, errors: ['actor credential configuration must define schema_version 1 and roles.'] };
    }
    return { ok: true, credentialsPath, credentials, errors: [] };
  } catch (error) {
    return { ok: false, credentialsPath, credentials: null, errors: [`actor credential configuration is unreadable: ${error.message}`] };
  }
}

export function roleActor(deployment, role) {
  return String(deployment?.roles?.[role]?.github_login ?? '').trim();
}

export function roleBranchPrefixes(deployment, role) {
  const prefixes = deployment?.roles?.[role]?.branch_prefixes;
  return Array.isArray(prefixes) ? prefixes.map((prefix) => String(prefix).trim()).filter(Boolean) : [];
}

export function roleCredentialProfile(credentialsRoot, credentials, role) {
  const entry = credentials?.roles?.[role] && typeof credentials.roles[role] === 'object' ? credentials.roles[role] : {};
  const kind = String(entry.kind ?? '').trim();
  if (kind === 'host-default') {
    return { ok: true, profileId: 'host-default', githubConfigDir: null };
  }
  if (kind !== 'repository-private') {
    return { ok: false, code: 'github_profile_kind_invalid', message: `credential role ${role} must use host-default or repository-private.` };
  }
  const privateRoot = path.resolve(credentialsRoot, '.brownie/private');
  const requested = String(entry.github_config_dir ?? '').trim();
  if (!requested) {
    return { ok: false, code: 'github_profile_missing', message: `credential role ${role} must define github_config_dir.` };
  }
  const githubConfigDir = path.resolve(privateRoot, requested);
  if (!inside(privateRoot, githubConfigDir)) {
    return { ok: false, code: 'github_profile_outside_private_root', message: 'GitHub profile must remain under .brownie/private/.' };
  }
  try {
    if (!fs.statSync(githubConfigDir).isDirectory()) throw new Error('not a directory');
  } catch {
    return { ok: false, code: 'github_profile_missing', message: `GitHub profile for ${role} is unavailable at configured private path.` };
  }
  return { ok: true, profileId: `private-${role}`, githubConfigDir };
}

function parseArgs(argv) {
  const options = { repoRoot: defaultRepoRoot, deploymentPath: null, role: null, field: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo-root') options.repoRoot = path.resolve(argv[++index] ?? '');
    else if (arg === '--deployment') options.deploymentPath = argv[++index] ?? null;
    else if (arg === '--role') options.role = argv[++index] ?? null;
    else if (arg === '--field') options.field = argv[++index] ?? null;
    else throw new Error(`Unknown actor deployment argument: ${arg}`);
  }
  return options;
}

if (isMainModule()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const loaded = loadPhaseLoopActorDeployment(options);
    if (!loaded.ok) throw new Error(loaded.errors.join(' '));
    const actor = roleActor(loaded.deployment, options.role);
    if (!actor) throw new Error(`Unknown or unconfigured actor role: ${options.role ?? '(missing)'}.`);
    if (options.field === 'github-login') process.stdout.write(`${actor}\n`);
    else if (options.field === 'repository') process.stdout.write(`${loaded.deployment.repository}\n`);
    else if (options.field === 'branch-prefix') {
      const prefix = roleBranchPrefixes(loaded.deployment, options.role)[0];
      if (!prefix) throw new Error(`Configured role ${options.role} has no branch prefix.`);
      process.stdout.write(`${prefix}\n`);
    }
    else process.stdout.write(`${JSON.stringify({ deployment_path: path.relative(options.repoRoot, loaded.deploymentPath), role: options.role, github_login: actor }, null, 2)}\n`);
  } catch (error) {
    console.error(`Phase-loop actor deployment failed: ${error.message}`);
    process.exit(1);
  }
}
