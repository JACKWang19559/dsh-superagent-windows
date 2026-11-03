/** Smoke-check generated ESM entries with their actual production dependencies; do not activate a plugin. */
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TESTED_PEERS } from './prepare-windows-bundle.mjs';

export async function checkBundleImports(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.peerDependencies, TESTED_PEERS);
  for (const [name, version] of Object.entries({ ...manifest.dependencies, ...TESTED_PEERS })) {
    // Read the bundle's own dependency link explicitly. ESM import alone could
    // fall back to the source checkout's older peers in an ancestor node_modules.
    let local;
    try { local = JSON.parse(await readFile(join(directory, 'node_modules', name, 'package.json'), 'utf8')); }
    catch (error) { throw new Error(`Missing local runtime dependency ${name}; install the generated bundle's production dependencies.`, { cause: error }); }
    assert.equal(local.name, name);
    assert.equal(local.version, version, `Installed version of ${name}`);
  }
  for (const name of ['index.js', 'github-watch.js', 'feishu-watch.js']) {
    const entry = await import(pathToFileURL(join(directory, 'lib', name)).href);
    assert.equal(typeof entry.apply, 'function', `${name} must export apply`);
    if (name === 'index.js') {
      const stateDir = join(tmpdir(), 'superagent-schema-smoke');
      assert.equal(entry.Config({ stateDir }).stateDir, stateDir);
    }
  }
  assert.ok((await stat(join(directory, 'lib', 'client.js'))).size > 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const directory = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../.artifacts/windows-bundle/', import.meta.url));
    await checkBundleImports(directory);
    console.log('Bundle ESM imports and native stateDir validation passed with the installed runtime peers.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
