import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const approvedControllerSourcePaths = Object.freeze([
  'phase-loop.sh',
  'scripts/phase-loop-preclaim-recovery.mjs',
  'scripts/phase-loop-supervisor-control.mjs',
  'scripts/phase-loop-task-ledger.mjs',
  'scripts/phase-loop-todo-evaluator.mjs',
  'scripts/phase-loop-source-baseline-guard.mjs'
]);

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readBaselineFile(repoRoot, baselineRef, relativePath) {
  return execFileSync('git', ['-C', repoRoot, 'show', '--format=', `${baselineRef}:${relativePath}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

export function inspectPhaseLoopSourceBaseline({ repoRoot = repositoryRoot, baselineRef = 'origin/main' } = {}) {
  const errors = [];
  let currentHead = '';
  let baselineCommit = '';
  try {
    currentHead = git(repoRoot, ['rev-parse', 'HEAD']);
  } catch (error) {
    errors.push(`controller source HEAD could not be resolved: ${error.message}`);
  }
  try {
    baselineCommit = git(repoRoot, ['rev-parse', '--verify', `${baselineRef}^{commit}`]);
  } catch (error) {
    errors.push(`approved controller baseline ${baselineRef} could not be resolved: ${error.message}`);
  }

  const files = [];
  for (const relativePath of approvedControllerSourcePaths) {
    const currentPath = path.join(repoRoot, relativePath);
    let currentText;
    try {
      currentText = fs.readFileSync(currentPath);
    } catch (error) {
      errors.push(`${relativePath} current controller source could not be read: ${error.message}`);
      continue;
    }
    let baselineText;
    try {
      baselineText = readBaselineFile(repoRoot, baselineRef, relativePath);
    } catch (error) {
      errors.push(`${relativePath} approved baseline source could not be read from ${baselineRef}: ${error.message}`);
      continue;
    }
    const currentSha256 = sha256(currentText);
    const baselineSha256 = sha256(baselineText);
    const matches = currentSha256 === baselineSha256;
    files.push({ relative_path: relativePath, current_sha256: currentSha256, baseline_sha256: baselineSha256, matches });
    if (!matches) {
      errors.push(`${relativePath} diverges from approved controller baseline ${baselineRef}`);
    }
  }

  const sourceFingerprint = sha256(JSON.stringify(files.map((file) => [file.relative_path, file.current_sha256])));
  return { baseline_ref: baselineRef, baseline_commit: baselineCommit, current_head: currentHead, source_fingerprint: `sha256:${sourceFingerprint}`, files, errors };
}

export function guardPhaseLoopSourceBaseline(options = {}) {
  const result = inspectPhaseLoopSourceBaseline(options);
  return { ...result, ok: result.errors.length === 0 };
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  const repoRoot = process.argv.includes('--repo') ? process.argv[process.argv.indexOf('--repo') + 1] : repositoryRoot;
  const baselineRef = process.argv.includes('--baseline-ref')
    ? process.argv[process.argv.indexOf('--baseline-ref') + 1]
    : 'origin/main';
  const result = guardPhaseLoopSourceBaseline({ repoRoot, baselineRef });
  if (!result.ok) {
    console.error('Phase-loop source baseline guard failed:');
    for (const error of result.errors) console.error(`- ${error}`);
    process.exit(78);
  }
  console.log(JSON.stringify({ baseline_ref: result.baseline_ref, baseline_commit: result.baseline_commit, current_head: result.current_head, source_fingerprint: result.source_fingerprint }));
}
