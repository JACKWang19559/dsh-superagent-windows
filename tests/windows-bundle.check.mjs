import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { prepareWindowsBundle, SOURCE_DIRECTORY, TESTED_PEERS } from '../scripts/prepare-windows-bundle.mjs';
import { checkBundleImports } from '../scripts/check-bundle-import.mjs';

async function fixture(t, { missingClient = false, duplicateRow = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'superagent-bundle-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('superagent-bundle-'));
    await rm(root, { recursive: true, force: true });
  });
  const source = join(root, 'source 项目');
  await mkdir(source);
  for (const path of ['lib', 'prompts', 'skills', 'locale', 'node_modules', '.git', '.superagent-state']) await mkdir(join(source, path));
  for (const name of ['index.js', 'github-watch.js', 'feishu-watch.js', ...missingClient ? [] : ['client.js']]) {
    await writeFile(join(source, 'lib', name), 'export {};\n');
  }
  for (const name of ['package.json', 'LICENSE', 'README.md']) await cp(join(SOURCE_DIRECTORY, name), join(source, name));
  await cp(join(SOURCE_DIRECTORY, 'packaging'), join(source, 'packaging'), { recursive: true });
  const row = '- insert:\n    - id: dsh-superagent\n      name: dsh-superagent\n';
  await writeFile(join(source, 'cordis.patch.yml'), (duplicateRow ? row + row : row).replaceAll('\n', '\r\n'));
  await writeFile(join(source, '.env'), 'DUMMY_TEST_ONLY=not-a-credential\n');
  await writeFile(join(source, '.superagent-state', 'example.sqlite'), 'test fixture only');
  return { root, source, target: join(root, 'output 安装包'), state: join(root, 'state # data') };
}

test('prepares a CRLF checkout with Unicode paths, metadata and runtime peers without copying local state', async t => {
  const { source, target, state } = await fixture(t);
  const result = await prepareWindowsBundle({ sourceDir: source, outputDir: target, stateDir: state });
  assert.equal(result.runtimeDependenciesInstalled, false);
  const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.peerDependencies, TESTED_PEERS);
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(manifest.license, 'MIT');
  assert.equal(await readFile(join(target, 'LICENSE'), 'utf8'), await readFile(join(source, 'LICENSE'), 'utf8'));
  const patch = await readFile(join(target, 'cordis.patch.yml'), 'utf8');
  assert.equal(JSON.parse(patch.match(/stateDir: (.+)/)[1]), state.replaceAll('\\', '/'));
  for (const name of ['github-watch', 'feishu-watch']) {
    assert.ok((await stat(join(target, manifest.exports[`./${name}/icon`]))).isFile());
    for (const locale of ['en', 'zh']) {
      const metadata = JSON.parse(await readFile(join(target, 'locale', name, `${locale}.json`), 'utf8'));
      assert.ok(metadata.meta.title && metadata.meta.description);
    }
  }
  const files = await readdir(target);
  for (const excluded of ['node_modules', '.env', '.git', '.superagent-state']) assert.ok(!files.includes(excluded), excluded);
});

test('does not certify a bundle whose local runtime peers have not been installed', async t => {
  const { source, target, state } = await fixture(t);
  await prepareWindowsBundle({ sourceDir: source, outputDir: target, stateDir: state });
  await assert.rejects(checkBundleImports(target), /Missing local runtime dependency/);
  const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    await mkdir(join(target, 'node_modules', name), { recursive: true });
    await writeFile(join(target, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
  }
  await assert.rejects(checkBundleImports(target), /Missing local runtime dependency @deepseek-ai\/cordis/);
});

test('refuses to overwrite an existing output and preserves its contents', async t => {
  const { source, target, state } = await fixture(t);
  await mkdir(target);
  await writeFile(join(target, 'keep.txt'), 'existing installation');
  await assert.rejects(prepareWindowsBundle({ sourceDir: source, outputDir: target, stateDir: state }), /Refusing to overwrite/);
  assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'existing installation');
});

test('rejects relative state paths and output/state layouts that would mix installation with data', async t => {
  const { source, target, state } = await fixture(t);
  await assert.rejects(prepareWindowsBundle({ sourceDir: source, outputDir: target, stateDir: 'relative' }), /absolute/);
  await assert.rejects(prepareWindowsBundle({ sourceDir: source, outputDir: source, stateDir: state }), /source directory/);
  await assert.rejects(prepareWindowsBundle({ sourceDir: source, outputDir: join(source, 'lib', 'nested'), stateDir: state }), /copied resource/);
  await assert.rejects(prepareWindowsBundle({ sourceDir: source, outputDir: target, stateDir: join(target, 'state') }), /state directory outside/);
  assert.equal(await stat(target).catch(() => null), null);
});

test('fails before creating output when a required build artifact is missing', async t => {
  const { source, target, state } = await fixture(t, { missingClient: true });
  await assert.rejects(prepareWindowsBundle({ sourceDir: source, outputDir: target, stateDir: state }), /Missing lib\/client.js/);
  assert.equal(await stat(target).catch(() => null), null);
});

test('refuses an ambiguous patch before creating output', async t => {
  const { source, target, state } = await fixture(t, { duplicateRow: true });
  await assert.rejects(prepareWindowsBundle({ sourceDir: source, outputDir: target, stateDir: state }), /exactly one/);
  assert.equal(await stat(target).catch(() => null), null);
});
