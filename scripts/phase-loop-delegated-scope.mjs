#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundedScopes } from './phase-loop-bounded-scope.mjs';

function git(root, args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
function digest(file) { return fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null; }
function targets(objective) {
  return [...new Set(boundedScopes(String(objective ?? '').split('\n')[0] ?? ''))]
    .filter((value) => value && !value.includes('..') && !path.isAbsolute(value));
}
function tracked(root) { return git(root, ['ls-files', '-z']).split('\0').filter(Boolean); }
function capture(root, backup, objective) {
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  const paths = tracked(root);
  const manifest = { schema_version: 1, declared_targets: targets(objective), files: {} };
  for (const relative of paths) {
    const source = path.join(root, relative);
    manifest.files[relative] = digest(source);
    const destination = path.join(backup, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  fs.writeFileSync(path.join(backup, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}
export function enforceDelegatedScope({ workspaceRoot, backupRoot, objective }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, 'manifest.json'), 'utf8'));
  const declared = new Set(manifest.declared_targets);
  const changed = [];
  for (const relative of Object.keys(manifest.files)) if (digest(path.join(workspaceRoot, relative)) !== manifest.files[relative]) changed.push(relative);
  for (const relative of tracked(workspaceRoot)) if (!(relative in manifest.files)) changed.push(relative);
  const forbidden = changed.filter((relative) => !declared.has(relative));
  const restored = [];
  for (const relative of forbidden) {
    const source = path.join(backupRoot, relative);
    const destination = path.join(workspaceRoot, relative);
    if (fs.existsSync(source)) { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination); }
    else fs.rmSync(destination, { force: true });
    restored.push(relative);
  }
  return { valid: forbidden.length === 0, changed, declared_targets: [...declared], forbidden, restored, evidence: 'tracked-file-scope-rollback' };
}
function main(argv) {
  const args = Object.fromEntries(argv.map((value, index) => value.startsWith('--') ? [value.slice(2), argv[index + 1]] : []).filter((entry) => entry.length));
  if (args.capture) return capture(args.workspace, args.backup, args.objective);
  const result = enforceDelegatedScope({ workspaceRoot: args.workspace, backupRoot: args.backup, objective: args.objective });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exit(76);
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
