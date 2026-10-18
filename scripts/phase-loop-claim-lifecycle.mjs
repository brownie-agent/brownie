#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

export const CLAIM_STATES = new Set(['present', 'absent', 'malformed', 'unreadable']);

export function readClaimSnapshot(claimPath, { readFileSync = fs.readFileSync } = {}) {
  try {
    const text = readFileSync(claimPath, 'utf8');
    let claim;
    try {
      claim = JSON.parse(text);
    } catch (error) {
      return { ok: false, state: 'malformed', error };
    }
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
      return { ok: false, state: 'malformed', error: new Error('claim must be a JSON object') };
    }
    return { ok: true, state: 'present', claim };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, state: 'absent', error };
    return { ok: false, state: 'unreadable', error };
  }
}

export function claimLifecycleFields(snapshot) {
  const state = CLAIM_STATES.has(snapshot?.state) ? snapshot.state : 'unreadable';
  return {
    claim_state: state,
    claim_id: snapshot?.ok ? snapshot.claim?.claim_id ?? null : null,
    claim_error_code: snapshot?.ok ? null : snapshot?.error?.code ?? state,
    claim_error_message: snapshot?.ok ? null : snapshot?.error?.message ?? null
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname) && process.argv[2] === 'snapshot') {
  const args = new Map(process.argv.slice(3).reduce((pairs, value, index, values) => (
    value.startsWith('--') ? [...pairs, [value.slice(2), values[index + 1]]] : pairs
  ), []));
  const claimPath = args.get('claim');
  if (!claimPath) process.exit(2);
  const snapshot = readClaimSnapshot(claimPath);
  process.stdout.write(`${JSON.stringify({ ...snapshot, ...claimLifecycleFields(snapshot) })}\n`);
}
