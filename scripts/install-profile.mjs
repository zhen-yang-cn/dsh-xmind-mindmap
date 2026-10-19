// Install / verify / restore this bundle in a local DSH profile. This is the
// portable, dependency-free installer used when the profile has no plugin
// manager tool: it edits only the profile manifest, links (or copies) the
// package into the profile's node_modules, and keeps a timestamped backup.
//
//   node scripts/install-profile.mjs verify
//   node scripts/install-profile.mjs status
//   node scripts/install-profile.mjs apply  [--profile-dir <path>] [--profile <name>]
//   node scripts/install-profile.mjs restore [backup-dir] [--profile-dir <path>] [--profile <name>]
//   node scripts/install-profile.mjs uninstall [--profile-dir <path>]
//
// Profile resolution order: --profile-dir, $DSH_PROFILE_DIR, $DSH_HOME/profiles/<name>,
// ~/.dsh/profiles/<name> (name defaults to $DSH_PROFILE then "desktop").
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, lstatSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_NAME = 'dsh-xmind-mindmap';
const REQUIRED_FILES = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'locale/zh.json',
  'locale/en.json',
  'icon.svg',
  'lib/tools.js',
  'lib/define-tool.js',
  'lib/tree.js',
  'lib/markdown.js',
  'lib/xmind.js',
  'lib/zip.js',
  'lib/xml.js',
  'lib/fsio.js',
  'lib/mermaid.js',
];

const argv = process.argv.slice(2);
const command = argv[0] ?? 'status';

function option(name) {
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === name) return argv[index + 1];
    if (token.startsWith(`${name}=`)) return token.slice(name.length + 1);
  }
  return undefined;
}

function positional() {
  const out = [];
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      if (!token.includes('=')) index += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

function defaultProfileDir() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR;
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const name = option('--profile') || process.env.DSH_PROFILE || 'desktop';
  return join(home, 'profiles', name);
}

const PROFILE_DIR = resolve(option('--profile-dir') || defaultProfileDir());
const MANIFEST = join(PROFILE_DIR, 'package.json');
const LINK = join(PROFILE_DIR, 'node_modules', PACKAGE_NAME);
const BACKUP_ROOT = join(PROFILE_DIR, '.dsh-xmind-mindmap-backups');
const LEGACY_BACKUP_ROOT = join(PLUGIN_DIR, '.install');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function isLink(path) {
  if (!existsSync(path)) return false;
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function backups() {
  const found = [];
  for (const root of [BACKUP_ROOT, LEGACY_BACKUP_ROOT]) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      if (!name.startsWith('backup-')) continue;
      const dir = join(root, name);
      if (existsSync(join(dir, 'package.json'))) found.push(dir);
    }
  }
  return found.sort().reverse();
}

function currentState() {
  const manifest = readJson(MANIFEST);
  return {
    profile: PROFILE_DIR,
    manifest,
    linked: isLink(LINK),
    linkTarget: isLink(LINK) ? resolve(LINK) : null,
    inBundles: (manifest.dsh?.profile?.bundles ?? []).includes(PACKAGE_NAME),
    inDeps: Object.hasOwn(manifest.dependencies ?? {}, PACKAGE_NAME),
  };
}

function verify() {
  const problems = [];
  for (const file of REQUIRED_FILES) {
    if (!existsSync(join(PLUGIN_DIR, file))) problems.push(`missing file: ${file}`);
  }
  let manifest = null;
  try {
    manifest = readJson(join(PLUGIN_DIR, 'package.json'));
  } catch (error) {
    problems.push(`package.json is not valid JSON: ${error.message}`);
  }
  if (manifest) {
    if (manifest.name !== PACKAGE_NAME) problems.push(`unexpected package name: ${manifest.name}`);
    if (!manifest.dsh?.bundle?.patch) problems.push('package.json lacks dsh.bundle.patch');
    if (!manifest.dsh?.client) problems.push('package.json lacks dsh.client');
    if (!manifest.exports?.['.']) problems.push('package.json lacks the "." export');
    if (!manifest.exports?.['./client']) problems.push('package.json lacks the "./client" export');
  }
  const patch = existsSync(join(PLUGIN_DIR, 'cordis.patch.yml'))
    ? readFileSync(join(PLUGIN_DIR, 'cordis.patch.yml'), 'utf8')
    : '';
  if (!patch.includes(PACKAGE_NAME)) problems.push('cordis.patch.yml does not name the package');
  if (problems.length > 0) {
    console.error(JSON.stringify({ ok: false, pluginDir: PLUGIN_DIR, problems }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({
    ok: true,
    pluginDir: PLUGIN_DIR,
    name: manifest.name,
    version: manifest.version,
    bundlePatch: manifest.dsh.bundle.patch,
    clientExport: manifest.exports['./client'],
  }, null, 2));
}

function status() {
  const state = currentState();
  console.log(JSON.stringify({
    packageName: PACKAGE_NAME,
    pluginDir: PLUGIN_DIR,
    profile: state.profile,
    profileManifest: MANIFEST,
    installed: state.linked && state.inBundles,
    linked: state.linked,
    linkTarget: state.linkTarget,
    inBundles: state.inBundles,
    inDependencies: state.inDeps,
    backups: backups().slice(0, 10),
  }, null, 2));
}

function apply() {
  verify();
  if (!existsSync(MANIFEST)) throw new Error(`profile manifest not found: ${MANIFEST}`);
  const state = currentState();
  if (state.inBundles && state.linked) {
    console.log(`[install] ${PACKAGE_NAME} already installed in ${PROFILE_DIR}`);
    return;
  }
  mkdirSync(BACKUP_ROOT, { recursive: true });
  const backupDir = join(BACKUP_ROOT, `backup-${timestamp()}`);
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, 'package.json'), readFileSync(MANIFEST));
  writeFileSync(join(backupDir, 'state.json'), `${JSON.stringify({
    createdAt: new Date().toISOString(),
    profile: PROFILE_DIR,
    linkExisted: state.linked,
    linkTarget: state.linkTarget,
    packages: [PACKAGE_NAME],
  }, null, 2)}\n`, 'utf8');

  const modules = join(PROFILE_DIR, 'node_modules');
  if (!existsSync(modules)) throw new Error(`profile node_modules missing: ${modules}`);
  if (existsSync(LINK) && !state.linked) throw new Error(`refusing to replace a real directory at ${LINK}`);
  if (!existsSync(LINK)) {
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(PLUGIN_DIR, LINK, type);
  }
  const installedManifest = readJson(join(LINK, 'package.json'));
  if (installedManifest.name !== PACKAGE_NAME) throw new Error(`link resolves to a different package: ${installedManifest.name}`);

  const manifest = state.manifest;
  manifest.dependencies = manifest.dependencies ?? {};
  manifest.dependencies[PACKAGE_NAME] = `link:${PLUGIN_DIR.replaceAll('\\', '/')}`;
  manifest.dsh = manifest.dsh ?? {};
  manifest.dsh.profile = manifest.dsh.profile ?? {};
  const bundles = manifest.dsh.profile.bundles ?? [];
  if (!bundles.includes(PACKAGE_NAME)) bundles.push(PACKAGE_NAME);
  manifest.dsh.profile.bundles = bundles;
  writeJsonAtomic(MANIFEST, manifest);

  console.log(JSON.stringify({
    installed: PACKAGE_NAME,
    profile: PROFILE_DIR,
    link: LINK,
    bundleIndex: bundles.indexOf(PACKAGE_NAME),
    backupDir,
    restartRequired: true,
    restore: `node "${join(PLUGIN_DIR, 'scripts', 'install-profile.mjs')}" restore "${backupDir}" --profile-dir "${PROFILE_DIR}"`,
  }, null, 2));
  console.log('[install] Restart DeepSeek Harness once so the bundle and its tools load, then open a .xmind file.');
}

function restore(explicitDir) {
  const candidates = explicitDir ? [resolve(explicitDir)] : backups();
  const backupDir = candidates[0];
  if (!backupDir || !existsSync(join(backupDir, 'package.json'))) throw new Error('no backup found to restore');
  if (existsSync(LINK)) {
    if (!isLink(LINK)) throw new Error(`refusing to remove a real directory at ${LINK}`);
    rmSync(LINK, { recursive: false, force: true });
  }
  writeFileSync(MANIFEST, readFileSync(join(backupDir, 'package.json')));
  console.log(JSON.stringify({ restored: PROFILE_DIR, from: backupDir, linkRemoved: true, restartRequired: true }, null, 2));
}

function uninstall() {
  const state = currentState();
  if (existsSync(LINK) && isLink(LINK)) rmSync(LINK, { recursive: false, force: true });
  if (state.inBundles || state.inDeps) {
    const manifest = state.manifest;
    if (manifest.dependencies) delete manifest.dependencies[PACKAGE_NAME];
    const bundles = manifest.dsh?.profile?.bundles ?? [];
    manifest.dsh.profile.bundles = bundles.filter((name) => name !== PACKAGE_NAME);
    writeJsonAtomic(MANIFEST, manifest);
  }
  console.log(JSON.stringify({ uninstalled: PACKAGE_NAME, profile: PROFILE_DIR, restartRequired: true }, null, 2));
}

try {
  if (command === 'verify') verify();
  else if (command === 'status') status();
  else if (command === 'apply' || command === 'install') apply();
  else if (command === 'restore') restore(positional()[0]);
  else if (command === 'uninstall' || command === 'remove') uninstall();
  else throw new Error(`unknown command: ${command} (expected verify|status|apply|restore|uninstall)`);
} catch (error) {
  console.error(`[install] ${error.message}`);
  process.exitCode = 1;
}
