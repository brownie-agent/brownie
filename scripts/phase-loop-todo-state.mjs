#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function checkboxBlocks(text) {
  const starts = [...String(text ?? '').matchAll(/^(?:[-*]|\d+[.)])\s+\[[ xX]\]\s+/gmu)].map((match) => match.index);
  return starts.map((start, index) => String(text).slice(start, starts[index + 1] ?? String(text).length).trimEnd());
}

export function todoIdFromBlock(block) {
  const firstLine = String(block ?? '').split('\n')[0]?.trim() ?? '';
  return firstLine
    .replace(/^(?:[-*]|\d+[.)])\s+\[[ xX]\]\s+/u, '')
    .split(':')[0]
    ?.trim() || '';
}

function isCheckedBlock(block) {
  return /^(?:[-*]|\d+[.)])\s+\[[xX]\]\s+/u.test(String(block ?? '').trimStart());
}

function readJsonRecords(directory) {
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    try {
      records.push(JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8')));
    } catch {
      // Invalid durable records grant no state transition. Dedicated guards
      // remain responsible for reporting malformed evidence.
    }
  }
  return records;
}

export function readTodoReplanRecords(repoRoot) {
  return readJsonRecords(path.join(repoRoot, '.brownie/private/phase-loop/todo-replans')).filter((record) => (
    record?.record_type === 'todo_replan'
    && record?.operation === 'split_parent_into_children'
    && record?.parent_status === 'superseded_by_children'
    && typeof record.parent_todo_id === 'string'
    && Array.isArray(record.generated_child_ids)
  ));
}

export function readTrackedBreakdownReplanRecords(repoRoot) {
  let text;
  try {
    text = fs.readFileSync(path.join(repoRoot, '.brownie/todo-breakdown.md'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const headings = [...text.matchAll(/^##\s+([^\n]+)\n/gmu)].map((match) => ({
    title: match[1].trim(),
    start: match.index,
    contentStart: match.index + match[0].length
  }));
  const records = [];
  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index];
    const repairPrefix = 'TODO-repair-';
    const noEligibleSuffix = ' no-eligible multi-target split';
    const isRepairSection = current.title.startsWith(repairPrefix);
    const isNoEligibleSplitSection = current.title.endsWith(noEligibleSuffix);
    if (!isRepairSection && !isNoEligibleSplitSection) {
      continue;
    }
    const parentTodoId = isRepairSection
      ? current.title.slice(repairPrefix.length).trim()
      : current.title.slice(0, -noEligibleSuffix.length).trim();
    const section = text.slice(current.contentStart, headings[index + 1]?.start ?? text.length);
    const lines = section.split('\n');
    const childListLabel = isRepairSection ? 'Dependency graph:' : 'Targets:';
    const graphStart = lines.findIndex((line) => line.trim() === childListLabel);
    const childIds = [];
    if (graphStart >= 0) {
      for (const line of lines.slice(graphStart + 1)) {
        if (!line.trim()) {
          continue;
        }
        const match = line.match(/^-\s+([A-Za-z][A-Za-z0-9_.-]*):\s*/u);
        if (!match) {
          break;
        }
        const childId = match[1].trim();
        if (childId !== parentTodoId && !childIds.includes(childId)) {
          childIds.push(childId);
        }
      }
    }
    if (!parentTodoId || childIds.length === 0) {
      continue;
    }
    records.push({
      schema_version: 1,
      record_type: 'todo_replan',
      operation: 'split_parent_into_children',
      parent_status: 'superseded_by_children',
      parent_todo_id: parentTodoId,
      generated_child_ids: childIds,
      generated_leaf_ids: childIds,
      replan_record_reason: isRepairSection
        ? 'tracked_todo_breakdown_repair_section'
        : 'tracked_todo_breakdown_no_eligible_split_section'
    });
  }
  return records;
}

export function readAllTodoReplanRecords(repoRoot) {
  return [
    ...readTodoReplanRecords(repoRoot),
    ...readTrackedBreakdownReplanRecords(repoRoot)
  ];
}

export function readTodoCompletionRecords(repoRoot) {
  return readJsonRecords(path.join(repoRoot, '.brownie/private/phase-loop/todo-completions')).filter((record) => (
    typeof record?.selected_todo_id === 'string' && record.selected_todo_id.trim()
  ));
}

export function resolveTodoState({ todoText, replanRecords = [], completionRecords = [] }) {
  const blocks = checkboxBlocks(todoText);
  const knownIds = new Set();
  const liveIds = new Set();
  const checkedIds = new Set();
  for (const block of blocks) {
    const id = todoIdFromBlock(block);
    if (!id) {
      continue;
    }
    knownIds.add(id);
    liveIds.add(id);
    if (isCheckedBlock(block)) {
      checkedIds.add(id);
    }
  }

  const errors = [];
  const warnings = [];
  const supersededIds = new Set();
  const childrenByParent = new Map();
  const parentByChild = new Map();
  const normalizedReplans = [];
  for (const record of replanRecords) {
    const parentId = typeof record?.parent_todo_id === 'string' ? record.parent_todo_id.trim() : '';
    const childIds = Array.isArray(record?.generated_child_ids)
      ? [...new Set(record.generated_child_ids.map((value) => String(value).trim()).filter(Boolean))]
      : [];
    if (record?.parent_status !== 'superseded_by_children' || !parentId || childIds.length === 0) {
      continue;
    }
    supersededIds.add(parentId);
    knownIds.add(parentId);
    if (!childrenByParent.has(parentId)) {
      childrenByParent.set(parentId, new Set());
    }
    for (const childId of childIds) {
      const existingParent = parentByChild.get(childId);
      if (existingParent && existingParent !== parentId) {
        errors.push({
          code: 'todo_child_has_multiple_parents',
          todo_id: childId,
          parent_todo_ids: [existingParent, parentId]
        });
        continue;
      }
      parentByChild.set(childId, parentId);
      childrenByParent.get(parentId).add(childId);
      knownIds.add(childId);
    }
    normalizedReplans.push({ ...record, parent_todo_id: parentId, generated_child_ids: childIds });
  }

  const completedIds = new Set([...checkedIds].filter((id) => !supersededIds.has(id)));
  const invalidatedCompletionRecords = [];
  for (const record of completionRecords) {
    const id = typeof record?.selected_todo_id === 'string' ? record.selected_todo_id.trim() : '';
    if (!id) {
      continue;
    }
    if (record.reason === 'source_parent_completed' || supersededIds.has(id)) {
      invalidatedCompletionRecords.push(record);
      continue;
    }
    completedIds.add(id);
    knownIds.add(id);
  }

  const resolvedIds = new Set(completedIds);
  const resolving = new Set();
  function resolveId(id) {
    if (resolvedIds.has(id)) {
      return true;
    }
    if (!supersededIds.has(id) || resolving.has(id)) {
      return false;
    }
    resolving.add(id);
    const children = [...(childrenByParent.get(id) ?? [])];
    const resolved = children.length > 0 && children.every((childId) => resolveId(childId));
    resolving.delete(id);
    if (resolved) {
      resolvedIds.add(id);
    }
    return resolved;
  }
  for (const id of supersededIds) {
    resolveId(id);
  }

  for (const [parentId, children] of childrenByParent) {
    for (const childId of children) {
      if (!liveIds.has(childId) && !completedIds.has(childId) && !supersededIds.has(childId)) {
        warnings.push({
          code: 'superseded_parent_child_has_no_live_or_terminal_state',
          parent_todo_id: parentId,
          child_todo_id: childId
        });
      }
    }
  }

  return {
    knownIds,
    liveIds,
    checkedIds,
    completedIds,
    supersededIds,
    resolvedIds,
    childrenByParent,
    parentByChild,
    replanRecords: normalizedReplans,
    completionRecords,
    invalidatedCompletionRecords,
    warnings,
    errors
  };
}

export function loadTodoState(repoRoot, todoText, options = {}) {
  return resolveTodoState({
    todoText,
    replanRecords: [
      ...readAllTodoReplanRecords(repoRoot),
      ...(options.additionalReplanRecords ?? [])
    ],
    completionRecords: readTodoCompletionRecords(repoRoot)
  });
}

export function todoStateSummary(state) {
  return {
    completed_todo_ids: [...state.completedIds].sort(),
    superseded_todo_ids: [...state.supersededIds].sort(),
    resolved_todo_ids: [...state.resolvedIds].sort(),
    invalidated_completion_record_count: state.invalidatedCompletionRecords.length,
    warnings: state.warnings,
    errors: state.errors
  };
}
