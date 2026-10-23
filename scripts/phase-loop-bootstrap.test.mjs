import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const controllerPath = path.join(repoRoot, 'phase-loop.sh');

function baseEnvironment() {
  const environment = { ...process.env };
  delete environment.BROWNIE_BIN;
  delete environment.BROWNIE_RUNTIME_PATH;
  delete environment.BROWNIE_STORE_ROOT;
  delete environment.PHASE_LOOP_WORKSPACE_ROOT;
  delete environment.PHASE_LOOP_STATE_DIR;
  delete environment.PHASE_LOOP_TODO;
  delete environment.PHASE_LOOP_TODO_BREAKDOWN;
  return environment;
}

function runBootstrapCheck(environment) {
  return spawnSync('bash', [controllerPath, 'check-runtime-bootstrap'], {
    cwd: repoRoot,
    env: { ...baseEnvironment(), ...environment },
    encoding: 'utf8'
  });
}

function executableFixture(directory, name) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function externalControllerFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-external-control-plane-'));
  const controllerRoot = path.join(root, 'control-plane');
  const workspaceRoot = path.join(root, 'workspace');
  const stateRoot = path.join(root, 'isolated-state');
  fs.mkdirSync(controllerRoot);
  fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(stateRoot);
  const controller = path.join(controllerRoot, 'phase-loop.sh');
  fs.copyFileSync(controllerPath, controller);
  fs.chmodSync(controller, 0o755);
  return { root, controller, controllerRoot, workspaceRoot, stateRoot };
}

function initializeControllerRustFixture(controllerRoot) {
  const sourceDirectory = path.join(controllerRoot, 'crates', 'brownie-cli', 'src');
  fs.mkdirSync(sourceDirectory, { recursive: true });
  fs.writeFileSync(path.join(controllerRoot, 'Cargo.toml'), '[workspace]\nmembers = []\n');
  fs.writeFileSync(path.join(controllerRoot, 'Cargo.lock'), '# fixture\n');
  fs.writeFileSync(path.join(controllerRoot, 'crates', 'brownie-cli', 'Cargo.toml'), '[package]\nname = "brownie-cli"\nversion = "0.0.0"\n');
  const source = path.join(sourceDirectory, 'lib.rs');
  fs.writeFileSync(source, 'pub fn fixture() {}\n');
  spawnSync('git', ['init'], { cwd: controllerRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: controllerRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: controllerRoot, stdio: 'ignore' });
  spawnSync('git', ['add', 'Cargo.toml', 'Cargo.lock', 'crates'], { cwd: controllerRoot, stdio: 'ignore' });
  spawnSync('git', ['commit', '-m', 'fixture'], { cwd: controllerRoot, stdio: 'ignore' });
  return source;
}

test('loads env files only after ROOT_DIR is established', () => {
  const source = fs.readFileSync(controllerPath, 'utf8');
  assert.ok(source.indexOf('ROOT_DIR=') >= 0);
  assert.ok(source.indexOf('ROOT_DIR=') < source.indexOf('load_env()'));
  assert.match(source, /PHASE_LOOP_ENV_SOURCES="process environment"/u);
  const runOnce = source.indexOf('_run_brownie_once()');
  const bootstrapValidation = source.indexOf('validate_phase_loop_bootstrap "$run_stamp"', runOnce);
  assert.ok(bootstrapValidation >= 0);
  assert.ok(bootstrapValidation < source.indexOf('phase_loop_rebaseline_stale_claim "$run_stamp"', runOnce));
  assert.ok(bootstrapValidation < source.indexOf('todo_first_raw_pending_is_recorded_blocked', runOnce));
  assert.match(source, /export BROWNIE_STORE_ROOT="\$PHASE_LOOP_BROWNIE_STORE_ROOT"/u);
});

test('accepts explicit absolute executable paths', () => {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-bootstrap-absolute-'));
  try {
    const cli = executableFixture(fixtureDirectory, 'brownie');
    const runtime = executableFixture(fixtureDirectory, 'brownie-runtime');
    const stateDirectory = path.join(fixtureDirectory, 'state');
    const result = runBootstrapCheck({
      BROWNIE_BIN: cli,
      BROWNIE_RUNTIME_PATH: runtime,
      PHASE_LOOP_STATE_DIR: stateDirectory
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      code: 'phase_loop_bootstrap_ready'
    });
  } finally {
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('resolves default CLI from the selected workspace for an external control plane', () => {
  const fixture = externalControllerFixture();
  try {
    const workspaceBinDirectory = path.join(fixture.workspaceRoot, 'target', 'debug');
    fs.mkdirSync(workspaceBinDirectory, { recursive: true });
    executableFixture(workspaceBinDirectory, 'brownie');
    executableFixture(workspaceBinDirectory, 'brownie-runtime');
    const result = spawnSync('bash', [fixture.controller, 'check-runtime-bootstrap'], {
      cwd: fixture.controllerRoot,
      env: {
        ...baseEnvironment(),
        PHASE_LOOP_WORKSPACE_ROOT: fixture.workspaceRoot,
        PHASE_LOOP_STATE_DIR: fixture.stateRoot
      },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      code: 'phase_loop_bootstrap_ready'
    });
    assert.equal(fs.existsSync(path.join(fixture.controllerRoot, '.brownie')), false);
    assert.equal(fs.existsSync(path.join(fixture.stateRoot, 'logs')), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('prefers a paired external-controller CLI before admitting Runtime dispatch', () => {
  const fixture = externalControllerFixture();
  try {
    const controllerBinDirectory = path.join(fixture.controllerRoot, 'target', 'debug');
    fs.mkdirSync(controllerBinDirectory, { recursive: true });
    executableFixture(controllerBinDirectory, 'brownie');
    executableFixture(controllerBinDirectory, 'brownie-runtime');
    const result = spawnSync('bash', ['-x', fixture.controller, 'check-runtime-bootstrap'], {
      cwd: fixture.controllerRoot,
      env: {
        ...baseEnvironment(),
        PHASE_LOOP_WORKSPACE_ROOT: fixture.workspaceRoot,
        PHASE_LOOP_STATE_DIR: fixture.stateRoot
      },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      code: 'phase_loop_bootstrap_ready'
    });
    assert.match(result.stderr, new RegExp(`BROWNIE_BIN=${path.join(controllerBinDirectory, 'brownie').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`));
    assert.match(result.stderr, new RegExp(`BROWNIE_RUNTIME_PATH=${path.join(controllerBinDirectory, 'brownie-runtime').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('preserves an explicit Runtime override while selecting an external-controller CLI', () => {
  const fixture = externalControllerFixture();
  try {
    const controllerBinDirectory = path.join(fixture.controllerRoot, 'target', 'debug');
    const overrideDirectory = path.join(fixture.root, 'runtime-override');
    fs.mkdirSync(controllerBinDirectory, { recursive: true });
    fs.mkdirSync(overrideDirectory, { recursive: true });
    executableFixture(controllerBinDirectory, 'brownie');
    const runtime = executableFixture(overrideDirectory, 'brownie-runtime');
    const result = spawnSync('bash', ['-x', fixture.controller, 'check-runtime-bootstrap'], {
      cwd: fixture.controllerRoot,
      env: {
        ...baseEnvironment(),
        PHASE_LOOP_WORKSPACE_ROOT: fixture.workspaceRoot,
        PHASE_LOOP_STATE_DIR: fixture.stateRoot,
        BROWNIE_RUNTIME_PATH: runtime
      },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, new RegExp(`BROWNIE_BIN=${path.join(controllerBinDirectory, 'brownie').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`));
    assert.match(result.stderr, new RegExp(`configured_runtime=${runtime.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('derives the default CLI from a workspace selected by controller phase-loop.env', () => {
  const fixture = externalControllerFixture();
  try {
    const workspaceBinDirectory = path.join(fixture.workspaceRoot, 'target', 'debug');
    fs.mkdirSync(workspaceBinDirectory, { recursive: true });
    executableFixture(workspaceBinDirectory, 'brownie');
    executableFixture(workspaceBinDirectory, 'brownie-runtime');
    fs.writeFileSync(path.join(fixture.controllerRoot, 'phase-loop.env'), `PHASE_LOOP_WORKSPACE_ROOT=${fixture.workspaceRoot}\n`);
    const result = spawnSync('bash', [fixture.controller, 'check-runtime-bootstrap'], {
      cwd: fixture.controllerRoot,
      env: baseEnvironment(),
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      code: 'phase_loop_bootstrap_ready'
    });
    assert.equal(fs.existsSync(path.join(fixture.workspaceRoot, '.brownie', 'private', 'phase-loop', 'logs')), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('derives the default CLI from a workspace selected by state phase-loop.env', () => {
  const fixture = externalControllerFixture();
  try {
    const workspaceBinDirectory = path.join(fixture.workspaceRoot, 'target', 'debug');
    fs.mkdirSync(workspaceBinDirectory, { recursive: true });
    executableFixture(workspaceBinDirectory, 'brownie');
    executableFixture(workspaceBinDirectory, 'brownie-runtime');
    const initialStateDirectory = path.join(fixture.controllerRoot, '.brownie', 'private', 'phase-loop');
    fs.mkdirSync(initialStateDirectory, { recursive: true });
    fs.writeFileSync(path.join(initialStateDirectory, 'phase-loop.env'), `PHASE_LOOP_WORKSPACE_ROOT=${fixture.workspaceRoot}\n`);
    const result = spawnSync('bash', [fixture.controller, 'check-runtime-bootstrap'], {
      cwd: fixture.controllerRoot,
      env: baseEnvironment(),
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      code: 'phase_loop_bootstrap_ready'
    });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('fails closed when an external control plane has no workspace default CLI', () => {
  const fixture = externalControllerFixture();
  try {
    const result = spawnSync('bash', [fixture.controller, 'check-runtime-bootstrap'], {
      cwd: fixture.controllerRoot,
      env: {
        ...baseEnvironment(),
        PHASE_LOOP_WORKSPACE_ROOT: fixture.workspaceRoot,
        PHASE_LOOP_STATE_DIR: fixture.stateRoot
      },
      encoding: 'utf8'
    });
    assert.equal(result.status, 78, result.stderr);
    const diagnostic = JSON.parse(result.stdout);
    assert.equal(diagnostic.code, 'phase_loop_bootstrap_unavailable');
    const resolvedWorkspaceRoot = fs.realpathSync(fixture.workspaceRoot);
    assert.deepEqual(diagnostic.missing_binaries, [{
      configured_path: path.join(fixture.workspaceRoot, 'target', 'debug', 'brownie'),
      name: 'BROWNIE_BIN',
      reason: 'missing',
      resolved_path: path.join(resolvedWorkspaceRoot, 'target', 'debug', 'brownie')
    }]);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('keeps explicit binary overrides authoritative with an external control plane', () => {
  const fixture = externalControllerFixture();
  try {
    const overrideDirectory = path.join(fixture.root, 'overrides');
    fs.mkdirSync(overrideDirectory);
    const cli = executableFixture(overrideDirectory, 'brownie');
    const runtime = executableFixture(overrideDirectory, 'brownie-runtime');
    const result = spawnSync('bash', [fixture.controller, 'check-runtime-bootstrap'], {
      cwd: fixture.controllerRoot,
      env: {
        ...baseEnvironment(),
        PHASE_LOOP_WORKSPACE_ROOT: fixture.workspaceRoot,
        PHASE_LOOP_STATE_DIR: fixture.stateRoot,
        BROWNIE_BIN: cli,
        BROWNIE_RUNTIME_PATH: runtime
      },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      code: 'phase_loop_bootstrap_ready'
    });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('infers an adjacent runtime when BROWNIE_RUNTIME_PATH is not specified', () => {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-bootstrap-adjacent-'));
  try {
    const cliDirectory = path.join(fixtureDirectory, 'bin');
    fs.mkdirSync(cliDirectory);
    const cli = executableFixture(cliDirectory, 'brownie');
    executableFixture(cliDirectory, 'brownie-runtime');
    const result = runBootstrapCheck({
      BROWNIE_BIN: cli,
      PHASE_LOOP_STATE_DIR: path.join(fixtureDirectory, 'state'),
      PATH: process.env.PATH
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      code: 'phase_loop_bootstrap_ready'
    });
  } finally {
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('fails closed when a standard CLI has no adjacent or delegated runtime', () => {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-bootstrap-no-adjacent-'));
  try {
    const cli = executableFixture(fixtureDirectory, 'brownie');
    const result = runBootstrapCheck({
      BROWNIE_BIN: cli,
      PHASE_LOOP_STATE_DIR: path.join(fixtureDirectory, 'state'),
      PATH: process.env.PATH
    });
    assert.equal(result.status, 78, result.stderr);
    const diagnostic = JSON.parse(result.stdout);
    assert.equal(diagnostic.code, 'phase_loop_bootstrap_unavailable');
    assert.equal(diagnostic.runtime_path_source, 'cli-delegated');
    assert.equal(diagnostic.missing_binaries.length, 1);
    assert.equal(diagnostic.missing_binaries[0].name, 'BROWNIE_RUNTIME_PATH');
    assert.equal(diagnostic.missing_binaries[0].reason, 'missing_cli_runtime');
    assert.equal(path.basename(diagnostic.missing_binaries[0].configured_path), 'brownie-runtime');
    assert.equal(path.basename(diagnostic.missing_binaries[0].resolved_path), 'brownie-runtime');
    assert.ok(path.isAbsolute(diagnostic.missing_binaries[0].resolved_path));
  } finally {
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('defers runtime resolution for a self-contained custom CLI', () => {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-bootstrap-custom-cli-'));
  try {
    const cli = executableFixture(fixtureDirectory, 'brownie-test-fixture');
    const result = runBootstrapCheck({
      BROWNIE_BIN: cli,
      PHASE_LOOP_STATE_DIR: path.join(fixtureDirectory, 'state'),
      PATH: process.env.PATH
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      code: 'phase_loop_bootstrap_ready'
    });
  } finally {
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('fails closed with a deterministic diagnostic for a missing runtime', () => {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-bootstrap-missing-'));
  try {
    const cli = executableFixture(fixtureDirectory, 'brownie');
    const runtime = path.join(fixtureDirectory, 'missing-runtime');
    const result = runBootstrapCheck({
      BROWNIE_BIN: cli,
      BROWNIE_RUNTIME_PATH: runtime,
      PHASE_LOOP_STATE_DIR: path.join(fixtureDirectory, 'state')
    });
    assert.equal(result.status, 78, result.stderr);
    const diagnostic = JSON.parse(result.stdout);
    assert.equal(diagnostic.ok, false);
    assert.equal(diagnostic.code, 'phase_loop_bootstrap_unavailable');
    assert.equal(diagnostic.runtime_path_source, 'explicit');
    assert.equal(diagnostic.configuration_sources, 'process environment');
    assert.equal(diagnostic.missing_binaries.length, 1);
    assert.deepEqual(diagnostic.missing_binaries[0], {
      configured_path: runtime,
      name: 'BROWNIE_RUNTIME_PATH',
      reason: 'missing',
      resolved_path: diagnostic.missing_binaries[0].resolved_path
    });
    assert.equal(path.basename(diagnostic.missing_binaries[0].resolved_path), 'missing-runtime');
    assert.ok(path.isAbsolute(diagnostic.missing_binaries[0].resolved_path));
    assert.match(diagnostic.repair, /Do not source phase-loop\.env before phase-loop\.sh establishes ROOT_DIR/u);
  } finally {
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('rejects a path expanded while phase-loop.env was sourced before ROOT_DIR existed', () => {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-bootstrap-root-dir-'));
  const environmentFile = path.join(fixtureDirectory, 'phase-loop.env');
  try {
    fs.writeFileSync(environmentFile, 'BROWNIE_RUNTIME_PATH="${BROWNIE_RUNTIME_PATH:-\"$ROOT_DIR/target/debug/brownie-runtime\"}"\n');
    const stateDirectory = path.join(fixtureDirectory, 'state');
    const result = spawnSync('bash', ['-c', [
      'unset ROOT_DIR',
      '. "$1"',
      'export BROWNIE_RUNTIME_PATH',
      'export BROWNIE_BIN="$2"',
      'export PHASE_LOOP_STATE_DIR="$3"',
      'exec bash "$4" check-runtime-bootstrap'
    ].join('\n'), 'bootstrap-test', environmentFile, '/bin/sh', stateDirectory, controllerPath], {
      cwd: repoRoot,
      env: baseEnvironment(),
      encoding: 'utf8'
    });
    assert.equal(result.status, 78, result.stderr);
    const diagnostic = JSON.parse(result.stdout);
    assert.equal(diagnostic.code, 'phase_loop_bootstrap_unavailable');
    const runtimeFailure = diagnostic.missing_binaries.find((entry) => entry.name === 'BROWNIE_RUNTIME_PATH');
    assert.equal(diagnostic.runtime_path_source, 'explicit');
    assert.deepEqual(runtimeFailure, {
      configured_path: '/target/debug/brownie-runtime',
      name: 'BROWNIE_RUNTIME_PATH',
      reason: 'missing',
      resolved_path: '/target/debug/brownie-runtime'
    });
  } finally {
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('does not skip freshness checks for a default binary under a symlinked workspace', () => {
  const fixture = externalControllerFixture();
  try {
    const realWorkspace = path.join(fixture.root, 'real-workspace');
    const linkedWorkspace = path.join(fixture.root, 'linked-workspace');
    const sourceDirectory = path.join(realWorkspace, 'crates', 'brownie-cli', 'src');
    const binaryDirectory = path.join(realWorkspace, 'target', 'debug');
    fs.mkdirSync(sourceDirectory, { recursive: true });
    fs.mkdirSync(binaryDirectory, { recursive: true });
    fs.writeFileSync(path.join(realWorkspace, 'Cargo.toml'), '[workspace]\nmembers = []\n');
    fs.writeFileSync(path.join(realWorkspace, 'Cargo.lock'), '# fixture\n');
    fs.writeFileSync(path.join(realWorkspace, 'crates', 'brownie-cli', 'Cargo.toml'), '[package]\nname = "brownie-cli"\nversion = "0.0.0"\n');
    fs.writeFileSync(path.join(sourceDirectory, 'lib.rs'), 'pub fn fixture() {}\n');
    executableFixture(binaryDirectory, 'brownie');
    executableFixture(binaryDirectory, 'brownie-runtime');
    fs.symlinkSync(realWorkspace, linkedWorkspace, 'dir');
    spawnSync('git', ['init'], { cwd: realWorkspace, stdio: 'ignore' });
    spawnSync('git', ['config', 'user.name', 'test'], { cwd: realWorkspace, stdio: 'ignore' });
    spawnSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: realWorkspace, stdio: 'ignore' });
    spawnSync('git', ['add', '.'], { cwd: realWorkspace, stdio: 'ignore' });
    spawnSync('git', ['commit', '-m', 'fixture'], { cwd: realWorkspace, stdio: 'ignore' });
    const oldTime = new Date(Date.now() - 10_000);
    const newTime = new Date(Date.now() + 10_000);
    fs.utimesSync(path.join(binaryDirectory, 'brownie'), oldTime, oldTime);
    fs.utimesSync(path.join(binaryDirectory, 'brownie-runtime'), oldTime, oldTime);
    fs.utimesSync(path.join(sourceDirectory, 'lib.rs'), newTime, newTime);
    const result = spawnSync('bash', [fixture.controller, 'check-binary-freshness'], {
      cwd: fixture.controllerRoot,
      env: {
        ...baseEnvironment(),
        PHASE_LOOP_WORKSPACE_ROOT: linkedWorkspace,
        PHASE_LOOP_STATE_DIR: fixture.stateRoot
      },
      encoding: 'utf8'
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /binary freshness check failed/u);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('uses controller-baseline freshness for an external controller binary', () => {
  const fixture = externalControllerFixture();
  try {
    const workspaceSource = path.join(fixture.workspaceRoot, 'crates', 'brownie-cli', 'src');
    const controllerBinDirectory = path.join(fixture.controllerRoot, 'target', 'debug');
    fs.mkdirSync(workspaceSource, { recursive: true });
    fs.mkdirSync(controllerBinDirectory, { recursive: true });
    fs.writeFileSync(path.join(fixture.workspaceRoot, 'Cargo.lock'), '# fixture\n');
    fs.writeFileSync(path.join(fixture.workspaceRoot, 'crates', 'brownie-cli', 'Cargo.toml'), '[package]\nname = "brownie-cli"\nversion = "0.0.0"\n');
    const source = path.join(workspaceSource, 'lib.rs');
    fs.writeFileSync(source, 'pub fn fixture() {}\n');
    executableFixture(controllerBinDirectory, 'brownie');
    executableFixture(controllerBinDirectory, 'brownie-runtime');
    const controllerSource = initializeControllerRustFixture(fixture.controllerRoot);
    const oldTime = new Date(Date.now() - 10_000);
    const newTime = new Date(Date.now() + 10_000);
    fs.utimesSync(path.join(controllerBinDirectory, 'brownie'), oldTime, oldTime);
    fs.utimesSync(path.join(controllerBinDirectory, 'brownie-runtime'), oldTime, oldTime);
    for (const controllerInput of [
      path.join(fixture.controllerRoot, 'Cargo.toml'),
      path.join(fixture.controllerRoot, 'Cargo.lock'),
      path.join(fixture.controllerRoot, 'crates', 'brownie-cli', 'Cargo.toml'),
      controllerSource
    ]) {
      fs.utimesSync(controllerInput, oldTime, oldTime);
    }
    fs.utimesSync(source, newTime, newTime);
    const result = spawnSync('bash', [fixture.controller, 'check-binary-freshness'], {
      cwd: fixture.controllerRoot,
      env: {
        ...baseEnvironment(),
        PHASE_LOOP_WORKSPACE_ROOT: fixture.workspaceRoot,
        PHASE_LOOP_STATE_DIR: fixture.stateRoot
      },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('detects stale controller binaries against controller Rust sources', () => {
  const fixture = externalControllerFixture();
  try {
    const controllerBinDirectory = path.join(fixture.controllerRoot, 'target', 'debug');
    fs.mkdirSync(controllerBinDirectory, { recursive: true });
    executableFixture(controllerBinDirectory, 'brownie');
    executableFixture(controllerBinDirectory, 'brownie-runtime');
    const controllerSource = initializeControllerRustFixture(fixture.controllerRoot);
    const oldTime = new Date(Date.now() - 10_000);
    const newTime = new Date(Date.now() + 10_000);
    fs.utimesSync(path.join(controllerBinDirectory, 'brownie'), oldTime, oldTime);
    fs.utimesSync(path.join(controllerBinDirectory, 'brownie-runtime'), oldTime, oldTime);
    fs.utimesSync(controllerSource, newTime, newTime);

    const result = spawnSync('bash', [fixture.controller, 'check-binary-freshness'], {
      cwd: fixture.controllerRoot,
      env: {
        ...baseEnvironment(),
        PHASE_LOOP_WORKSPACE_ROOT: fixture.workspaceRoot,
        PHASE_LOOP_STATE_DIR: fixture.stateRoot
      },
      encoding: 'utf8'
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /brownie CLI binary is stale/u);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('detects a stale controller CLI when an indirect workspace crate changes', () => {
  const fixture = externalControllerFixture();
  try {
    const controllerBinDirectory = path.join(fixture.controllerRoot, 'target', 'debug');
    const dependencySourceDirectory = path.join(fixture.controllerRoot, 'crates', 'brownie-llm', 'src');
    fs.mkdirSync(controllerBinDirectory, { recursive: true });
    fs.mkdirSync(dependencySourceDirectory, { recursive: true });
    executableFixture(controllerBinDirectory, 'brownie');
    executableFixture(controllerBinDirectory, 'brownie-runtime');
    initializeControllerRustFixture(fixture.controllerRoot);
    fs.writeFileSync(path.join(fixture.controllerRoot, 'crates', 'brownie-llm', 'Cargo.toml'), '[package]\nname = "brownie-llm"\nversion = "0.0.0"\n');
    const dependencySource = path.join(dependencySourceDirectory, 'lib.rs');
    fs.writeFileSync(dependencySource, 'pub fn fixture() {}\n');
    spawnSync('git', ['add', 'crates/brownie-llm'], { cwd: fixture.controllerRoot, stdio: 'ignore' });
    spawnSync('git', ['commit', '-m', 'add indirect crate fixture'], { cwd: fixture.controllerRoot, stdio: 'ignore' });
    const oldTime = new Date(Date.now() - 10_000);
    const newTime = new Date(Date.now() + 10_000);
    fs.utimesSync(path.join(controllerBinDirectory, 'brownie'), oldTime, oldTime);
    fs.utimesSync(path.join(controllerBinDirectory, 'brownie-runtime'), oldTime, oldTime);
    fs.utimesSync(dependencySource, newTime, newTime);

    const result = spawnSync('bash', [fixture.controller, 'check-binary-freshness'], {
      cwd: fixture.controllerRoot,
      env: {
        ...baseEnvironment(),
        PHASE_LOOP_WORKSPACE_ROOT: fixture.workspaceRoot,
        PHASE_LOOP_STATE_DIR: fixture.stateRoot
      },
      encoding: 'utf8'
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /brownie CLI binary is stale/u);
    assert.match(result.stdout, /crates\/brownie-llm\/src\/lib\.rs/u);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
