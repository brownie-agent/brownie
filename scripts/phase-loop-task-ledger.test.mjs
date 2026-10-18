import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendTaskTransition, readTaskLedger, recordTrajectory, replanTaskWithChildren, taskAttemptId, taskIsExecutable, taskProjection, validateTaskLedger } from './phase-loop-task-ledger.mjs';

test('task ledger enforces a terminal state machine', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-task-ledger-'));
  assert.equal(appendTaskTransition(repo, { task_id: 'T-1', to_state: 'queued' }).ok, true);
  assert.equal(appendTaskTransition(repo, { task_id: 'T-1', to_state: 'claimed' }).ok, true);
  assert.equal(appendTaskTransition(repo, { task_id: 'T-1', to_state: 'running' }).ok, true);
  assert.equal(appendTaskTransition(repo, { task_id: 'T-1', to_state: 'blocked', reason: 'runtime_terminal_failure' }).ok, true);
  assert.equal(appendTaskTransition(repo, { task_id: 'T-1', to_state: 'running' }).code, 'terminal_task_cannot_transition');
  assert.equal(taskProjection(readTaskLedger(repo)).get('T-1').to_state, 'blocked');
});

test('replans require a cause and replacement children', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-task-ledger-'));
  appendTaskTransition(repo, { task_id: 'T-2', to_state: 'queued' });
  assert.equal(appendTaskTransition(repo, { task_id: 'T-2', to_state: 'replanned', reason: 'over_broad', replaces: [] }).code, 'replan_requires_reason_and_children');
  assert.equal(appendTaskTransition(repo, { task_id: 'T-2', to_state: 'replanned', reason: 'over_broad', replaces: ['T-2a'] }).ok, true);
});

test('execution gate rejects underspecified and blocker tasks', () => {
  assert.deepEqual(taskIsExecutable({ task_id: 'T-3', route: 'implementation', patch_targets: ['x'], verification_commands: ['node --test'] }), { ok: true, missing: [] });
  assert.equal(taskIsExecutable({ task_id: 'T-4', route: 'blocker', patch_targets: [], verification_commands: [] }).ok, false);
});

test('replan atomically records a terminal parent and executable queued children', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-task-ledger-'));
  appendTaskTransition(repo, { task_id: 'T-5', to_state: 'queued' });
  const result = replanTaskWithChildren(repo, {
    task_id: 'T-5', reason: 'over_broad',
    children: [
      { task_id: 'T-5a', route: 'implementation', patch_targets: ['a.rs'], verification_commands: ['cargo test'] },
      { task_id: 'T-5b', route: 'documentation', patch_targets: ['docs/a.md'], verification_commands: ['pnpm check'] }
    ]
  });
  assert.equal(result.ok, true);
  const events = readTaskLedger(repo);
  assert.equal(validateTaskLedger(events).ok, true);
  const projection = taskProjection(events);
  assert.equal(projection.get('T-5').to_state, 'replanned');
  assert.equal(projection.get('T-5a').to_state, 'queued');
  assert.equal(projection.get('T-5b').parent_task_id, 'T-5');
});

test('replan leaves the ledger unchanged when a child fails the execution gate', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-task-ledger-'));
  appendTaskTransition(repo, { task_id: 'T-6', to_state: 'queued' });
  const before = readTaskLedger(repo);
  const result = replanTaskWithChildren(repo, {
    task_id: 'T-6', reason: 'over_broad', children: [{ task_id: 'T-6a', route: 'blocker', patch_targets: [], verification_commands: [] }]
  });
  assert.equal(result.code, 'replan_child_not_executable');
  assert.deepEqual(readTaskLedger(repo), before);
});

test('ignores an incomplete replan journal instead of exposing a parent-only replacement', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-task-ledger-'));
  const ledger = path.join(repo, '.brownie/private/phase-loop/task-ledger.jsonl');
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.writeFileSync(ledger, '{"kind":"replan_transaction","events":[{"task_id":"T-7","to_state":"replanned"}]}\n');
  assert.deepEqual(readTaskLedger(repo), []);
});

test('records repeated claims as separate immutable task attempts', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-task-ledger-'));
  const todo = path.join(repo, '.brownie', 'todo.md');
  fs.mkdirSync(path.dirname(todo), { recursive: true });
  fs.writeFileSync(todo, '- [ ] T-8: retryable bounded task\n');
  const script = path.join(process.cwd(), 'scripts', 'phase-loop-task-ledger.mjs');
  for (const claimId of ['claim-one', 'claim-two']) {
    const claim = path.join(repo, `${claimId}.json`);
    fs.writeFileSync(claim, JSON.stringify({ claim_id: claimId, selected_todo: '- [ ] T-8: retryable bounded task' }));
    execFileSync(process.execPath, [script, 'record-trajectory', '--repo', repo, '--claim', claim, '--todo', todo, '--type', 'todo.claimed', '--run', claimId], { stdio: 'pipe' });
  }
  const projection = taskProjection(readTaskLedger(repo));
  assert.equal(projection.get(taskAttemptId('T-8', 'claim-one')).to_state, 'claimed');
  assert.equal(projection.get(taskAttemptId('T-8', 'claim-two')).to_state, 'claimed');
});

test('keeps duplicate routed trajectory events nonfatal while preserving the valid task state', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-task-ledger-'));
  const claim = path.join(repo, 'claim.json');
  fs.writeFileSync(claim, JSON.stringify({ claim_id: 'claim-duplicate-route', selected_todo: '- [ ] T-duplicate-route: bounded task' }));
  assert.equal(recordTrajectory(repo, { claimPath: claim, type: 'todo.claimed', runId: 'run-duplicate' }).ok, true);
  assert.equal(recordTrajectory(repo, { claimPath: claim, type: 'workflow.routed', runId: 'run-duplicate' }).ok, true);
  const duplicate = recordTrajectory(repo, { claimPath: claim, type: 'workflow.routed', runId: 'run-duplicate' });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.code, 'ledger_transition_rejected');
  assert.equal(taskProjection(readTaskLedger(repo)).get(taskAttemptId('T-duplicate-route', 'claim-duplicate-route')).to_state, 'running');
});

test('records an absent claim as an explicit empty task-ledger trajectory without recreating a claim', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-task-ledger-'));
  const result = recordTrajectory(repo, {
    claimPath: path.join(repo, 'missing-claim.json'),
    todoPath: path.join(repo, '.brownie/todo.md'),
    type: 'todo.blocked',
    runId: 'run-absent',
    at: '2026-10-18T00:00:00.000Z'
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'unclaimed_empty');
  assert.equal(fs.existsSync(path.join(repo, 'missing-claim.json')), false);
  const raw = fs.readFileSync(path.join(repo, '.brownie/private/phase-loop/task-ledger.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(raw[0], {
    schema_version: 1,
    kind: 'unclaimed_trajectory',
    event_id: raw[0].event_id,
    task_id: null,
    claim_id: null,
    trajectory_type: 'todo.blocked',
    run_id: 'run-absent',
    claim_path: path.join(repo, 'missing-claim.json'),
    claim_state: 'absent',
    error_code: 'claim_absent',
    error_message: raw[0].error_message,
    at: '2026-10-18T00:00:00.000Z'
  });
  assert.deepEqual(readTaskLedger(repo), []);
  assert.equal(appendTaskTransition(repo, { task_id: 'T-after-absent', to_state: 'queued' }).ok, true);
});

test('fails malformed claims without mutating TODO state or inventing a task attempt', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-task-ledger-'));
  const claim = path.join(repo, 'claim.json');
  fs.writeFileSync(claim, '{not-json');
  const result = recordTrajectory(repo, {
    claimPath: claim,
    type: 'todo.claimed',
    runId: 'run-malformed'
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'claim_malformed');
  assert.deepEqual(readTaskLedger(repo), []);
  assert.match(fs.readFileSync(path.join(repo, '.brownie/private/phase-loop/task-ledger.jsonl'), 'utf8'), /"claim_state":"malformed"/u);
});

test('treats claim deletion during the read as an unclaimed race, not as a recreated claim', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-task-ledger-'));
  const result = recordTrajectory(repo, {
    claimPath: path.join(repo, 'claim.json'),
    type: 'todo.completed',
    runId: 'run-race',
    readClaim: () => { const error = new Error('claim deleted during read'); error.code = 'ENOENT'; throw error; }
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'unclaimed_empty');
  assert.equal(fs.existsSync(path.join(repo, 'claim.json')), false);
  assert.deepEqual(readTaskLedger(repo), []);
});

test('surfaces downstream task-ledger append failures to the controller', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-task-ledger-'));
  const ledger = path.join(repo, '.brownie/private/phase-loop/task-ledger.jsonl');
  fs.mkdirSync(ledger, { recursive: true });
  const claim = path.join(repo, 'claim.json');
  fs.writeFileSync(claim, JSON.stringify({ claim_id: 'claim-ledger-error', selected_todo: '- [ ] T-ledger-error: bounded task' }));
  const result = recordTrajectory(repo, {
    claimPath: claim,
    type: 'todo.claimed',
    runId: 'run-ledger-error'
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ledger_append_failed');
  assert.match(result.error, /directory|EISDIR|is a directory/iu);
});

test('keeps a repair-only replan nonterminal when replacement children are absent', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-task-ledger-'));
  const todo = path.join(repo, '.brownie', 'todo.md');
  fs.mkdirSync(path.dirname(todo), { recursive: true });
  fs.writeFileSync(todo, '- [ ] T-9: bounded leaf\n');
  const claim = path.join(repo, 'claim.json');
  fs.writeFileSync(claim, JSON.stringify({ claim_id: 'claim-leaf', selected_todo: '- [ ] T-9: bounded leaf' }));
  const script = path.join(process.cwd(), 'scripts', 'phase-loop-task-ledger.mjs');
  execFileSync(process.execPath, [script, 'record-trajectory', '--repo', repo, '--claim', claim, '--todo', todo, '--type', 'todo.claimed', '--run', 'run-1'], { stdio: 'pipe' });
  execFileSync(process.execPath, [script, 'record-trajectory', '--repo', repo, '--claim', claim, '--todo', todo, '--type', 'workflow.routed', '--run', 'run-1'], { stdio: 'pipe' });
  execFileSync(process.execPath, [script, 'record-trajectory', '--repo', repo, '--claim', claim, '--todo', todo, '--type', 'todo.replanned', '--payload', '{"reason":"no_progress"}', '--run', 'run-1'], { stdio: 'pipe' });
  const attempt = taskProjection(readTaskLedger(repo)).get(taskAttemptId('T-9', 'claim-leaf'));
  assert.equal(attempt.to_state, 'running');
  execFileSync(process.execPath, [script, 'record-trajectory', '--repo', repo, '--claim', claim, '--todo', todo, '--type', 'todo.completed', '--run', 'run-1'], { stdio: 'pipe' });
  assert.equal(taskProjection(readTaskLedger(repo)).get(taskAttemptId('T-9', 'claim-leaf')).to_state, 'completed');
});

test('records restored invalid mutations as terminal failed attempts', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-task-ledger-'));
  const todo = path.join(repo, '.brownie', 'todo.md');
  fs.mkdirSync(path.dirname(todo), { recursive: true });
  fs.writeFileSync(todo, '- [ ] T-10: bounded leaf\n');
  const claim = path.join(repo, 'claim.json');
  fs.writeFileSync(claim, JSON.stringify({ claim_id: 'claim-restored-mutation', selected_todo: '- [ ] T-10: bounded leaf' }));
  const script = path.join(process.cwd(), 'scripts', 'phase-loop-task-ledger.mjs');
  for (const type of ['todo.claimed', 'workflow.routed', 'todo.failed']) {
    execFileSync(process.execPath, [script, 'record-trajectory', '--repo', repo, '--claim', claim, '--todo', todo, '--type', type, '--run', 'run-1'], { stdio: 'pipe' });
  }
  const attempt = taskProjection(readTaskLedger(repo)).get(taskAttemptId('T-10', 'claim-restored-mutation'));
  assert.equal(attempt.to_state, 'failed');
  assert.equal(attempt.reason, 'trajectory_failed');

  const retryClaim = path.join(repo, 'retry-claim.json');
  fs.writeFileSync(retryClaim, JSON.stringify({ claim_id: 'claim-restored-mutation-r1', selected_todo: '- [ ] T-10: bounded leaf' }));
  for (const type of ['todo.claimed', 'workflow.routed', 'todo.completed']) {
    execFileSync(process.execPath, [script, 'record-trajectory', '--repo', repo, '--claim', retryClaim, '--todo', todo, '--type', type, '--run', 'run-2'], { stdio: 'pipe' });
  }
  assert.equal(taskProjection(readTaskLedger(repo)).get(taskAttemptId('T-10', 'claim-restored-mutation-r1')).to_state, 'completed');
});
