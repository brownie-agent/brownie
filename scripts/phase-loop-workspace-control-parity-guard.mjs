#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultControlRoot = path.resolve(scriptDirectory, '..');

function sha256(buffer) {
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

function readControlPlanePaths(controlRoot) {
  const manifestPath = path.join(controlRoot, 'scripts/phase-loop-controller-source-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.control_plane_paths) || manifest.control_plane_paths.length === 0) {
    throw new Error('control-plane manifest must contain a non-empty control_plane_paths array');
  }
  if (manifest.control_plane_paths.some((entry) => typeof entry !== 'string' || !entry || entry.startsWith('/') || entry.includes('..'))) {
    throw new Error('control-plane manifest contains an unsafe relative path');
  }
  return [...new Set(manifest.control_plane_paths)].sort();
}

export function inspectWorkspaceControlParity({ controlRoot = defaultControlRoot, workspaceRoot } = {}) {
  const errors = [];
  const resolvedControlRoot = path.resolve(controlRoot);
  const resolvedWorkspaceRoot = workspaceRoot ? path.resolve(workspaceRoot) : null;
  if (!resolvedWorkspaceRoot) {
    return { ok: false, errors: ['workspace root is required'], files: [] };
  }

  let controlPlanePaths = [];
  try {
    controlPlanePaths = readControlPlanePaths(resolvedControlRoot);
  } catch (error) {
    errors.push(`control-plane manifest is unreadable: ${error.message}`);
  }

  const files = controlPlanePaths.map((relativePath) => {
    const controlPath = path.join(resolvedControlRoot, relativePath);
    const workspacePath = path.join(resolvedWorkspaceRoot, relativePath);
    let control = null;
    let workspace = null;
    try { control = fs.readFileSync(controlPath); } catch (error) { errors.push(`${relativePath} control-plane source is unreadable: ${error.message}`); }
    try { workspace = fs.readFileSync(workspacePath); } catch (error) { errors.push(`${relativePath} workspace control-plane source is unavailable: ${error.message}`); }
    const controlSha256 = control ? sha256(control) : null;
    const workspaceSha256 = workspace ? sha256(workspace) : null;
    const matches = controlSha256 !== null && controlSha256 === workspaceSha256;
    if (!matches && controlSha256 !== null && workspaceSha256 !== null) {
      errors.push(`${relativePath} workspace control-plane source diverges from approved controller source`);
    }
    return { relative_path: relativePath, control_sha256: controlSha256, workspace_sha256: workspaceSha256, matches };
  });

  return { ok: errors.length === 0, schema_version: 1, control_root: resolvedControlRoot, workspace_root: resolvedWorkspaceRoot, files, errors };
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  const argv = process.argv.slice(2);
  const controlIndex = argv.indexOf('--control-root');
  const workspaceIndex = argv.indexOf('--workspace-root');
  const result = inspectWorkspaceControlParity({
    controlRoot: controlIndex >= 0 ? argv[controlIndex + 1] : defaultControlRoot,
    workspaceRoot: workspaceIndex >= 0 ? argv[workspaceIndex + 1] : undefined
  });
  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(78);
  }
  console.log(JSON.stringify(result));
}
