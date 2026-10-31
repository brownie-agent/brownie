#!/usr/bin/env node
/**
 * Fail closed if a controller refactor removes the durable boundary between
 * execution progress and delivered completion.  This guard intentionally
 * checks the cross-file control-plane wiring in addition to the unit tests:
 * the shell owns public events/exit codes, while reconciliation owns the
 * immutable completion certificate.
 */
import fs from 'node:fs';
import path from 'node:path';

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function between(source, start, end) {
  const offset = source.indexOf(start);
  if (offset < 0) return '';
  const tail = source.slice(offset);
  const limit = end ? tail.indexOf(end) : -1;
  return limit < 0 ? tail : tail.slice(0, limit);
}

export function evaluateCompletionCertificateBoundary({ phaseLoop, reconciliation, integrity }) {
  const errors = [];
  const receipt = between(phaseLoop, 'phase_loop_terminal_delivery_receipt_valid()', 'write_bdk_trajectory_event()');
  const writer = between(phaseLoop, 'write_todo_claim()', 'restore_claim_snapshot_before_runtime()');
  const supervise = between(phaseLoop, 'supervise()', 'normalize_stale_running_before_start()');
  const runOnce = between(phaseLoop, '  run-once)', '  *)');
  const changesRequested = between(reconciliation, "if (result.status === 'changes_requested')", "} else if (result.status === 'completed')");

  if (!receipt.includes('validate-certificate')) errors.push('terminal_event_receipt_not_validated_by_completion_certificate');
  if (!writer.includes('validate-certificate')) errors.push('claim_writer_not_validated_by_completion_certificate');
  if (!writer.includes('completion_certificate_or_independent_review_ci_merge_missing')) {
    errors.push('claim_writer_missing_auditable_certificate_rejection');
  }
  if (!supervise.includes('completion_promotion_refused_supervisor_stop=true') || !supervise.includes('exit 76')) {
    errors.push('supervisor_can_mask_rejected_completion_as_success');
  }
  if (!runOnce.includes('run_once_status=76')) errors.push('run_once_can_mask_rejected_completion_as_exit_zero');
  if (!reconciliation.includes("state: 'CHANGES_REQUESTED'")) errors.push('review_rework_state_not_durable');
  if (!changesRequested.includes('delete next.completion_certificate')) errors.push('review_rework_does_not_invalidate_completion_certificate');
  if (!reconciliation.includes('createCompletionCertificate')) errors.push('review_reconciliation_cannot_issue_completion_certificate');
  if (!integrity.includes('export function validateCompletionCertificate')) errors.push('completion_certificate_validator_missing');
  if (!integrity.includes('completion_certificate_invalidated_by_changes_requested')) {
    errors.push('changes_requested_does_not_invalidate_completion_certificate');
  }
  return { valid: errors.length === 0, errors };
}

function main() {
  const root = process.cwd();
  const result = evaluateCompletionCertificateBoundary({
    phaseLoop: read(path.join(root, 'phase-loop.sh')),
    reconciliation: read(path.join(root, 'scripts/phase-loop-review-reconcile.mjs')),
    integrity: read(path.join(root, 'scripts/phase-loop-delivery-integrity.mjs'))
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.valid ? 0 : 76);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
