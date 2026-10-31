import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { evaluateCompletionCertificateBoundary } from './guard-phase-loop-completion-certificate.mjs';

const phaseLoop = fs.readFileSync(new URL('../phase-loop.sh', import.meta.url), 'utf8');
const reconciliation = fs.readFileSync(new URL('./phase-loop-review-reconcile.mjs', import.meta.url), 'utf8');
const integrity = fs.readFileSync(new URL('./phase-loop-delivery-integrity.mjs', import.meta.url), 'utf8');

test('completion requires a durable certificate at every controller boundary', () => {
  const result = evaluateCompletionCertificateBoundary({ phaseLoop, reconciliation, integrity });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('the guard rejects a refactor that lets run-once hide a refused completion', () => {
  const result = evaluateCompletionCertificateBoundary({
    phaseLoop: phaseLoop.replace('run_once_status=76', 'run_once_status=0'),
    reconciliation,
    integrity
  });
  assert.equal(result.valid, false);
  assert(result.errors.includes('run_once_can_mask_rejected_completion_as_exit_zero'));
});

test('the guard rejects a rework path that keeps a prior certificate', () => {
  const result = evaluateCompletionCertificateBoundary({
    phaseLoop,
    reconciliation: reconciliation.replace('delete next.completion_certificate;', '/* stale certificate retained */'),
    integrity
  });
  assert.equal(result.valid, false);
  assert(result.errors.includes('review_rework_does_not_invalidate_completion_certificate'));
});
