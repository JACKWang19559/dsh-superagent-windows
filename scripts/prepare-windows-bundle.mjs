/** Prepare a local Harness bundle without modifying a Harness profile or installing packages. */
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const SOURCE_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TESTED_PEERS = Object.freeze({
  '@deepseek-ai/cordis': '4.0.5',
  '@deepseek-ai/schemastery': '3.18.5',
  '@deepseek-ai/dsh-llm': '0.2.1-rc.5',
  '@deepseek-ai/dsh-scope': '0.2.1-rc.5',
});
const REQUIRED = ['lib', 'prompts', 'skills', 'locale', 'LICENSE', 'README.md'];
const OPTIONAL = ['docs', 'SETUP.md', 'README.windows.md', 'CHANGELOG.windows.md'];
const ENTRIES = ['index.js', 'client.js', 'on-demand.js', 'github-watch.js', 'feishu-watch.js'];
const DISPLAY_PLUGINS = ['on-demand', 'github-watch', 'feishu-watch'];

export function defaultStateDirectory() {
  return process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'dsh-superagent')
    : join(homedir(), '.local', 'state', 'dsh-superagent');
}
function within(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}
async function exists(path) {
  try { return await stat(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function prepareWindowsBundle({ sourceDir = SOURCE_DIRECTORY, outputDir, stateDir = defaultStateDirectory() } = {}) {
  const source = resolve(sourceDir);
  const target = resolve(outputDir ?? join(source, '.artifacts', 'windows-bundle'));
  if (!isAbsolute(stateDir)) throw new Error('stateDir must be an absolute native filesystem path.');
  const state = resolve(stateDir);
  if (within(target, source)) throw new Error('The output must not be the source directory or one of its ancestors.');
  for (const entry of [...REQUIRED, ...OPTIONAL, 'packaging']) {
    if (within(join(source, entry), target)) throw new Error(`The output must not be inside the copied resource ${entry}.`);
  }
  if (within(target, state)) throw new Error('Keep the state directory outside the installation bundle.');
  if (await exists(target)) throw new Error(`Refusing to overwrite an existing output directory: ${target}. Choose a new --output path.`);
  for (const entry of REQUIRED) {
    if (!await exists(join(source, entry))) throw new Error(`Missing ${entry}; run pnpm build before preparing the bundle.`);
  }
  for (const entry of ENTRIES) {
    if (!(await exists(join(source, 'lib', entry)))?.isFile()) throw new Error(`Missing lib/${entry}; run pnpm build first.`);
  }
  const original = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const patch = (await readFile(join(source, 'cordis.patch.yml'), 'utf8')).replace(/\r\n/g, '\n');
  const needle = '    - id: dsh-superagent\n      name: dsh-superagent\n';
  if (patch.split(needle).length !== 2) throw new Error('Expected exactly one unconfigured dsh-superagent row in cordis.patch.yml.');
  const portableState = state.replaceAll('\\', '/');
  const configuredPatch = patch.replace(needle, needle + `      config:\n        stateDir: ${JSON.stringify(portableState)}\n`)
    .replace(/^# dsh-superagent bundle layer:[\s\S]*?(?=- insert:)/,
      '# Generated Windows Desktop bundle; select Superagent and explicitly start a repository. Cold starts remain idle.\n');
  const assets = join(source, 'packaging', 'windows');
  const icon = await readFile(join(assets, 'icon.svg'), 'utf8');
  const metadata = [];
  for (const name of DISPLAY_PLUGINS) {
    for (const locale of ['en', 'zh']) {
      const text = await readFile(join(assets, 'locale', name, `${locale}.json`), 'utf8');
      const parsed = JSON.parse(text);
      if (!parsed.meta?.title || !parsed.meta?.description) throw new Error(`Incomplete display metadata for ${name}/${locale}.`);
      metadata.push({ name, locale, text });
    }
  }
  const manifest = { ...original,
    description: 'Community Windows Superagent for DeepSeek Harness: view each conversation’s project status, saved Tickets and launch history; explicitly start work with built-in Agents.',
    exports: { ...original.exports, './icon': './icon.svg' },
    files: [...REQUIRED, ...OPTIONAL, 'cordis.patch.yml', 'icon.svg'],
    peerDependencies: { ...TESTED_PEERS },
  };
  // A linked package needs its own bare ESM imports. These peers match the tested
  // Desktop runtime; this is separate from Harness resolving shipped plugin rows.
  delete manifest.devDependencies;
  delete manifest.scripts;
  for (const name of DISPLAY_PLUGINS) {
    manifest.exports[`./${name}/locale/*.json`] = `./locale/${name}/*.json`;
    manifest.exports[`./${name}/icon`] = './icon.svg';
  }
  // Preflight everything before creating output. Never replace a directory that
  // may be linked by a running Harness installation.
  await mkdir(dirname(target), { recursive: true });
  await mkdir(target);
  for (const entry of [...REQUIRED, ...OPTIONAL]) {
    if (await exists(join(source, entry))) await cp(join(source, entry), join(target, entry), { recursive: true, force: false, errorOnExist: true });
  }
  await writeFile(join(target, 'cordis.patch.yml'), configuredPatch);
  await writeFile(join(target, 'icon.svg'), icon);
  for (const { name, locale, text } of metadata) {
    await mkdir(join(target, 'locale', name), { recursive: true });
    await writeFile(join(target, 'locale', name, `${locale}.json`), text);
  }
  await writeFile(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { target, stateDir: portableState, package: manifest.name, version: manifest.version,
    testedDshVersion: '0.2.1-rc.5', runtimeDependenciesInstalled: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      output: { type: 'string', short: 'o' }, 'state-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) {
      console.log('Usage: node scripts/prepare-windows-bundle.mjs [--output <new-directory>] [--state-dir <absolute-path>]\n' +
        'Build with pnpm build first. Then install the generated bundle dependencies with pnpm install --prod --ignore-scripts.\n' +
        'Finally use Harness plugin_manager action=install_bundle with the absolute output directory.');
    } else {
      console.log(JSON.stringify(await prepareWindowsBundle({ outputDir: values.output, stateDir: values['state-dir'] }), null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
