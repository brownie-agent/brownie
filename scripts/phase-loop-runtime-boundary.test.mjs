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

test('controller stops repeated stale continuation scopes before a third blind resume', () => {
  assert.match(controller, /stale_continuation_scope_exhausted = \(/);
  assert.match(controller, /progress_projection\["cli_status"\] == "stale_progress"/);
  assert.match(controller, /int\(progress_projection\.get\("candidate_count"\) or 0\) == 0/);
  assert.match(controller, /same_count >= 2/);
  assert.match(controller, /if stale_continuation_scope_exhausted:\n    continuation_required = False/);
  assert.match(controller, /progress_projection\["stale_continuation_scope_exhausted"\] = stale_continuation_scope_exhausted/);
  assert.match(controller, /"candidate_count": count\(payload\.get\("candidate_count"\)\)/);
  assert.match(controller, /"headless_root_run_id": text\(payload\.get\("headless_root_run_id"\)\)/);
  assert.match(controller, /"headless_selected_run_id": text\(payload\.get\("headless_selected_run_id"\)\)/);
});

test('objective-apply replay budget follows the selected TODO across replacement claims', () => {
  assert.match(controller, /objective_apply_target_scope = json\.dumps/);
  assert.match(controller, /same_objective_apply_target_scope = \(/);
  assert.match(controller, /previous_objective_apply_target_replay_count/);
  assert.match(controller, /if not objective_apply_pending:/);
  assert.match(controller, /elif direct_objective_apply_authorization:/);
  assert.match(controller, /A lossy legacy resume is the replay that consumes this bounded budget/);
  assert.match(controller, /objective_apply_target_replay_count >= threshold/);
  assert.match(controller, /same_count >= threshold or objective_apply_target_replay_exhausted/);
  assert.match(controller, /progress_projection\["objective_apply_target_replay_exhausted"\]/);
  assert.match(controller, /objective_apply_terminal_failure = objective_apply_stalled/);
  assert.match(controller, /progress_projection\["objective_apply_terminal_failure"\] = objective_apply_terminal_failure/);
  assert.match(controller, /if terminal_non_progress or objective_apply_terminal_failure/);
  assert.match(controller, /Target-level replay lineage is supervisory metadata, not Runtime progress/);
  assert.match(controller, /fingerprint_projection\.pop\(target_lineage_field, None\)/);
  assert.match(controller, /target_replay_exhausted_after_claim_replacement = \(/);
  assert.match(controller, /same_count = max\(same_count, threshold\)/);
  assert.match(controller, /existing causeful TODO-contract replan path runs instead of emitting a/);
});

test('controller validates queue integrity before resuming an active claim', () => {
  assert.match(controller, /if phase_loop_should_resume_active_claim; then\n    # Resume is execution/);
  assert.match(controller, /if ! validate_todo_queue_integrity_before_claim "\$run_stamp"; then/);
  assert.match(controller, /todo_queue_integrity_failed_before_resume/);
  assert.match(controller, /write_status "continuation_required" "\$detail" "\$run_id" "\$exit_code" "0" "" "true"/);
  assert.doesNotMatch(controller, /continuation_required\)[\s\S]{0,500}write_status "running"/);
  assert.match(controller, /todo-queue-integrity-resume-\$run_stamp/);
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

test('runtime CLI attests the active claim before admission validation and covers run/resume payloads', () => {
  const exportClaim = controller.indexOf('export BROWNIE_PHASE_LOOP_CLAIM_ID=');
  const validation = controller.indexOf(
    'phase-loop-runtime-admission.mjs" validate',
    exportClaim,
  );
  const binder = controller.indexOf('  bind_runtime_stdout_to_active_claim "$stdout_log"', validation);
  assert(validation >= 0 && binder > validation, 'admission validation must precede post-processing binder');
  assert(exportClaim >= 0 && exportClaim < validation, 'claim ID must be exported before runtime execution');

  const cli = fs.readFileSync(
    path.join(repoRoot, 'crates/brownie-cli/src/runtime_client.rs'),
    'utf8',
  );
  assert.match(cli, /PHASE_LOOP_CLAIM_ID_ENV/);
  assert.match(cli, /PHASE_LOOP_ADMISSION_FILE_ENV/);
  assert.match(cli, /attest_phase_loop_claim_id\(\s*cli_run_or_advance_payload/);
  assert.match(cli, /attest_phase_loop_claim_id\(\s*cli_resume_payload/);
  assert.match(cli, /attest_phase_loop_claim_id_payload/);
});

test('terminal todo-decomposition leaves use integrated recovery instead of nested file splitting', () => {
  const retryCap = controller.indexOf('terminal_failure_retry_cap_zero_redelegation_required');
  const recovery = controller.indexOf('recover_terminal_todo_decomposition_leaf', retryCap);
  const supervisor = controller.indexOf('terminal_todo_decomposition_no_eligible', recovery);
  const recovered = controller.indexOf('phase_loop_terminal_stalled_replan_recovered', supervisor);

  assert(retryCap >= 0 && recovery > retryCap && supervisor > recovery && recovered > supervisor);
  assert.match(controller, /selected_route != "todo-decomposition"/u);
  assert.match(controller, /terminal_task_failed/u);
  assert.match(controller, /"split \.brownie\/todo\.md and \.brownie\/todo-breakdown\.md into nested file-specific leaves"/u);
  assert.match(controller, /retire the generated todo-decomposition leaf through integrated supervisor recovery/u);
});
