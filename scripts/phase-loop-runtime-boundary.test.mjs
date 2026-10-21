import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const controller = fs.readFileSync(path.join(repoRoot, 'phase-loop.sh'), 'utf8');

function mismatchRecoveryBlock() {
  const start = controller.indexOf('if [ "$runtime_admission_status" -ne 0 ]; then');
  const end = controller.indexOf('  bind_runtime_stdout_to_active_claim "$stdout_log"', start);
  assert(start >= 0 && end > start, 'runtime admission mismatch recovery block must exist');
  return controller.slice(start, end);
}

test('runtime mismatch recovery restores delegated scope, target, and pre-runtime claim snapshots', () => {
  const block = mismatchRecoveryBlock();
  assert.match(block, /phase-loop-delegated-scope\.mjs/);
  assert.match(block, /active_target_snapshot/);
  assert.match(block, /cp \"\$active_target_snapshot\"/);
  assert.match(block, /restore_claim_snapshot_before_runtime \"\$claim_snapshot_before_runtime\"/);
  assert.doesNotMatch(block, /\n\s+write_todo_claim\b/);
});

test('public blocked-event canonicalization preserves owner stops without contradictory continuation', () => {
  assert.match(controller, /reason in \{\"explicit_blocker\", \"explicit_blocker_pre_runtime\"\}/);
  assert.match(controller, /payload\.get\("owner_blocked"\) is True/);
  assert.match(controller, /payload\[\"owner_blocked\"\] = True/);
  assert.match(controller, /payload\.pop\("continuation_required", None\)/);
});

test('claim snapshot restore validates durable identity before writing current claim', () => {
  const start = controller.indexOf('restore_claim_snapshot_before_runtime()');
  const end = controller.indexOf('\ncompleted_todo_cleanup_pending()', start);
  assert(start >= 0 && end > start, 'claim snapshot restore helper must exist');
  const helper = controller.slice(start, end);
  assert.match(helper, /claim\.get\("claim_id"\)/);
  assert.match(helper, /claim\.get\("selected_todo"\)/);
  assert.match(helper, /destination\.write_text/);
});
