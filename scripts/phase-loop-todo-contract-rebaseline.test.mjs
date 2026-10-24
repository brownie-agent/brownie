import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildContractRebaselineReceipt,
  contractChanges,
  matchesContractRebaselineRecord,
  writeContractRebaselineReceipt
} from './phase-loop-todo-contract-rebaseline.mjs';

const before = `- [ ] E-parent: Parent task.
  Depends on: <none>.
  Completion condition: parent.
  Forbidden changes: unrelated.
  Verification: run \`pnpm check\`.

- [ ] E-child: Child task.
  Depends on: E-parent.
  Completion condition: child.
  Forbidden changes: unrelated.
  Verification: run \`pnpm check\`.
`;

const after = before.replace('Depends on: E-parent.', 'Depends on: <none>.');

function receipt() {
  return buildContractRebaselineReceipt({
    repoRoot: process.cwd(),
    beforeTodoText: before,
    afterTodoText: after,
    runStamp: 'test-run',
    eventKey: 'test-event',
    diagnostic: 'deterministic decomposition repair',
    verification: {
      repair_command: 'node scripts/repair-todo-decomposition.mjs',
      guard_command: 'node scripts/guard-todo-decomposition.mjs',
      integrity_command: 'pnpm -s phase-loop:todo-queue-integrity'
    }
  });
}

test('records exact protected contract before/after changes and cause verification evidence', () => {
  const changes = contractChanges({ beforeTodoText: before, afterTodoText: after });
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].changed_fields, ['depends_on']);
  const record = receipt();
  assert.deepEqual(record.target_todo_ids, ['E-child']);
  assert.deepEqual(record.parent_todo_ids, ['E-parent']);
  assert.equal(record.cause_run.run_stamp, 'test-run');
  assert.equal(record.verification.guard_passed, true);
});

test('matches only an exact approved record and rejects evidence mismatch', () => {
  const record = receipt();
  const change = record.contract_changes[0];
  const expectedBeforeContract = structuredClone(change.before_contract);
  const expectedAfterContract = structuredClone(change.after_contract);
  const matched = matchesContractRebaselineRecord(record, {
    todoId: 'E-child',
    changedFields: change.changed_fields,
    beforeContract: expectedBeforeContract,
    afterContract: expectedAfterContract,
    beforeTodoSha256: record.before_todo_sha256,
    afterTodoSha256: record.after_todo_sha256
  });
  assert.equal(matched, true);
  record.contract_changes[0].after_contract.depends_on = 'E-unrelated';
  assert.equal(matchesContractRebaselineRecord(record, {
    todoId: 'E-child',
    changedFields: change.changed_fields,
    beforeContract: expectedBeforeContract,
    afterContract: expectedAfterContract,
    beforeTodoSha256: record.before_todo_sha256,
    afterTodoSha256: record.after_todo_sha256
  }), false);
});

test('keeps an approved exact contract rebaseline valid after independent queue additions', () => {
  const record = receipt();
  const change = record.contract_changes[0];
  assert.equal(matchesContractRebaselineRecord(record, {
    todoId: 'E-child',
    changedFields: change.changed_fields,
    beforeContract: structuredClone(change.before_contract),
    afterContract: structuredClone(change.after_contract),
    beforeTodoSha256: '0'.repeat(64),
    afterTodoSha256: '1'.repeat(64),
    beforeBreakdownSha256: null,
    afterBreakdownSha256: null
  }), true);
});

test('writes an atomic, mode-bounded receipt and is idempotent for the same content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brownie-contract-rebaseline-'));
  const first = writeContractRebaselineReceipt(root, receipt());
  const second = writeContractRebaselineReceipt(root, receipt());
  assert.equal(first, second);
  const stat = fs.statSync(path.join(root, first));
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(path.dirname(path.join(root, first))).filter((entry) => entry.endsWith('.tmp')).length, 0);
});
