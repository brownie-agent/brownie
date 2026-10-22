#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function selectedTodoId(selectedTodo = '') {
  return String(selectedTodo).split('\n')[0].match(/^\s*(?:[-*]|\d+[.)])\s+\[\s\]\s+([^:\s]+)/u)?.[1] ?? '';
}

export function createRuntimeAdmission({ claim, runStamp }) {
  const selectedTodo = String(claim?.selected_todo ?? '');
  return {
    schema_version: 1,
    kind: 'phase_loop_runtime_admission',
    run_stamp: String(runStamp),
    claim_id: String(claim?.claim_id ?? ''),
    selected_todo_id: selectedTodoId(selectedTodo),
    selected_todo_sha256: sha256(selectedTodo),
    queue_generation: claim?.queue_generation ?? null,
    queue_fingerprint: String(claim?.queue_fingerprint ?? ''),
    status: 'admitted',
    task_id: null,
    runtime_run_id: null,
  };
}

export function compareRuntimeAdmissionSnapshot(admission, claim) {
  const selectedTodo = String(claim?.selected_todo ?? '');
  const expected = {
    claim_id: String(claim?.claim_id ?? ''),
    selected_todo_id: selectedTodoId(selectedTodo),
    selected_todo_sha256: sha256(selectedTodo),
    queue_generation: claim?.queue_generation ?? null,
    queue_fingerprint: String(claim?.queue_fingerprint ?? ''),
  };
  const mismatches = Object.keys(expected).filter((field) =>
    String(admission?.[field] ?? '') !== String(expected[field] ?? '')
  );
  return {
    ok: mismatches.length === 0,
    mismatches,
    expected,
    actual: Object.fromEntries(Object.keys(expected).map((field) => [field, admission?.[field] ?? null])),
    reason: mismatches.length === 0 ? 'runtime_admission_snapshot_confirmed' : 'runtime_admission_snapshot_mismatch',
  };
}

function runtimePayload(root) {
  if (root?.run && typeof root.run === 'object') return root.run;
  if (root?.resume && typeof root.resume === 'object') return root.resume;
  return root && typeof root === 'object' ? root : {};
}

export function validateRuntimeAdmission(admission, root) {
  const payload = runtimePayload(root);
  const runtimeClaimId = payload.phase_loop_claim_id ?? payload.automation?.phase_loop_claim_id;
  const taskId = payload.task_id ?? payload.automation?.task_id ?? null;
  const runtimeRunId = payload.run_id ?? payload.automation?.run_id ?? payload.session_id ?? null;
  const status = String(payload.status ?? '');
  const terminalFailure = payload.terminal_failure === true
    || payload.stop_class === 'terminal_failure'
    || payload.stop_reason === 'terminal_task_failed'
    || payload.automation?.terminal_failure === true;
  const executed = payload.task_execution_confirmed === true
    || payload.task_execution?.started === true
    || payload.execution?.started === true
    || status === 'task_executed'
    || payload.workspace_write_applied === true
    || payload.objective_apply_applied === true;
  // The runtime must attest the exact claim that was admitted.  An omitted
  // claim ID is not an attestation and must fail closed just like a different
  // claim ID.
  const claimMatches = typeof runtimeClaimId === 'string'
    && runtimeClaimId.length > 0
    && typeof admission?.claim_id === 'string'
    && admission.claim_id.length > 0
    && runtimeClaimId === admission.claim_id;
  const runtimeSnapshot = {
    selected_todo_id: payload.phase_loop_selected_todo_id ?? payload.automation?.phase_loop_selected_todo_id,
    selected_todo_sha256: payload.phase_loop_selected_todo_sha256 ?? payload.automation?.phase_loop_selected_todo_sha256,
    queue_generation: payload.phase_loop_queue_generation ?? payload.automation?.phase_loop_queue_generation,
    queue_fingerprint: payload.phase_loop_queue_fingerprint ?? payload.automation?.phase_loop_queue_fingerprint,
  };
  const snapshotFieldsPresent = Object.values(runtimeSnapshot).some((value) => value !== undefined);
  const snapshotMatches = !snapshotFieldsPresent || Object.keys(runtimeSnapshot).every((field) =>
    String(runtimeSnapshot[field] ?? '') === String(admission?.[field] ?? '')
  );
  const snapshotMismatch = !claimMatches || !snapshotMatches
    || (status === 'no_eligible_task' && !executed && terminalFailure);
  return {
    ok: !snapshotMismatch,
    claim_matches: claimMatches,
    snapshot_mismatch: snapshotMismatch,
    task_execution_confirmed: executed,
    status,
    terminal_failure: terminalFailure,
    task_id: taskId,
    runtime_run_id: runtimeRunId,
    reason: snapshotMismatch
      ? (!claimMatches ? 'runtime_claim_snapshot_mismatch'
        : (!snapshotMatches ? 'runtime_admission_snapshot_mismatch' : 'claimed_task_not_admitted'))
      : 'runtime_admission_confirmed',
  };
}

export function writeRuntimeAdmission(file, admission) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(admission, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  return admission;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [command, firstPath, secondPath, runStamp] = process.argv.slice(2);
  if (command === 'create' && firstPath && secondPath && runStamp) {
    const claim = JSON.parse(fs.readFileSync(secondPath, 'utf8'));
    process.stdout.write(`${JSON.stringify(writeRuntimeAdmission(firstPath, createRuntimeAdmission({ claim, runStamp })))}\n`);
    process.exit(0);
  }
  if (command === 'validate' && firstPath && secondPath) {
    const admission = JSON.parse(fs.readFileSync(firstPath, 'utf8'));
    let root;
    try {
      root = JSON.parse(fs.readFileSync(secondPath, 'utf8'));
    } catch {
      // Preserve the existing controller recovery path for malformed provider
      // output; admission only owns the explicit JSON snapshot contract.
      process.stdout.write(`${JSON.stringify({ ok: true, snapshot_mismatch: false, reason: 'runtime_output_unparseable_defer_existing_recovery' })}\n`);
      process.exit(0);
    }
    const result = validateRuntimeAdmission(admission, root);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.ok ? 0 : 78);
  }
  if (command === 'verify' && firstPath && secondPath) {
    const admission = JSON.parse(fs.readFileSync(firstPath, 'utf8'));
    const claim = JSON.parse(fs.readFileSync(secondPath, 'utf8'));
    const result = compareRuntimeAdmissionSnapshot(admission, claim);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.ok ? 0 : 78);
  }
  process.exit(2);
}
