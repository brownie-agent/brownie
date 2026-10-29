import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { rebaselineStaleClaim, writeTerminalExecutionEvidence } from './phase-loop-claim-rebaseline.mjs';
import { recordTerminalFailureRecovery } from './phase-loop-task-ledger.mjs';

const repositoryRoot = path.resolve(new URL('..', import.meta.url).pathname);

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-claim-rebaseline-'));
  const stateDir = path.join(root, 'state');
  const claims = path.join(stateDir, 'todo-claims');
  const runs = path.join(stateDir, 'runs');
  fs.mkdirSync(claims, { recursive: true });
  fs.mkdirSync(runs, { recursive: true });
  const selected = '- [ ] E-23b-roundtrip-target-02: Create only `scripts/roundtrip.test.mjs`:\n  Route: implementation.\n  Source TODO: E-23b-roundtrip.\n  Depends on: <none>.\n  Completion condition: verify the downloaded package.\n  Verification: run `node --test scripts/roundtrip.test.mjs`.';
  const claimPath = path.join(claims, 'current.json');
  writeJson(claimPath, {
    schema_version: 1,
    claim_id: 'todo-g541-roundtrip-r3',
    status: 'in_progress',
    selected_todo: selected,
    queue_generation: 541,
    queue_fingerprint: 'old-queue',
    run_stamp: '20261019T071825Z',
    retry_cap: 0,
  });
  fs.writeFileSync(path.join(root, 'todo.md'), `${selected}\n`);
  writeJson(path.join(stateDir, 'status.json'), { status: 'no_progress', run_id: 'old-run', supervisor_pid: 86793 });
  writeJson(path.join(stateDir, 'progress-state.json'), {
    classification: 'terminal_failure',
    run_stamp: '20261019T071825Z',
    progress_projection: {
      claim_id: 'todo-g541-roundtrip-r3',
      selected_todo: selected,
      stop_class: 'terminal_failure',
      stop_reason: 'terminal_task_failed',
      cli_status: 'no_eligible_task',
    },
  });
  writeJson(path.join(claims, 'todo-queue-state.json'), { generation: 541, fingerprint: 'new-queue' });
  return { root, stateDir, claims, runs, selected, claimPath };
}

test('isolates stale running r3 claim and records source/queue rebaseline before fresh delegation', () => {
  const f = fixture();
  const result = rebaselineStaleClaim({
    repo: repositoryRoot,
    stateDir: f.stateDir,
    claimPath: f.claimPath,
    statusPath: path.join(f.stateDir, 'status.json'),
    progressPath: path.join(f.stateDir, 'progress-state.json'),
    queuePath: path.join(f.claims, 'todo-queue-state.json'),
    ledgerPath: path.join(f.stateDir, 'task-ledger.jsonl'),
    runsDir: f.runs,
    todoPath: path.join(f.root, 'todo.md'),
    runStamp: '20261020T090000Z',
    baselineRef: 'origin/main',
  });
  assert.equal(result.rebaselined, true, JSON.stringify(result));
  assert.equal(fs.existsSync(f.claimPath), false);
  const audit = JSON.parse(fs.readFileSync(result.audit_path, 'utf8'));
  const archived = JSON.parse(fs.readFileSync(result.stale_claim_path, 'utf8'));
  assert.equal(audit.source.baseline_ref, 'origin/main');
  assert.match(audit.source.baseline_commit, /^[0-9a-f]{40}$/u);
  assert.equal(audit.queue.fingerprint, 'new-queue');
  assert.equal(audit.source_claim.claim_id, 'todo-g541-roundtrip-r3');
  assert.equal(audit.recovery_state, 'redelegatable');
  assert.equal(audit.retry_policy, 'do_not_inherit_source_claim_retry_cap_or_terminal_state');
  assert.equal(archived.retry_eligible, true);
  assert.equal(archived.recovery_state, 'redelegatable');
  assert.equal(fs.readFileSync(path.join(f.root, 'todo.md'), 'utf8'), `${f.selected}\n`);
});

test('preserves an ownerless same-queue continuation claim for resume despite historical terminal ledger evidence', () => {
  const f = fixture();
  writeJson(path.join(f.stateDir, 'status.json'), {
    status: 'recovered_stale_running',
    continuation_required: true,
    controller_action: 'resume',
  });
  writeJson(path.join(f.stateDir, 'progress-state.json'), {
    classification: 'continuation_required',
    continuation_required: true,
    progress_projection: {
      claim_id: 'todo-g541-roundtrip-r3',
      controller_action: 'resume',
      stop_class: 'continuation_required',
    },
  });
  writeJson(path.join(f.claims, 'todo-queue-state.json'), { generation: 541, fingerprint: 'old-queue' });
  fs.writeFileSync(path.join(f.stateDir, 'task-ledger.jsonl'), `${JSON.stringify({
    claim_id: 'todo-g541-roundtrip-r3', to_state: 'completed',
  })}\n`);
  const result = rebaselineStaleClaim({
    repo: repositoryRoot,
    stateDir: f.stateDir,
    claimPath: f.claimPath,
    statusPath: path.join(f.stateDir, 'status.json'),
    progressPath: path.join(f.stateDir, 'progress-state.json'),
    queuePath: path.join(f.claims, 'todo-queue-state.json'),
    ledgerPath: path.join(f.stateDir, 'task-ledger.jsonl'),
    runsDir: f.runs,
    todoPath: path.join(f.root, 'todo.md'),
    runStamp: '20261020T090000Z',
    baselineRef: 'origin/main',
  });
  assert.equal(result.rebaselined, false, JSON.stringify(result));
  assert.equal(result.reason, 'continuation_claim_preserved_for_resume');
  assert.equal(fs.existsSync(f.claimPath), true);
});

test('isolates a stale pre-claim materialized-scope boundary claim even when its queue is unchanged', () => {
  const f = fixture();
  writeJson(path.join(f.stateDir, 'status.json'), {
    status: 'blocked',
    detail: 'Phase-loop preflight failed before continuing; code=contract_unsatisfiable_dirty_scope.',
  });
  writeJson(path.join(f.stateDir, 'progress-state.json'), {
    classification: 'progress',
    progress_projection: {
      claim_id: 'todo-g541-roundtrip-r3',
      applied: 'True',
      controller_action: 'resume',
      stop_class: 'continuation_required',
      selected_todo_first_line_still_pending_after_todo_md_apply: false,
    },
  });
  writeJson(path.join(f.claims, 'todo-queue-state.json'), { generation: 541, fingerprint: 'old-queue' });
  const result = rebaselineStaleClaim({
    repo: repositoryRoot,
    stateDir: f.stateDir,
    claimPath: f.claimPath,
    statusPath: path.join(f.stateDir, 'status.json'),
    progressPath: path.join(f.stateDir, 'progress-state.json'),
    queuePath: path.join(f.claims, 'todo-queue-state.json'),
    ledgerPath: path.join(f.stateDir, 'task-ledger.jsonl'),
    runsDir: f.runs,
    todoPath: path.join(f.root, 'todo.md'),
    runStamp: '20261020T090000Z',
    baselineRef: 'origin/main',
  });
  assert.equal(result.rebaselined, true, JSON.stringify(result));
  const audit = JSON.parse(fs.readFileSync(result.audit_path, 'utf8'));
  assert.equal(audit.reasons.queue_mismatch, false);
  assert.equal(audit.reasons.stale_materialized_scope_boundary, true);
  assert.equal(audit.reasons.stale_applied_projection, true);
  assert.equal(fs.existsSync(f.claimPath), false);
});

test('requires current-run task execution evidence before terminal failure recording', () => {
  const f = fixture();
  const snapshot = path.join(f.runs, 'claim.before-runtime.json');
  const evidence = path.join(f.runs, 'run.execution-evidence.json');
  writeJson(snapshot, { ok: true, claim: { claim_id: 'claim-current', selected_todo: f.selected } });
  const stdout = path.join(f.runs, 'run.stdout.log');
  writeJson(stdout, {
    run: {
      run_id: 'runtime-current',
      phase_loop_claim_id: 'claim-current',
      status: 'no_eligible_task',
      stop_class: 'terminal_failure',
      stop_reason: 'terminal_task_failed',
      automation: { terminal_failure: true },
    },
  });
  const missing = writeTerminalExecutionEvidence({ stdoutPath: stdout, claimSnapshotPath: snapshot, outputPath: evidence, runStamp: 'run-current' });
  assert.equal(missing.task_execution_confirmed, false);
  writeJson(stdout, {
    run: {
      run_id: 'runtime-current',
      phase_loop_claim_id: 'claim-current',
      status: 'task_executed',
      stop_class: 'terminal_failure',
      stop_reason: 'terminal_task_failed',
      terminal_completion_final_state: 'Failed',
      terminal_completion_task_status: 'Failed',
      completion_closure_terminal_task_count: 1,
      automation: { terminal_failure: true },
    },
  });
  const confirmed = writeTerminalExecutionEvidence({ stdoutPath: stdout, claimSnapshotPath: snapshot, outputPath: evidence, runStamp: 'run-current' });
  assert.equal(confirmed.task_execution_confirmed, true);
  const selectedHash = crypto.createHash('sha256').update(f.selected).digest('hex');
  const durable = recordTerminalFailureRecovery(f.root, {
    selected_todo: f.selected,
    claim_id: 'claim-current',
    run_id: 'runtime-current',
    retry_cap: 1,
    controller_fingerprint: 'controller-current',
    execution_evidence: { ...confirmed, selected_todo_sha256: selectedHash },
  });
  assert.equal(durable.ok, true, durable);
  const ledger = fs.readFileSync(path.join(f.root, '.brownie/private/phase-loop/task-ledger.jsonl'), 'utf8');
  assert.match(ledger, /phase_loop_terminal_failure_execution_evidence/u);
  const rejected = recordTerminalFailureRecovery(f.root, {
    selected_todo: f.selected,
    claim_id: 'claim-current',
    run_id: 'runtime-current',
    retry_cap: 0,
    controller_fingerprint: 'controller-current',
    execution_evidence: { ...confirmed, selected_todo_sha256: selectedHash },
  });
  assert.equal(rejected.code, 'terminal_failure_retry_cap_zero_requires_redelegation');
});

test('preserves admitted execution for terminal no-eligible closure without workspace change', () => {
  const f = fixture();
  const snapshot = path.join(f.runs, 'claim.before-runtime.json');
  const evidence = path.join(f.runs, 'run.execution-evidence.json');
  writeJson(snapshot, { ok: true, claim: { claim_id: 'claim-current', selected_todo: f.selected } });
  const stdout = path.join(f.runs, 'run.stdout.log');
  writeJson(stdout, {
    run: {
      run_id: 'runtime-current',
      phase_loop_claim_id: 'claim-current',
      status: 'no_eligible_task',
      stop_class: 'terminal_failure',
      stop_reason: 'terminal_task_failed',
      executed_count: 1,
      task_execution_confirmed: true,
    },
  });
  const result = writeTerminalExecutionEvidence({
    stdoutPath: stdout,
    claimSnapshotPath: snapshot,
    outputPath: evidence,
    runStamp: 'run-current',
    workspaceBefore: 'unchanged-workspace',
    workspaceAfter: 'unchanged-workspace',
  });
  assert.equal(result.task_execution_confirmed, true);
  assert.equal(result.signals.task_execution_confirmed, true);
  assert.equal(result.signals.payload_status, 'no_eligible_task');
  const durable = recordTerminalFailureRecovery(f.root, {
    selected_todo: f.selected,
    claim_id: 'claim-current',
    run_id: 'runtime-current',
    retry_cap: 1,
    controller_fingerprint: 'controller-current',
    execution_evidence: {
      ...result,
      selected_todo_sha256: crypto.createHash('sha256').update(f.selected).digest('hex'),
    },
  });
  assert.equal(durable.ok, true, durable);
});

test('rejects a no-eligible admission flag when the runtime reports zero executed tasks', () => {
  const f = fixture();
  const snapshot = path.join(f.runs, 'claim-snapshot.json');
  const evidence = path.join(f.runs, 'execution-evidence.json');
  writeJson(snapshot, { claim: JSON.parse(fs.readFileSync(f.claimPath, 'utf8')) });
  const stdout = path.join(f.runs, 'run.stdout.log');
  writeJson(stdout, {
    run: {
      run_id: 'runtime-current', phase_loop_claim_id: 'claim-current',
      status: 'no_eligible_task', stop_class: 'terminal_failure',
      stop_reason: 'terminal_task_failed', executed_count: 0,
      task_execution_confirmed: true,
    },
  });
  const result = writeTerminalExecutionEvidence({ stdoutPath: stdout, claimSnapshotPath: snapshot, outputPath: evidence, runStamp: 'run-current' });
  assert.equal(result.task_execution_confirmed, false);
  assert.equal(result.signals.reported_executed_count, 0);
});

test('rejects a no-eligible admission flag when the runtime omits executed task count', () => {
  const f = fixture();
  const snapshot = path.join(f.runs, 'claim-snapshot.json');
  const evidence = path.join(f.runs, 'execution-evidence.json');
  writeJson(snapshot, { claim: JSON.parse(fs.readFileSync(f.claimPath, 'utf8')) });
  const stdout = path.join(f.runs, 'run.stdout.log');
  writeJson(stdout, {
    run: {
      run_id: 'runtime-current', phase_loop_claim_id: 'claim-current',
      status: 'no_eligible_task', stop_class: 'terminal_failure',
      stop_reason: 'terminal_task_failed', task_execution_confirmed: true,
      task_execution: { started: true },
    },
  });
  const result = writeTerminalExecutionEvidence({ stdoutPath: stdout, claimSnapshotPath: snapshot, outputPath: evidence, runStamp: 'run-current' });
  assert.equal(result.task_execution_confirmed, false);
  assert.equal(result.signals.reported_executed_count, null);
});

test('keeps genuine unexecuted terminal no-eligible results fail-closed', () => {
  const f = fixture();
  const snapshot = path.join(f.runs, 'claim.before-runtime.json');
  const evidence = path.join(f.runs, 'run.execution-evidence.json');
  writeJson(snapshot, { ok: true, claim: { claim_id: 'claim-current', selected_todo: f.selected } });
  const stdout = path.join(f.runs, 'run.stdout.log');
  writeJson(stdout, {
    run: {
      run_id: 'runtime-current',
      phase_loop_claim_id: 'claim-current',
      status: 'no_eligible_task',
      stop_class: 'terminal_failure',
      stop_reason: 'terminal_task_failed',
      executed_count: 0,
    },
  });
  const result = writeTerminalExecutionEvidence({ stdoutPath: stdout, claimSnapshotPath: snapshot, outputPath: evidence, runStamp: 'run-current' });
  assert.equal(result.task_execution_confirmed, false);
});
