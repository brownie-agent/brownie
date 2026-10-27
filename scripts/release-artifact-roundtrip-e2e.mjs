import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testPath = path.join(repoRoot, 'scripts', 'release-artifact-roundtrip-e2e.test.mjs');

export function runReleaseArtifactRoundtrip(options = {}) {
  const result = spawnSync(process.execPath, ['--test', testPath], {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: options.stdio ?? 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`release artifact roundtrip test failed with status ${String(result.status)}`);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runReleaseArtifactRoundtrip();
}
