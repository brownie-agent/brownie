#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { __read_error: error?.message ?? String(error) };
  }
}

function appendJsonLine(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(handle, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function readJsonLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export function recordDelegationAdmission({ feedbackPath, auditPath, now = new Date().toISOString() }) {
  const feedback = readJson(feedbackPath);
  if (!feedback) return { ok: true, recorded: false, reason: 'feedback_missing' };
  if (feedback.__read_error) return { ok: false, code: 'feedback_unreadable', error: feedback.__read_error };
  const delegation = feedback.delegation && typeof feedback.delegation === 'object' ? feedback.delegation : {};
  const pending = (
    feedback.kind === 'phase_loop_delegation_pending'
    && feedback.completed !== true
    && delegation.required_actor === 'brownie-agent'
    && delegation.acknowledgement_required === true
    && delegation.status === 'pending'
  );
  if (!pending) return { ok: true, recorded: false, reason: 'not_pending_brownie_agent_handoff' };

  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(feedback)).digest('hex');
  const existing = readJsonLines(auditPath).find((record) => record?.feedback_sha256 === fingerprint && record?.phase === 'received');
  if (existing) return { ok: true, recorded: false, reason: 'already_received', record: existing };
  const record = {
    schema_version: 1,
    kind: 'phase_loop_delegation_admission',
    phase: 'received',
    admission_id: crypto.randomUUID(),
    feedback_sha256: fingerprint,
    selected_todo_first_line: String(feedback.selected_todo ?? '').split('\n')[0],
    required_actor: 'brownie-agent',
    authority: 'existing_controller_maintenance_implementation_policy',
    required_authority: 'brownie-agent implementation actor and authenticated implementation credentials',
    alternative_unavailable: true,
    reason: 'controller_maintenance_delegation_received_without_requiring_a_second_user_approval',
    at: now
  };
  try {
    appendJsonLine(auditPath, record);
    return { ok: true, recorded: true, record };
  } catch (error) {
    return { ok: false, code: 'admission_audit_write_failed', error: error.message };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname) && process.argv[2] === 'record') {
  const args = new Map(process.argv.slice(3).reduce((pairs, value, index, values) => (
    value.startsWith('--') ? [...pairs, [value.slice(2), values[index + 1]]] : pairs
  ), []));
  const feedbackPath = args.get('feedback');
  const auditPath = args.get('audit');
  if (!feedbackPath || !auditPath) process.exit(2);
  const result = recordDelegationAdmission({ feedbackPath, auditPath });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exit(78);
}
