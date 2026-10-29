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

function writeIndexText(repoRoot, relativePath, text) {
  const blob = git(repoRoot, ['hash-object', '-w', '--stdin'], { input: text });
  git(repoRoot, ['update-index', '--add', '--cacheinfo', '100644', blob, relativePath]);
  return blob;
}

function materializedTransitions(records) {
  const transitions = [];
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
        targets.push({ path: target, placeholder_sha256: String(snapshot.sha256_after) });
      }
      if (targets.length === 0) continue;
      transitions.push({
        todo_id: before.id,
        before_contract: before,
        after_contract: after,
        targets,
        receipt_run_stamp: String(record.cause_run?.run_stamp ?? ''),
        receipt_event_key: String(record.cause_run?.event_key ?? '')
      });
    }
  }
  return transitions;
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

function validateTargetCandidate(repoRoot, baseRef, transition, errors) {
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
    if (sha256File(absolutePath) === target.placeholder_sha256) {
      errors.push({ code: 'materialized_scope_target_still_placeholder', todo_id: transition.todo_id, path: target.path });
      continue;
    }
    const baseBlob = revisionBlob(repoRoot, baseRef, target.path);
    if (baseBlob && baseBlob === stagedBlob) {
      errors.push({ code: 'materialized_scope_target_not_in_candidate', todo_id: transition.todo_id, path: target.path });
    }
  }
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
    const worktree = contractForTodo(worktreeTodoText, todoId);
    if (!base || !worktree || !worktree.unchecked || sameContract(base.contract, worktree.contract)) continue;
    const pathTransitions = findTransitionPath(
      transitions.filter((transition) => transition.todo_id === todoId),
      base.contract,
      worktree.contract
    );
    if (!pathTransitions) {
      const beginsAtBase = transitions.some((transition) => transition.todo_id === todoId && sameContract(transition.before_contract, base.contract));
      if (beginsAtBase) {
        errors.push({ code: 'materialized_scope_publication_chain_missing', todo_id: todoId, base_ref: baseRef });
      }
      continue;
    }

    const candidate = contractForTodo(candidateTodoText, todoId);
    const states = [base.contract, ...pathTransitions.map((transition) => transition.after_contract)];
    const stateIndex = states.findIndex((state) => candidate && sameContract(state, candidate.contract));
    if (stateIndex < 0) {
      errors.push({ code: 'materialized_scope_index_contract_mismatch', todo_id: todoId });
      continue;
    }
    if (!sameContract(states.at(-1), worktree.contract)) {
      errors.push({ code: 'materialized_scope_worktree_contract_mismatch', todo_id: todoId });
      continue;
    }
    for (const transition of pathTransitions) validateTargetCandidate(repoRoot, baseRef, transition, errors);
    if (errors.length > 0) continue;
    for (const transition of pathTransitions.slice(stateIndex)) {
      candidateTodoText = replaceTodoFirstLine(
        candidateTodoText,
        todoId,
        transition.before_contract.first_line,
        transition.after_contract.first_line
      );
    }
    checked.push({ todo_id: todoId, receipt_run_stamps: pathTransitions.map((transition) => transition.receipt_run_stamp), targets: pathTransitions.flatMap((transition) => transition.targets.map((target) => target.path)) });
    if (stateIndex < pathTransitions.length) appliedTodoIds.push(todoId);
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
