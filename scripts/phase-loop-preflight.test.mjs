import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { duplicateJsonKeys, validatePhaseLoopPreflight } from './phase-loop-preflight.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-phase-loop-preflight-'));
  fs.mkdirSync(path.join(repo, 'docs/architecture'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.brownie'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.brownie/todo.md'), '- [ ] E-1: Patch only `README.md`:\n  Route: documentation.\n  Verification: run `pnpm --workspace-root guard:release-contract`.\n');
  fs.writeFileSync(path.join(repo, 'docs/architecture/phase-value-manifest.json'), '{ "phase": "E-1" }\n');
  fs.writeFileSync(path.join(repo, 'docs/architecture/runtime-release-readiness-audit.json'), '{ "audited_main_commit": "1111111111111111111111111111111111111111", "runtime_release_ready": false }\n');
  const auditText = fs.readFileSync(path.join(repo, 'docs/architecture/runtime-release-readiness-audit.json'), 'utf8');
  const auditHash = `sha256:${createHash('sha256').update(auditText).digest('hex')}`;
  fs.writeFileSync(path.join(repo, 'docs/architecture/runtime-release-contract.json'), JSON.stringify({
    phase: 'RRP-8.7',
    commit_trace: {
      readiness_audit_content_sha256: auditHash
    }
  }, null, 2) + '\n');
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

test('detects duplicate JSON keys outside JSON.parse visibility', () => {
  const duplicates = duplicateJsonKeys('{ "a": 1, "nested": { "b": 1, "b": 2 }, "a": 3 }', 'fixture.json');
  assert.equal(duplicates.length, 2);
  assert(duplicates.some((entry) => entry.key === 'a' && entry.object_path === '<root>'));
  assert(duplicates.some((entry) => entry.key === 'b' && entry.object_path === 'nested'));
});

test('rejects release contract readiness audit hash drift', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'docs/architecture/runtime-release-readiness-audit.json'), '{ "audited_main_commit": "1111111111111111111111111111111111111111", "runtime_release_ready": false, "runtime_release_ready": false }\n');
  const result = validatePhaseLoopPreflight({ repo, skipCommands: true });
  assert.equal(result.valid, false);
  assert(result.errors.some((error) => error.code === 'json_duplicate_key'), JSON.stringify(result.errors));
  assert(result.errors.some((error) => error.code === 'readiness_audit_hash_mismatch'), JSON.stringify(result.errors));
});

test('rejects dirty delivery when only owner blocker remains', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, '.brownie/todo.md'), '- [ ] E-owner: Owner must provide release credentials:\n  Route: owner.\n  Verification: external owner handoff.\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'dirty\n');
  const result = validatePhaseLoopPreflight({ repo, skipCommands: true });
  assert.equal(result.valid, false);
  assert(result.errors.some((error) => error.code === 'dirty_delivery_required'), JSON.stringify(result.errors));
});

test('accepts Brownie-managed state changes when only an owner blocker remains', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, '.brownie/todo.md'), '- [ ] E-owner: Owner must provide release credentials:\n  Route: owner.\n  Verification: external owner handoff.\n');
  fs.mkdirSync(path.join(repo, '.brownie/release-evidence'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.brownie/release-evidence/managed-state.json'), '{"generated":true}\n');
  const result = validatePhaseLoopPreflight({ repo, skipCommands: true });
  assert(!result.errors.some((error) => error.code === 'dirty_delivery_required'), JSON.stringify(result.errors));
});

test('accepts an absolute TODO path inside the repository', () => {
  const repo = makeRepo();
  const result = validatePhaseLoopPreflight({
    repo,
    todo: path.join(repo, '.brownie/todo.md'),
    skipCommands: true
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('rejects a TODO path outside the repository', () => {
  const repo = makeRepo();
  const outsideTodo = path.join(os.tmpdir(), `brownie-outside-${Date.now()}.md`);
  fs.writeFileSync(outsideTodo, '- [ ] E-outside: Patch only `README.md`\n');
  const result = validatePhaseLoopPreflight({ repo, todo: outsideTodo, skipCommands: true });
  assert.equal(result.valid, false);
  assert(result.errors.some((error) => error.code === 'required_file_outside_repository'), JSON.stringify(result.errors));
  fs.rmSync(outsideTodo);
});

test('rejects an in-repository TODO symlink that resolves outside the repository', () => {
  const repo = makeRepo();
  const outsideTodo = path.join(os.tmpdir(), `brownie-outside-link-${Date.now()}.md`);
  const linkedTodo = path.join(repo, '.brownie/todo-link.md');
  fs.writeFileSync(outsideTodo, '- [ ] E-outside: Patch only `README.md`\n');
  fs.symlinkSync(outsideTodo, linkedTodo);
  const result = validatePhaseLoopPreflight({ repo, todo: linkedTodo, skipCommands: true });
  assert.equal(result.valid, false);
  assert(result.errors.some((error) => error.code === 'required_file_outside_repository'), JSON.stringify(result.errors));
  fs.rmSync(outsideTodo);
});

test('accepts a workspace TODO snapshot and records source, fingerprint, and queue CAS evidence', () => {
  const repo = makeRepo();
  const sourceTodo = path.join(os.tmpdir(), `brownie-snapshot-source-${Date.now()}.md`);
  const snapshotTodo = path.join(repo, '.brownie', 'todo-snapshot.md');
  const breakdown = path.join(repo, '.brownie', 'todo-breakdown.md');
  const todoText = fs.readFileSync(path.join(repo, '.brownie/todo.md'), 'utf8');
  fs.writeFileSync(sourceTodo, todoText);
  fs.writeFileSync(snapshotTodo, todoText);
  fs.writeFileSync(breakdown, '# snapshot breakdown\n');
  const result = validatePhaseLoopPreflight({
    repo,
    todo: snapshotTodo,
    breakdown,
    snapshotSource: sourceTodo,
    skipCommands: true
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.snapshot_audit.source_path, sourceTodo);
  assert.equal(result.snapshot_audit.snapshot_path, snapshotTodo);
  assert.equal(result.snapshot_audit.source_sha256, result.snapshot_audit.snapshot_sha256);
  assert.match(result.snapshot_audit.queue_cas, /^sha256:[0-9a-f]{64}$/u);
  fs.rmSync(sourceTodo);
});

test('rejects a workspace TODO snapshot whose source fingerprint changed', () => {
  const repo = makeRepo();
  const sourceTodo = path.join(os.tmpdir(), `brownie-snapshot-mismatch-${Date.now()}.md`);
  const snapshotTodo = path.join(repo, '.brownie', 'todo-snapshot.md');
  const breakdown = path.join(repo, '.brownie', 'todo-breakdown.md');
  fs.writeFileSync(sourceTodo, '- [ ] E-source: Patch only `README.md`\n');
  fs.copyFileSync(path.join(repo, '.brownie/todo.md'), snapshotTodo);
  fs.writeFileSync(breakdown, '# snapshot breakdown\n');
  const result = validatePhaseLoopPreflight({
    repo,
    todo: snapshotTodo,
    breakdown,
    snapshotSource: sourceTodo,
    skipCommands: true
  });
  assert.equal(result.valid, false);
  assert(result.errors.some((error) => error.code === 'todo_snapshot_fingerprint_mismatch'), JSON.stringify(result.errors));
  fs.rmSync(sourceTodo);
});

test('places the strict preflight boundary before claim rebaseline and forbids ledger/runtime continuation', () => {
  const controller = fs.readFileSync(path.join(repositoryRoot, 'phase-loop.sh'), 'utf8');
  const runOnce = controller.indexOf('_run_brownie_once()');
  const boundary = controller.indexOf('run_phase_loop_preflight "$run_stamp" "pre-claim-boundary"', runOnce);
  const rebaseline = controller.indexOf('phase_loop_rebaseline_stale_claim "$run_stamp"', runOnce);
  const restoreTransition = controller.indexOf('restore_terminal_failure_source_transition_obligation', boundary);
  assert.ok(boundary >= 0);
  assert.ok(boundary < rebaseline);
  assert.ok(boundary < restoreTransition);
  assert.match(controller, /phase_loop_preflight_boundary_failed=true claim_reuse=forbidden ledger_transition=forbidden runtime_start=forbidden/u);
  assert.ok(controller.includes('if [ "$stage" = "pre-claim-boundary" ]; then'));
  assert.ok(controller.indexOf('return 78', boundary) < rebaseline);
  assert.doesNotMatch(controller.slice(boundary, restoreTransition), /write_bdk_trajectory_event/u);
});

test('bounded implementation leaves are not instructed to re-split their TODO on missing patch context', () => {
  const prompt = fs.readFileSync(path.join(repositoryRoot, 'phase-loop.md'), 'utf8');
  assert.match(prompt, /This is allowed only when the\s+selected TODO is not already a bounded leaf with explicit patch targets\./);
  assert.match(prompt, /bounded leaf with explicit patch targets, never rewrite `\.brownie\/todo\.md` to\s+create children solely because the visible context is insufficient\./);
  assert.match(prompt, /either emit one safe patch restricted\s+to those targets, or report a concrete external\/owner blocker/);
});

test('bounded leaf oversized recovery never redirects to the TODO queue', () => {
  const controller = fs.readFileSync(path.join(repositoryRoot, 'phase-loop.sh'), 'utf8');
  assert.match(controller, /oversized or truncated\. The next tool must be exactly one smaller complete `workspace\.write` patch_file/);
  assert.match(controller, /oversized bounded-leaf repair is active[\s\S]{0,260}do not write `\.brownie\/todo\.md`/);
  assert.doesNotMatch(controller, /leaf_oversized_repair_leaf_template/);
});

test('ordinary leaf repair keeps the direct-write path when target context is available', () => {
  const controller = fs.readFileSync(path.join(repositoryRoot, 'phase-loop.sh'), 'utf8');
  assert.match(controller, /or not leaf_has_oversized_repair/);
  assert.match(controller, /leaf_required_next_tool_policy: the next tool must be `workspace\.write`/);
});
