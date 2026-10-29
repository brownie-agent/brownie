#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundedScopeEntries } from './phase-loop-bounded-scope.mjs';
import {
  contractMap,
  protectedContract,
  readContractRebaselineRecords
} from './phase-loop-todo-contract-rebaseline.mjs';

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const todoPath = '.brownie/todo.md';

function parseArgs(argv) {
  const args = { repo: defaultRepoRoot, baseRef: 'HEAD', applyIndex: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--repo') args.repo = path.resolve(argv[++index] ?? '');
    else if (argument === '--base-ref') args.baseRef = argv[++index] ?? 'HEAD';
    else if (argument === '--apply-index') args.applyIndex = true;
    else throw new Error(`Unknown materialized-scope publication guard argument: ${argument}`);
  }
  return args;
}

function git(repoRoot, args, options = {}) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: options.encoding ?? 'utf8',
    input: options.input,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
  }).trim();
}

function tryGit(repoRoot, args, options = {}) {
  try {
    return git(repoRoot, args, options);
  } catch {
    return null;
  }
}

function readRevisionText(repoRoot, revision, relativePath) {
  const spec = revision === ':' ? `:${relativePath}` : `${revision}:${relativePath}`;
  return tryGit(repoRoot, ['show', spec]);
}

function readIndexText(repoRoot, relativePath) {
  return readRevisionText(repoRoot, ':', relativePath);
}

function indexBlob(repoRoot, relativePath) {
  return tryGit(repoRoot, ['rev-parse', `:${relativePath}`]);
}

function revisionBlob(repoRoot, revision, relativePath) {
  return tryGit(repoRoot, ['rev-parse', `${revision}:${relativePath}`]);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function todoBlocksWithOffsets(text) {
  const source = String(text ?? '');
  const starts = [...source.matchAll(/^(?:[-*]|\d+[.)])\s+\[[ xX]\]\s+/gmu)].map((match) => match.index);
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? source.length;
    return { start, end, block: source.slice(start, end).trimEnd() };
  });
}

function contractForTodo(text, todoId) {
  const block = contractMap(text).get(todoId);
  if (!block) return null;
  return {
    block,
    contract: protectedContract(block),
    unchecked: /^(?:[-*]|\d+[.)])\s+\[\s\]\s+/u.test(block)
  };
}

function sameContract(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeRelativePath(value) {
  const relativePath = String(value ?? '');
  return relativePath
    && !path.isAbsolute(relativePath)
    && relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !relativePath.includes(`..${path.sep}`);
}

function replaceTodoFirstLine(text, todoId, beforeLine, afterLine) {
  const source = String(text ?? '');
  const entry = todoBlocksWithOffsets(source).find((candidate) => protectedContract(candidate.block).id === todoId);
  if (!entry) throw new Error(`TODO contract is absent from index: ${todoId}`);
  const lineEnd = source.indexOf('\n', entry.start);
  const effectiveEnd = lineEnd < 0 ? source.length : lineEnd;
  const line = source.slice(entry.start, effectiveEnd);
  const offset = line.indexOf(beforeLine);
  if (offset < 0 || line.trim() !== beforeLine) {
    throw new Error(`TODO contract line is not the approved before-state: ${todoId}`);
  }
  return `${source.slice(0, entry.start + offset)}${afterLine}${source.slice(entry.start + offset + beforeLine.length)}`;
}

function removeTodoBlock(text, todoId, expectedContracts) {
  const source = String(text ?? '');
  const entry = todoBlocksWithOffsets(source).find((candidate) => protectedContract(candidate.block).id === todoId);
  if (!entry) throw new Error(`TODO contract is absent from index: ${todoId}`);
  const actual = protectedContract(entry.block);
  if (!expectedContracts.some((expected) => sameContract(actual, expected))) {
    throw new Error(`TODO contract is not an approved completion state: ${todoId}`);
  }
  return `${source.slice(0, entry.start)}${source.slice(entry.end)}`;
}

function writeIndexText(repoRoot, relativePath, text) {
  const blob = git(repoRoot, ['hash-object', '-w', '--stdin'], { input: text });
  git(repoRoot, ['update-index', '--add', '--cacheinfo', '100644', blob, relativePath]);
  return blob;
}

function materializedTransitions(records) {
  const transitions = new Map();
  for (const record of records) {
    if (record?.schema_version !== 1
      || record?.record_type !== 'todo_contract_rebaseline'
      || record?.status !== 'approved'
      || !Array.isArray(record.contract_changes)) continue;
    for (const change of record.contract_changes) {
      const before = change?.before_contract;
      const after = change?.after_contract;
      if (!before?.id || before.id !== after?.id || !before.first_line || !after.first_line) continue;
      const beforeScopes = new Map(boundedScopeEntries(before.first_line).map((entry) => [entry.path, entry.operation]));
      const afterScopes = new Map(boundedScopeEntries(after.first_line).map((entry) => [entry.path, entry.operation]));
      const targets = [];
      for (const [target, operation] of beforeScopes) {
        if (operation !== 'create' || afterScopes.get(target) !== 'patch') continue;
        const snapshot = record.target_snapshots?.find((entry) => entry?.path === target && entry?.exists_after === true);
        if (!snapshot?.sha256_after) continue;
        targets.push({
          path: target,
          placeholder_sha256: String(snapshot.sha256_after)
        });
      }
      if (targets.length === 0) continue;
      const captureMode = String(record.target_capture?.mode ?? '');
      const normalizedTargets = targets.map((target) => ({
        ...target,
        target_capture_modes: [captureMode]
      }));
      const receiptRunStamp = String(record.cause_run?.run_stamp ?? '');
      const receiptEventKey = String(record.cause_run?.event_key ?? '');
      const key = JSON.stringify({ todo_id: before.id, before_contract: before, after_contract: after });
      const existing = transitions.get(key);
      if (!existing) {
        transitions.set(key, {
          todo_id: before.id,
          before_contract: before,
          after_contract: after,
          targets: normalizedTargets,
          target_evidence_conflicts: [],
          receipt_run_stamps: [receiptRunStamp],
          receipt_event_keys: [receiptEventKey]
        });
        continue;
      }
      if (!existing.receipt_run_stamps.includes(receiptRunStamp)) existing.receipt_run_stamps.push(receiptRunStamp);
      if (!existing.receipt_event_keys.includes(receiptEventKey)) existing.receipt_event_keys.push(receiptEventKey);
      for (const target of normalizedTargets) {
        const matchingTarget = existing.targets.find((candidate) => candidate.path === target.path);
        if (!matchingTarget) {
          existing.targets.push(target);
          continue;
        }
        if (matchingTarget.placeholder_sha256 !== target.placeholder_sha256) {
          existing.target_evidence_conflicts.push({
            path: target.path,
            expected_sha256: matchingTarget.placeholder_sha256,
            conflicting_sha256: target.placeholder_sha256
          });
          continue;
        }
        for (const mode of target.target_capture_modes) {
          if (!matchingTarget.target_capture_modes.includes(mode)) matchingTarget.target_capture_modes.push(mode);
        }
      }
    }
  }
  return [...transitions.values()];
}

function findTransitionPath(transitions, start, target) {
  const startKey = JSON.stringify(start);
  const targetKey = JSON.stringify(target);
  if (startKey === targetKey) return [];
  const queue = [{ key: startKey, path: [] }];
  const visited = new Set([startKey]);
  while (queue.length > 0) {
    const current = queue.shift();
    for (const transition of transitions) {
      if (JSON.stringify(transition.before_contract) !== current.key) continue;
      const nextKey = JSON.stringify(transition.after_contract);
      const nextPath = [...current.path, transition];
      if (nextKey === targetKey) return nextPath;
      if (!visited.has(nextKey)) {
        visited.add(nextKey);
        queue.push({ key: nextKey, path: nextPath });
      }
    }
  }
  return null;
}

function findTerminalTransitionPath(transitions, start) {
  const path = [];
  const visited = new Set();
  let current = start;
  while (true) {
    const currentKey = JSON.stringify(current);
    if (visited.has(currentKey)) return null;
    visited.add(currentKey);
    const outgoing = transitions.filter((transition) => JSON.stringify(transition.before_contract) === currentKey);
    if (outgoing.length === 0) return path;
    if (outgoing.length !== 1) return null;
    const [transition] = outgoing;
    path.push(transition);
    current = transition.after_contract;
  }
}

function validateTargetCandidate(repoRoot, baseRef, transition, errors) {
  for (const conflict of transition.target_evidence_conflicts ?? []) {
    errors.push({ code: 'materialized_scope_target_evidence_conflict', todo_id: transition.todo_id, ...conflict });
  }
  for (const target of transition.targets) {
    if (!safeRelativePath(target.path)) {
      errors.push({ code: 'materialized_scope_target_path_invalid', todo_id: transition.todo_id, path: target.path });
      continue;
    }
    const absolutePath = path.join(repoRoot, target.path);
    const stagedBlob = indexBlob(repoRoot, target.path);
    if (!stagedBlob) {
      errors.push({ code: 'materialized_scope_target_not_staged', todo_id: transition.todo_id, path: target.path });
      continue;
    }
    if (!fs.existsSync(absolutePath)) {
      errors.push({ code: 'materialized_scope_target_missing_from_worktree', todo_id: transition.todo_id, path: target.path });
      continue;
    }
    const worktreeBlob = git(repoRoot, ['hash-object', '--', target.path]);
    if (worktreeBlob !== stagedBlob) {
      errors.push({ code: 'materialized_scope_target_index_mismatch', todo_id: transition.todo_id, path: target.path });
      continue;
    }
    const rawPlaceholderMatch = sha256File(absolutePath) === target.placeholder_sha256;
    const legacyTrimmedPlaceholderMatch = target.target_capture_modes?.includes('legacy_pre_capture_materialization')
      && sha256Text(fs.readFileSync(absolutePath, 'utf8').trim()) === target.placeholder_sha256;
    if (rawPlaceholderMatch || legacyTrimmedPlaceholderMatch) {
      errors.push({ code: 'materialized_scope_target_still_placeholder', todo_id: transition.todo_id, path: target.path });
      continue;
    }
    const baseBlob = revisionBlob(repoRoot, baseRef, target.path);
    if (baseBlob && baseBlob === stagedBlob) {
      errors.push({ code: 'materialized_scope_target_not_in_candidate', todo_id: transition.todo_id, path: target.path });
    }
  }
}

function targetIsInCandidate(repoRoot, baseRef, target) {
  if (!safeRelativePath(target.path)) return false;
  const stagedBlob = indexBlob(repoRoot, target.path);
  if (!stagedBlob) return false;
  return revisionBlob(repoRoot, baseRef, target.path) !== stagedBlob;
}

function receiptRunStamps(pathTransitions) {
  return [...new Set(pathTransitions.flatMap((transition) => transition.receipt_run_stamps ?? []))];
}

export function guardMaterializedScopePublication({ repoRoot = defaultRepoRoot, baseRef = 'HEAD', applyIndex = false } = {}) {
  const errors = [];
  const records = readContractRebaselineRecords(repoRoot);
  const transitions = materializedTransitions(records);
  // Completion-only publication and isolated controller fixtures do not carry
  // a materialized Create-to-Patch receipt.  In that case this guard has no
  // contract to publish and must not require a workspace-local TODO file.
  // Requiring one here would turn a completed queue cleanup into a false
  // publication failure.
  if (transitions.length === 0) {
    return {
      valid: true,
      applied: false,
      base_ref: baseRef,
      checked: [],
      auto_staged_todo_ids: [],
      errors: []
    };
  }
  const baseTodoText = readRevisionText(repoRoot, baseRef, todoPath);
  const indexTodoText = readIndexText(repoRoot, todoPath);
  let worktreeTodoText = null;
  try {
    worktreeTodoText = fs.readFileSync(path.join(repoRoot, todoPath), 'utf8');
  } catch (error) {
    errors.push({ code: 'materialized_scope_todo_unreadable', path: todoPath, message: error.message });
  }
  if (baseTodoText === null || indexTodoText === null || worktreeTodoText === null) {
    errors.push({ code: 'materialized_scope_todo_not_available', path: todoPath, base_ref: baseRef });
    return { valid: false, applied: false, errors, transitions: [] };
  }

  let candidateTodoText = indexTodoText;
  const appliedTodoIds = [];
  const checked = [];
  const todoIds = [...new Set(transitions.map((transition) => transition.todo_id))];
  for (const todoId of todoIds) {
    const base = contractForTodo(baseTodoText, todoId);
    const index = contractForTodo(indexTodoText, todoId);
    const worktree = contractForTodo(worktreeTodoText, todoId);
    if (!base) continue;
    const todoTransitions = transitions.filter((transition) => transition.todo_id === todoId);
    const indexCompleted = !index;
    const worktreeCompleted = !worktree;
    const candidateChangesContract = indexCompleted || !sameContract(base.contract, index.contract);
    // Establish candidate involvement from the index before looking at the
    // worktree.  The index is what can be committed; a restored worktree TODO
    // must never make a staged contract or target invisible to validation.
    const candidateIncludesTarget = todoTransitions.some((transition) => transition.targets.some((target) => targetIsInCandidate(repoRoot, baseRef, target)));
    if (!candidateIncludesTarget && !candidateChangesContract) continue;

    const indexPathTransitions = indexCompleted
      ? findTerminalTransitionPath(todoTransitions, base.contract)
      : findTransitionPath(todoTransitions, base.contract, index.contract);
    const worktreePathTransitions = worktreeCompleted
      ? findTerminalTransitionPath(todoTransitions, base.contract)
      : findTransitionPath(todoTransitions, base.contract, worktree.contract);
    const pathTransitions = candidateChangesContract ? indexPathTransitions : worktreePathTransitions;
    const completed = candidateChangesContract ? indexCompleted : worktreeCompleted;
    if (!pathTransitions) {
      const beginsAtBase = todoTransitions.some((transition) => sameContract(transition.before_contract, base.contract));
      if (beginsAtBase) {
        errors.push({
          code: candidateChangesContract && !indexCompleted
            ? 'materialized_scope_index_contract_mismatch'
            : completed
              ? 'materialized_scope_completion_chain_ambiguous'
              : 'materialized_scope_publication_chain_missing',
          todo_id: todoId,
          base_ref: baseRef
        });
      }
      continue;
    }

    // No materialized transition starts at this branch's TODO state. Another
    // completion path owns the queue removal, so this guard must not stage an
    // unrelated TODO edit merely because an older receipt still exists.
    if (completed && pathTransitions.length === 0) continue;

    const candidate = contractForTodo(candidateTodoText, todoId);
    const states = [base.contract, ...pathTransitions.map((transition) => transition.after_contract)];
    if (!candidateChangesContract && pathTransitions.length === 0) {
      errors.push({ code: 'materialized_scope_contract_transition_missing', todo_id: todoId });
      continue;
    }
    const worktreeMatchesIndex = indexCompleted === worktreeCompleted
      && (indexCompleted || sameContract(index.contract, worktree.contract));
    // A caller may already have staged the exact queue removal before this
    // guard runs.  That is a valid candidate shape, but it must not bypass
    // target validation: otherwise a staged removal plus an unchanged
    // placeholder implementation could be published without a contract.
    if (completed && !candidate) {
      for (const transition of pathTransitions) validateTargetCandidate(repoRoot, baseRef, transition, errors);
      if (!worktreeMatchesIndex) {
        errors.push({ code: 'materialized_scope_worktree_contract_mismatch', todo_id: todoId });
      }
      if (errors.length > 0) continue;
      checked.push({
        todo_id: todoId,
        completion_removed: true,
        completion_removal_already_staged: true,
        receipt_run_stamps: receiptRunStamps(pathTransitions),
        targets: pathTransitions.flatMap((transition) => transition.targets.map((target) => target.path))
      });
      continue;
    }
    const stateIndex = states.findIndex((state) => candidate && sameContract(state, candidate.contract));
    if (stateIndex < 0) {
      errors.push({ code: 'materialized_scope_index_contract_mismatch', todo_id: todoId });
      continue;
    }
    for (const transition of pathTransitions) validateTargetCandidate(repoRoot, baseRef, transition, errors);
    if (candidateChangesContract && !worktreeMatchesIndex) {
      errors.push({ code: 'materialized_scope_worktree_contract_mismatch', todo_id: todoId });
    }
    if (errors.length > 0) continue;
    if (completed) {
      candidateTodoText = removeTodoBlock(candidateTodoText, todoId, states);
      appliedTodoIds.push(todoId);
    } else {
      for (const transition of pathTransitions.slice(stateIndex)) {
        candidateTodoText = replaceTodoFirstLine(
          candidateTodoText,
          todoId,
          transition.before_contract.first_line,
          transition.after_contract.first_line
        );
      }
      if (stateIndex < pathTransitions.length) appliedTodoIds.push(todoId);
    }
    checked.push({
      todo_id: todoId,
      completion_removed: completed,
      receipt_run_stamps: receiptRunStamps(pathTransitions),
      targets: pathTransitions.flatMap((transition) => transition.targets.map((target) => target.path))
    });
  }

  if (errors.length === 0 && candidateTodoText !== indexTodoText && applyIndex) {
    writeIndexText(repoRoot, todoPath, candidateTodoText);
  }
  if (errors.length === 0 && candidateTodoText !== indexTodoText && !applyIndex) {
    errors.push({ code: 'materialized_scope_contract_not_staged', todo_ids: appliedTodoIds });
  }
  return {
    valid: errors.length === 0,
    applied: errors.length === 0 && candidateTodoText !== indexTodoText && applyIndex,
    base_ref: baseRef,
    checked,
    auto_staged_todo_ids: errors.length === 0 && applyIndex ? appliedTodoIds : [],
    errors
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = guardMaterializedScopePublication({ repoRoot: args.repo, baseRef: args.baseRef, applyIndex: args.applyIndex });
    const output = JSON.stringify(result, null, 2);
    if (!result.valid) {
      console.error(output);
      process.exit(1);
    }
    console.log(output);
  } catch (error) {
    console.error(JSON.stringify({ valid: false, applied: false, errors: [{ code: 'materialized_scope_publication_guard_exception', message: error?.message ?? String(error) }] }, null, 2));
    process.exit(1);
  }
}
