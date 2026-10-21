#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_AUDIT_BYTES = 8192;

function absolute(value) { return path.resolve(value); }
function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
function realOrAbsolute(value) {
  let candidate = absolute(value);
  const suffix = [];
  while (!fs.existsSync(candidate) && candidate !== path.dirname(candidate)) {
    suffix.unshift(path.basename(candidate));
    candidate = path.dirname(candidate);
  }
  try { return path.join(fs.realpathSync(candidate), ...suffix); } catch { return absolute(value); }
}
function git(repo, args) {
  try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}
function gitExists(repo, args) {
  try { execFileSync('git', args, { cwd: repo, stdio: 'ignore' }); return true; } catch { return false; }
}
function sha256(value) { return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`; }
function argMap(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

export function resolveExecutionContext(options = {}) {
  const env = options.env ?? process.env;
  const workspaceRoot = absolute(options.workspaceRoot ?? env.PHASE_LOOP_WORKSPACE_ROOT ?? process.cwd());
  const controllerRoot = absolute(options.controllerRoot ?? env.PHASE_LOOP_CONTROL_ROOT ?? workspaceRoot);
  const stateRoot = absolute(options.stateRoot ?? env.PHASE_LOOP_STATE_DIR ?? path.join(workspaceRoot, '.brownie/private/phase-loop'));
  const cliRoot = absolute(options.cliRoot ?? env.BROWNIE_BIN ?? path.join(workspaceRoot, 'target/debug/brownie'));
  const runtimeRoot = absolute(options.runtimeRoot ?? env.BROWNIE_RUNTIME_PATH ?? path.join(workspaceRoot, 'target/debug/brownie-runtime'));
  const todoPath = absolute(options.todoPath ?? env.PHASE_LOOP_TODO ?? path.join(workspaceRoot, '.brownie/todo.md'));
  const baseCommit = options.baseCommit ?? env.PHASE_LOOP_BASE_COMMIT ?? (git(workspaceRoot, ['rev-parse', env.PHASE_LOOP_APPROVED_CONTROLLER_BASELINE ?? 'origin/main']) || git(workspaceRoot, ['rev-parse', 'HEAD']));
  const expectedActor = String(options.expectedActor ?? env.PHASE_LOOP_EXPECTED_ACTOR ?? 'brownie-agent').trim();
  return {
    schema_version: 1,
    workspace_root: workspaceRoot,
    controller_root: controllerRoot,
    state_root: stateRoot,
    cli_root: cliRoot,
    runtime_root: runtimeRoot,
    selected_todo: todoPath,
    git_base_commit: baseCommit,
    expected_actor: expectedActor,
    overrides: Object.keys(options).filter((key) => options[key] !== undefined && key !== 'env')
  };
}

export function validateExecutionContext(context, options = {}) {
  const errors = [];
  const workspace = realOrAbsolute(context.workspace_root);
  const controller = realOrAbsolute(context.controller_root);
  const state = realOrAbsolute(context.state_root);
  if (!fs.existsSync(context.workspace_root) || !fs.statSync(context.workspace_root).isDirectory()) {
    errors.push({ code: 'workspace_root_missing', path: context.workspace_root, message: 'Selected workspace root does not exist.' });
  }
  if (!fs.existsSync(context.controller_root) || !fs.statSync(context.controller_root).isDirectory()) {
    errors.push({ code: 'controller_root_stale', path: context.controller_root, message: 'Controller root is missing or stale; repair PHASE_LOOP_CONTROL_ROOT before dispatch.' });
  }
  if (!inside(workspace, state) && !options.allowExternalState) {
    errors.push({ code: 'state_controller_root_mismatch', path: context.state_root, message: 'State root must remain inside the selected workspace root; refusing cross-root state writes.' });
  }
  if (fs.existsSync(context.controller_root) && !inside(workspace, controller) && !options.allowExternalController) {
    const required = path.join(context.controller_root, 'scripts');
    if (!fs.existsSync(required) || !fs.statSync(required).isDirectory()) errors.push({ code: 'controller_root_stale', path: required, message: 'External controller root does not contain its controller scripts.' });
  }
  if (!inside(workspace, realOrAbsolute(context.selected_todo)) && !options.allowExternalTodo) {
    errors.push({ code: 'selected_todo_root_mismatch', path: context.selected_todo, message: 'Selected TODO must resolve inside the selected workspace root.' });
  }
  if (!/^[a-f0-9]{40}$/u.test(context.git_base_commit)) {
    errors.push({ code: 'git_base_commit_invalid', actual: context.git_base_commit, message: 'Git base commit must be a concrete 40-character commit SHA.' });
  } else if (!gitExists(context.workspace_root, ['cat-file', '-e', `${context.git_base_commit}^{commit}`])) {
    errors.push({ code: 'git_base_commit_missing', actual: context.git_base_commit, message: 'Git base commit is not present in the selected workspace repository.' });
  }
  if (context.expected_actor !== 'brownie-agent') {
    errors.push({ code: 'expected_actor_invalid', actual: context.expected_actor, message: 'Implementation dispatch must bind expected actor brownie-agent.' });
  }
  return errors;
}

export function auditExecutionContext(context, errors = []) {
  const payload = { schema_version: 1, recorded_at: new Date().toISOString(), ...context, errors };
  const text = JSON.stringify(payload, null, 2);
  return text.length > MAX_AUDIT_BYTES ? `${text.slice(0, MAX_AUDIT_BYTES - 32)}\n  "audit_truncated": true\n}\n` : `${text}\n`;
}

export function bindExecutionContext(options = {}) {
  const context = resolveExecutionContext(options);
  const errors = validateExecutionContext(context, options);
  const audit = auditExecutionContext(context, errors);
  if (options.auditPath && errors.length === 0) {
    fs.mkdirSync(path.dirname(options.auditPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(options.auditPath, audit, { mode: 0o600 });
  }
  return { valid: errors.length === 0, context, errors, audit };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = argMap(process.argv.slice(2));
  const result = bindExecutionContext({
    workspaceRoot: args.workspace,
    controllerRoot: args.controller,
    stateRoot: args.state,
    cliRoot: args.cli,
    runtimeRoot: args.runtime,
    todoPath: args.todo,
    baseCommit: args['base-commit'],
    expectedActor: args.actor,
    allowExternalController: args['allow-external-controller'] === true,
    allowExternalState: args['allow-external-state'] === true,
    allowExternalTodo: args['allow-external-todo'] === true,
    auditPath: args.audit
  });
  process.stdout.write(`${JSON.stringify({ ...result, audit: undefined }, null, 2)}\n`);
  if (!result.valid) process.exit(78);
}
