import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const controllerPath = path.join(repoRoot, 'phase-loop.sh');

function executableFixture(directory, name) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function baseEnvironment() {
  const environment = { ...process.env };
  for (const name of ['BROWNIE_BIN', 'BROWNIE_RUNTIME_PATH', 'PHASE_LOOP_ENV_FILE', 'PHASE_LOOP_WORKSPACE_ROOT', 'PHASE_LOOP_STATE_DIR']) delete environment[name];
  return environment;
}

function runBootstrapCheck(environment) {
  return spawnSync('bash', [controllerPath, 'check-runtime-bootstrap'], {
    cwd: repoRoot,
    env: { ...baseEnvironment(), ...environment },
    encoding: 'utf8'
  });
}

test('does not probe repository-local environment files', () => {
  const source = fs.readFileSync(controllerPath, 'utf8');
  assert.match(source, /PHASE_LOOP_ENV_FILE/u);
  assert.doesNotMatch(source, /\$ROOT_DIR\/phase-loop\.env/u);
  assert.doesNotMatch(source, /\.test\/brownie-loop\.env/u);
  assert.doesNotMatch(source, /\.brownie\/private\/llm\.env/u);
});

test('requires both explicitly injected runtime binaries', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-bootstrap-missing-'));
  try {
    const result = runBootstrapCheck({ PHASE_LOOP_STATE_DIR: path.join(fixture, 'state') });
    assert.equal(result.status, 78, result.stderr);
    const diagnostic = JSON.parse(result.stdout);
    assert.equal(diagnostic.code, 'phase_loop_bootstrap_unavailable');
    assert.deepEqual(diagnostic.missing_binaries.map((entry) => [entry.name, entry.reason]), [
      ['BROWNIE_BIN', 'missing_configuration'],
      ['BROWNIE_RUNTIME_PATH', 'missing_configuration']
    ]);
    assert.match(diagnostic.repair, /never searches a workspace, controller, adjacent directory, or PATH/u);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('accepts explicit CLI and Runtime paths without a workspace default', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-bootstrap-explicit-'));
  try {
    const cli = executableFixture(fixture, 'custom-cli');
    const runtime = executableFixture(fixture, 'custom-runtime');
    const result = runBootstrapCheck({
      BROWNIE_BIN: cli,
      BROWNIE_RUNTIME_PATH: runtime,
      PHASE_LOOP_STATE_DIR: path.join(fixture, 'state')
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, code: 'phase_loop_bootstrap_ready' });
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('loads only an explicitly selected environment file', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-bootstrap-env-file-'));
  try {
    const cli = executableFixture(fixture, 'cli');
    const runtime = executableFixture(fixture, 'runtime');
    const environmentFile = path.join(fixture, 'deployment.env');
    fs.writeFileSync(environmentFile, [
      `BROWNIE_BIN=${JSON.stringify(cli)}`,
      `BROWNIE_RUNTIME_PATH=${JSON.stringify(runtime)}`,
      `PHASE_LOOP_STATE_DIR=${JSON.stringify(path.join(fixture, 'state'))}`
    ].join('\n'));
    const result = runBootstrapCheck({ PHASE_LOOP_ENV_FILE: environmentFile });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, code: 'phase_loop_bootstrap_ready' });
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('does not use a colocated phase-loop.env as a fallback', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-bootstrap-no-fallback-'));
  try {
    fs.copyFileSync(controllerPath, path.join(fixture, 'phase-loop.sh'));
    fs.chmodSync(path.join(fixture, 'phase-loop.sh'), 0o755);
    const cli = executableFixture(fixture, 'cli');
    const runtime = executableFixture(fixture, 'runtime');
    fs.writeFileSync(path.join(fixture, 'phase-loop.env'), `BROWNIE_BIN=${cli}\nBROWNIE_RUNTIME_PATH=${runtime}\n`);
    const result = spawnSync('bash', [path.join(fixture, 'phase-loop.sh'), 'check-runtime-bootstrap'], {
      cwd: fixture,
      env: { ...baseEnvironment(), PHASE_LOOP_STATE_DIR: path.join(fixture, 'state') },
      encoding: 'utf8'
    });
    assert.equal(result.status, 78, result.stderr);
    assert.equal(JSON.parse(result.stdout).missing_binaries[0].reason, 'missing_configuration');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('checks explicit binaries against an explicitly selected workspace', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-bootstrap-freshness-'));
  try {
    fs.mkdirSync(path.join(fixture, 'crates', 'fixture', 'src'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'Cargo.toml'), '[workspace]\nmembers = []\n');
    fs.writeFileSync(path.join(fixture, 'Cargo.lock'), '# fixture\n');
    fs.writeFileSync(path.join(fixture, 'crates', 'fixture', 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "0.0.0"\n');
    fs.writeFileSync(path.join(fixture, 'crates', 'fixture', 'src', 'lib.rs'), 'pub fn fixture() {}\n');
    spawnSync('git', ['init'], { cwd: fixture, stdio: 'ignore' });
    spawnSync('git', ['config', 'user.name', 'test'], { cwd: fixture, stdio: 'ignore' });
    spawnSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: fixture, stdio: 'ignore' });
    spawnSync('git', ['add', '.'], { cwd: fixture, stdio: 'ignore' });
    spawnSync('git', ['commit', '-m', 'fixture'], { cwd: fixture, stdio: 'ignore' });
    const binDir = path.join(fixture, 'bin');
    fs.mkdirSync(binDir);
    const cli = executableFixture(binDir, 'cli');
    const runtime = executableFixture(binDir, 'runtime');
    const result = spawnSync('bash', [controllerPath, 'check-binary-freshness'], {
      cwd: repoRoot,
      env: {
        ...baseEnvironment(),
        PHASE_LOOP_WORKSPACE_ROOT: fixture,
        PHASE_LOOP_STATE_DIR: path.join(fixture, 'state'),
        BROWNIE_BIN: cli,
        BROWNIE_RUNTIME_PATH: runtime,
        PHASE_LOOP_SKIP_BINARY_FRESHNESS_CHECK: '0'
      },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
