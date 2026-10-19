// Build the distributable package: a folder-rooted .zip (portable) and, when
// `tar` is available, an npm-style .tgz. Both contain the same file set and are
// verified by extracting them afterwards (see README/INSTALL).
//
//   node scripts/build-package.mjs
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { crc32 } from '../lib/zip.js';

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = resolve(PLUGIN_DIR, '..', '..', 'dist');
const PACKAGE = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'));
const ROOT_NAME = PACKAGE.name;
const BASE = `${ROOT_NAME}-${PACKAGE.version}`;

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.install', '.verify', '.shots', 'dist', 'test/.tmp']);
const EXCLUDED_FILES = new Set(['.gitignore', 'package-lock.json', 'pnpm-lock.yaml']);

function collect(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(PLUGIN_DIR, full).replaceAll('\\', '/');
    const stat = statSync(full);
    if (stat.isDirectory()) {
      const isVendorTestNodeModules = rel.startsWith('test/support/vendor/') && name === 'node_modules';
      if (EXCLUDED_DIRS.has(rel) || (name === 'node_modules' && !isVendorTestNodeModules) || name.startsWith('.')) continue;
      collect(full, out);
      continue;
    }
    if (EXCLUDED_FILES.has(name) || name.endsWith('.log') || name.endsWith('.tmp')) continue;
    out.push({ rel, full });
  }
  return out;
}

function dosTime() {
  // 1980-01-01 00:00:00, the ZIP epoch, for deterministic archives.
  return { time: 0, date: 33 };
}

function writeZipArchive(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  const stamp = dosTime();
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const compressed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, compressed);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(stamp.time, 12);
    dir.writeUInt16LE(stamp.date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(compressed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralBuffer, end]);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function formatBytes(bytes) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const files = collect(PLUGIN_DIR, []).sort((a, b) => a.rel.localeCompare(b.rel));
const entries = files.map((file) => ({
  name: `${ROOT_NAME}/${file.rel}`,
  data: readFileSync(file.full),
}));

mkdirSync(DIST_DIR, { recursive: true });
const zipPath = join(DIST_DIR, `${BASE}.zip`);
const zipBuffer = writeZipArchive(entries);
writeFileSync(zipPath, zipBuffer);

// Staging directory for the .tgz (npm-style "package/" is replaced by the real name).
const stagingRoot = join(DIST_DIR, '.staging');
rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(stagingRoot, { recursive: true });
const staged = join(stagingRoot, ROOT_NAME);
for (const file of files) {
  const dest = join(staged, file.rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(file.full, dest);
}

const tgzPath = join(DIST_DIR, `${BASE}.tgz`);
let tgzBuilt = false;
if (process.platform === 'win32' || existsSync('/usr/bin/tar') || existsSync('/bin/tar')) {
  const tar = spawnSync('tar', ['-czf', tgzPath, '-C', stagingRoot, ROOT_NAME], { stdio: 'inherit' });
  tgzBuilt = tar.status === 0 && existsSync(tgzPath);
}
rmSync(stagingRoot, { recursive: true, force: true });

const sums = [`${sha256(zipBuffer)}  ${BASE}.zip`];
if (tgzBuilt) sums.push(`${sha256(readFileSync(tgzPath))}  ${BASE}.tgz`);
writeFileSync(join(DIST_DIR, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`, 'utf8');

const manifest = {
  name: ROOT_NAME,
  version: PACKAGE.version,
  files: files.length,
  zip: { path: zipPath, bytes: zipBuffer.length },
  tgz: tgzBuilt ? { path: tgzPath, bytes: statSync(tgzPath).size } : null,
  sha256: sums,
};
writeFileSync(join(DIST_DIR, `${BASE}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  ok: true,
  name: ROOT_NAME,
  version: PACKAGE.version,
  files: files.length,
  totalUncompressed: formatBytes(files.reduce((sum, file) => sum + statSync(file.full).size, 0)),
  zip: `${zipPath} (${formatBytes(zipBuffer.length)})`,
  tgz: tgzBuilt ? `${tgzPath} (${formatBytes(statSync(tgzPath).size)})` : 'skipped (tar not found)',
  checksums: join(DIST_DIR, 'SHA256SUMS.txt'),
}, null, 2));
