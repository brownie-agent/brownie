import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildSelfUpdateObjective, dispatchSelfUpdate, evaluateSelfUpdateEligibility } from './phase-loop-self-update.mjs';

const completedOutcome = JSON.stringify({
  ok: true,
  automation: {
    status: 'completed',
    controller_action: 'stop',
    completed: true,
    blocked: false,
    continuation_required: false,
    terminal_failure: false
  }
});

const realProviderStatus = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  result: {
    provider: 'OpenAiCompatible',
    enabled: true,
    strict: true,
    will_fallback_to_fake: false,
    llm_provider_access_allowed: true,
    task_run_network_allowed: true
  }
});

function runtimeStatusResult(status = realProviderStatus) {
  return { status: 0, stdout: status, stderr: '' };
}

function recoveryRequest(summary = 'Repair controller policy contradiction.') {
  return `${summary}\nAllowed paths: \`scripts/phase-loop-self-update.mjs\`.`;
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-self-update-'));
  fs.mkdirSync(path.join(repo, '.brownie/private/phase-loop'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'target/debug'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.brownie/todo.md'), '- [ ] E-test: Patch only `scripts/example.mjs`:\n  Route: implementation.\n');
  fs.writeFileSync(path.join(repo, '.brownie/todo-breakdown.md'), '# breakdown\n');
  fs.writeFileSync(path.join(repo, 'target/debug/brownie'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(repo, 'target/debug/brownie-runtime'), `#!/bin/sh\nprintf '%s\\n' '${realProviderStatus}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(repo, 'package.json'), '{}\n');
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, '.brownie/private/phase-loop/status.json'), JSON.stringify({ status: 'no_progress' }));
  return repo;
}

test('plans a self-update only while the phase loop is stopped and source tree is clean', () => {
  const repo = makeRepo();
  const eligibility = evaluateSelfUpdateEligibility({ repoRoot: repo, request: recoveryRequest() });
  assert.equal(eligibility.eligible, true, JSON.stringify(eligibility));
  const objective = buildSelfUpdateObjective({ request: recoveryRequest(), eligibility });
  assert.match(objective, /do not edit `\.brownie\/todo\.md`/u);
  assert.match(objective, /Repair controller policy contradiction/u);
  assert.match(objective, /Patch only `scripts\/phase-loop-self-update\.mjs`/u);
});

test('requires explicit workspace-relative targets for a self-update request', () => {
  const repo = makeRepo();
  const eligibility = evaluateSelfUpdateEligibility({ repoRoot: repo, request: 'Repair controller policy contradiction.' });
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reason, 'self_update_targets_missing');
});

test('refuses self-update when user source changes are present', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'user-change.txt'), 'preserve me\n');
  const eligibility = evaluateSelfUpdateEligibility({ repoRoot: repo, request: recoveryRequest() });
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reason, 'non_brownie_workspace_changes_present');
});

test('preserves nested Brownie runtime state without treating it as source drift', () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, 'crates/brownie-runtime'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'crates/brownie-runtime/Cargo.toml'), '[package]\nname = "fixture"\n');
  execFileSync('git', ['add', 'crates/brownie-runtime/Cargo.toml'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'track runtime fixture'], { cwd: repo, stdio: 'ignore' });
  fs.mkdirSync(path.join(repo, 'crates/brownie-runtime/.brownie'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'crates/brownie-runtime/.brownie/ledger.jsonl'), '{}\n');
  const eligibility = evaluateSelfUpdateEligibility({ repoRoot: repo, request: recoveryRequest() });
  assert.equal(eligibility.eligible, true, JSON.stringify(eligibility));
  assert.ok(eligibility.dirty_brownie_files.includes('crates/brownie-runtime/.brownie/'));
});

test('refuses self-update when a renamed source file is hidden by a .brownie path', () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/controller.mjs'), 'export const source = true;\n');
  execFileSync('git', ['add', 'src/controller.mjs'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'track controller'], { cwd: repo, stdio: 'ignore' });
  fs.renameSync(path.join(repo, 'src/controller.mjs'), path.join(repo, '.brownie/controller.mjs'));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  const eligibility = evaluateSelfUpdateEligibility({ repoRoot: repo, request: recoveryRequest() });
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reason, 'non_brownie_workspace_changes_present');
  assert.ok(eligibility.non_brownie_dirty_files.includes('src/controller.mjs'));
});

test('refuses self-update unless an enabled strict non-Fake provider is permitted', () => {
  const repo = makeRepo();
  const eligibility = evaluateSelfUpdateEligibility({
    repoRoot: repo,
    request: recoveryRequest(),
    run(command, args, options) {
      if (command === 'git') return spawnSync(command, args, options);
      if (command.endsWith('brownie-runtime')) {
        return runtimeStatusResult(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { provider: 'Fake', enabled: true, strict: false, will_fallback_to_fake: false, llm_provider_access_allowed: false, task_run_network_allowed: false } }));
      }
      throw new Error(`unexpected command: ${command}`);
    }
  });
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reason, 'implementation_provider_unavailable');
  assert.equal(eligibility.provider_reason, 'fake_provider_forbidden');
});

test('loads only private LLM configuration into the preflight and recovery child environment', () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, '.brownie/private'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.brownie/private/llm.env'), [
    'BROWNIE_LLM_PROVIDER=openai-compatible',
    'BROWNIE_LLM_API_KEY=test-only-key',
    'BROWNIE_LLM_ALLOW_PROVIDER_ACCESS=true',
    'BROWNIE_LLM_STRICT=true',
    'BROWNIE_CLI_RUN_MODE_ID=read-only'
  ].join('\n'));
  const invocations = [];
  const result = dispatchSelfUpdate({
    repoRoot: repo,
    request: recoveryRequest(),
    now: () => new Date('2026-10-09T00:00:00.000Z'),
    run(command, args, options) {
      if (command === 'git') return spawnSync(command, args, options);
      invocations.push({ command, options });
      if (command.endsWith('brownie-runtime')) return runtimeStatusResult();
      return { status: 0, stdout: completedOutcome, stderr: '' };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(invocations.length, 2);
  for (const invocation of invocations) {
    assert.equal(invocation.options.env.BROWNIE_LLM_PROVIDER, 'openai-compatible');
    assert.equal(invocation.options.env.BROWNIE_LLM_ALLOW_PROVIDER_ACCESS, 'true');
    assert.equal(invocation.options.env.BROWNIE_CLI_RUN_MODE_ID, 'implementer');
  }
  assert.doesNotMatch(JSON.stringify(result), /test-only-key/u);
});

test('dispatches Brownie through an immutable private objective and records the result', () => {
  const repo = makeRepo();
  let invocation;
  const result = dispatchSelfUpdate({
    repoRoot: repo,
    request: recoveryRequest(),
    now: () => new Date('2026-10-09T00:00:00.000Z'),
    run(command, args, options) {
      if (command === 'git') return spawnSync(command, args, options);
      if (command.endsWith('brownie-runtime')) return runtimeStatusResult();
      invocation = { command, args, options };
      return { status: 0, stdout: completedOutcome, stderr: '' };
    }
  });
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(result.ok, true);
  assert.deepEqual(invocation.args.slice(0, 3), ['--json', 'run', '--file']);
  assert.equal(invocation.options.env.BROWNIE_CLI_RUN_MODE_ID, 'implementer');
  assert.equal(fs.existsSync(path.join(repo, result.objective_path)), true);
  assert.equal(fs.existsSync(path.join(repo, result.result_path)), true);
});

test('treats exit-zero terminal and continuation outcomes as failed self-updates', () => {
  const repo = makeRepo();
  const terminalFailure = dispatchSelfUpdate({
    repoRoot: repo,
    request: recoveryRequest(),
    now: () => new Date('2026-10-09T00:00:00.000Z'),
    run(command, args, options) {
      if (command === 'git') return spawnSync(command, args, options);
      if (command.endsWith('brownie-runtime')) return runtimeStatusResult();
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, automation: { status: 'terminal_failure', controller_action: 'stop', completed: false, blocked: true, continuation_required: false, terminal_failure: true } }),
        stderr: ''
      };
    }
  });
  assert.equal(terminalFailure.ok, false);
  assert.equal(terminalFailure.retry.failed_attempts, 1);

  const continuation = dispatchSelfUpdate({
    repoRoot: repo,
    request: recoveryRequest('Repair a distinct controller policy contradiction.'),
    now: () => new Date('2026-10-09T00:00:00.000Z'),
    run(command, args, options) {
      if (command === 'git') return spawnSync(command, args, options);
      if (command.endsWith('brownie-runtime')) return runtimeStatusResult();
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, automation: { status: 'continuation_required', controller_action: 'resume', completed: false, blocked: false, continuation_required: true, terminal_failure: false } }),
        stderr: ''
      };
    }
  });
  assert.equal(continuation.ok, false);
  assert.equal(continuation.retry.failed_attempts, 1);
});

test('backs off failed recovery implementers and exhausts only the same failure fingerprint', () => {
  const repo = makeRepo();
  let attempts = 0;
  const run = (command, args, options) => {
    if (command === 'git') return spawnSync(command, args, options);
    if (command.endsWith('brownie-runtime')) return runtimeStatusResult();
    attempts += 1;
    return { status: 17, stdout: '', stderr: 'recoverer stopped' };
  };
  const request = recoveryRequest();
  const first = dispatchSelfUpdate({ repoRoot: repo, request, run, now: () => new Date('2026-10-09T00:00:00.000Z') });
  assert.equal(first.dispatched, true);
  assert.equal(first.retry.failed_attempts, 1);

  const backedOff = dispatchSelfUpdate({ repoRoot: repo, request, run, now: () => new Date('2026-10-09T00:00:30.000Z') });
  assert.equal(backedOff.dispatched, false);
  assert.equal(backedOff.retry.reason, 'self_update_retry_backoff_active');

  dispatchSelfUpdate({ repoRoot: repo, request, run, now: () => new Date('2026-10-09T00:01:00.000Z') });
  dispatchSelfUpdate({ repoRoot: repo, request, run, now: () => new Date('2026-10-09T00:03:00.000Z') });
  const exhausted = dispatchSelfUpdate({ repoRoot: repo, request, run, now: () => new Date('2026-10-09T00:10:00.000Z') });
  assert.equal(attempts, 3);
  assert.equal(exhausted.dispatched, false);
  assert.equal(exhausted.retry.reason, 'self_update_retry_budget_exhausted');

  const changedRequest = dispatchSelfUpdate({ repoRoot: repo, request: recoveryRequest('Repair a distinct controller policy contradiction.'), run, now: () => new Date('2026-10-09T00:10:00.000Z') });
  assert.equal(changedRequest.dispatched, true);
  assert.equal(attempts, 4);
});
