#!/usr/bin/env node
/** Verify the actual distributable, never a dry-run file list. No Host or
 * provider is started. Only our mkdtemp directory is written and removed. */
import { execFileSync } from 'node:child_process';
import { isIP } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const maxArchiveBytes = 64 * 1024 * 1024;
const requiredFiles = [
  'package.json', 'LICENSE', 'README.md', 'README.zh.md', 'cordis.patch.yml',
  'bin/oh-my-harness.mjs', 'bin/verify-dsh-app.mjs', 'bin/verify-package.mjs',
  'config/default.json', 'config/providers.example.json', 'deploy/Caddyfile.example', 'deploy/nginx.conf.example',
  'src/http.mjs', 'src/stdio.mjs', 'src/config.mjs', 'src/capabilities/media.mjs',
  'docs/architecture.md', 'docs/architecture.json', 'docs/architecture.png', 'docs/capabilities.md', 'docs/dsh-integration.md', 'docs/verification/dsh-0.2.2-rc.3.md',
  ...['index.mjs', 'host-entry.mjs', 'backend.mjs', 'files.mjs', 'tools.mjs', 'audio-preview-core.mjs', 'build-client.mjs', 'client.js', 'icon.svg', 'locale/en.json', 'locale/zh.json']
    .map((file) => `extensions/dsh-capabilities/${file}`),
  ...['package.json', 'cordis.patch.yml', 'LICENSE', 'index.mjs', 'resample.mjs', 'client.js', 'icon.svg', 'locale/en.json', 'locale/zh.json']
    .map((file) => `extensions/dsh-voice-input/${file}`),
  'extensions/dsh-native/release.mjs', 'extensions/dsh-native/host-loader.mjs',
  ...['package.json', 'plugin.mjs', 'native-images.mjs', 'native-search.mjs', 'transport.mjs', 'baseline.mjs', 'build-adapter.mjs', 'build-release.mjs', 'adapter-patch.mjs', 'paths.mjs', 'vendor/LICENSE']
    .map((file) => `extensions/dsh-native-codex/${file}`),
  'extensions/skill-source-management/manage.py',
  ...['__init__.py', '__main__.py', 'cli.py', 'core.py', 'clients.py', 'errors.py', 'filesystem.py', 'metadata.py', 'packages.py']
    .map((file) => `extensions/skill-source-management/skill_source_management/${file}`),
  'extensions/skill-source-management/README.md', 'extensions/skill-source-management/README.zh.md',
];
const fail = (message) => { throw new Error(`Package verification: ${message}`); };

function safeName(name) {
  if (!name || /[\\\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || /^[A-Za-z]:/.test(name) ||
      name.split('/').some((part) => !part || part === '.' || part === '..')) fail('unsafe archive path');
  return name;
}

/** npm pack uses portable ustar regular files. Fail closed on links, PAX/GNU
 * extension headers or other formats rather than trusting tar's overrides. */
export function inspectArchive(archive) {
  const tar = gunzipSync(archive, { maxOutputLength: maxArchiveBytes });
  const files = new Map(), names = new Set();
  const text = (start, size) => tar.subarray(start, start + size).toString('utf8').split('\0')[0];
  const octal = (start, size) => {
    const value = text(start, size).trim();
    if (!/^[0-7]+$/.test(value)) fail('invalid archive number');
    const result = parseInt(value, 8);
    if (!Number.isSafeInteger(result)) fail('invalid archive number');
    return result;
  };
  let offset = 0, ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (tar.length - offset < 1024 || !tar.subarray(offset).every((byte) => byte === 0)) fail('invalid archive terminator');
      ended = true; break;
    }
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== octal(offset + 148, 8)) fail('archive checksum mismatch');
    if (text(offset + 257, 6) !== 'ustar') fail('unsupported archive format');
    const type = String.fromCharCode(header[156]);
    if (!['0', '\0', '5'].includes(type) || text(offset + 157, 100)) fail('archive links or special entries are forbidden');
    const size = octal(offset + 124, 12);
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > tar.length || (type === '5' && size !== 0)) fail('truncated or invalid archive entry');
    const prefix = text(offset + 345, 155);
    const rawName = (prefix ? prefix + '/' : '') + text(offset, 100);
    const name = safeName(type === '5' ? rawName.replace(/\/$/, '') : rawName);
    if (name !== 'package' && !name.startsWith('package/')) fail('entry outside package root');
    if (names.has(name)) fail('duplicate archive entry');
    names.add(name);
    if (type !== '5') {
      if (name === 'package') fail('package root is not a directory');
      files.set(name.slice('package/'.length), Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
    }
    offset = next;
  }
  if (!ended || files.size === 0) fail('empty or unterminated archive');
  for (const name of names) {
    let parent = path.posix.dirname(name);
    while (parent !== '.') {
      if (files.has(parent.slice('package/'.length))) fail('file/directory archive collision');
      parent = path.posix.dirname(parent);
    }
  }
  return files;
}

function checkDistributedText(name, bytes) {
  // Binary architecture media is not text; all other shipped source/assets are.
  if (/\.(?:png|jpe?g|webp|gif|ico)$/i.test(name)) return;
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // Synthetic placeholders are not personal home directories.
  if (/(?:\/Users\/|\/home\/|[A-Z]:[\\/]Users[\\/])(?!user(?:[\\/])|example(?:[\\/])|runner(?:[\\/])|u(?:[\\/]))[\w.-]+[\\/]/i.test(text)) fail(`personal filesystem path in ${name}`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,})\b|\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/.test(text)) fail(`credential signature in ${name}`);
  for (const match of text.matchAll(/https?:\/\/[^\s'"`<>()[\]{}]+/g)) {
    let url; try { url = new URL(match[0]); } catch { continue; } // Dynamic URL templates are source, not configured endpoints.
    const host = url.hostname.toLowerCase();
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(host);
    const example = host === 'example.com' || host.endsWith('.example.com') || host.endsWith('.example');
    // This exact negative fixture tests the public-page SSRF guard.
    if (name === 'test/protocol-provider.test.mjs' && match[0] === 'https://' + 'local.internal/') continue;
    if (name === 'extensions/dsh-native-codex/native-search.test.mjs' && host === 'example.com' && url.username === 'user' && url.password === 'password' && url.pathname === '/' && !url.search && !url.hash) continue;
    if (url.username || url.password || [...url.searchParams.keys()].some((key) => /^(?:api[_-]?key|token|secret|access_token)$/i.test(key)) ||
        (!loopback && !example && (isIP(host.replace(/^\[|\]$/g, '')) || /(?:\.internal|\.local|\.lan)$/.test(host)))) fail(`private endpoint in ${name}`);
  }
}

function requireFile(files, name) {
  safeName(name);
  if (!files.has(name) || files.get(name).length === 0) fail(`missing required file: ${name}`);
}

function checkExports(files, manifest, base = '') {
  const visit = (value) => {
    if (typeof value === 'string') {
      if (!value.startsWith('./')) fail('non-relative package export');
      const target = base + value.slice(2);
      if (!target.includes('*')) requireFile(files, target);
      else {
        if (target.split('*').length !== 2) fail('unsupported export wildcard');
        const [before, after] = target.split('*');
        if (![...files.keys()].some((name) => name.startsWith(before) && name.endsWith(after))) fail(`missing export wildcard: ${target}`);
      }
    } else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    else if (value !== null) fail('invalid package export');
  };
  if (!manifest.exports) fail('missing package exports');
  visit(manifest.exports);
}

/** Check only literal relative imports of ready-to-consume modules. This is not
 * a JS resolver/framework: bare Host/npm imports and the separately generated
 * Native Codex SDK release remain their respective owners' prerequisites. */
export function requiredRelativeModuleClosure(files, roots) {
  const visited = new Set();
  const visit = (name) => {
    requireFile(files, name);
    if (visited.has(name) || !/\.[cm]?js$/.test(name)) return;
    visited.add(name);
    const source = files.get(name).toString('utf8');
    const literals = /(?:\b(?:import|export)\s+(?:[^;]*?\s+from\s*)?|\b(?:import|require)\s*\(\s*)['"](\.[^'"]+)['"]/g;
    for (const match of source.matchAll(literals)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]));
      safeName(target); visit(target);
    }
  };
  roots.forEach(visit);
  return visited.size;
}

export function validatePackageFiles(files) {
  for (const [name, bytes] of files) {
    safeName(name);
    if (name.split('/').some((part) => /^(?:\.git|\.state|\.dsh|\.codex|\.agents|\.claude|\.ssh|node_modules|__pycache__|sessions?|receipts?|backups?|logs?)$/i.test(part)) ||
        /^(?:\.env(?:\..*)?|\.npmrc|credentials?(?:\..*)?|secrets?(?:\..*)?|auth\.json|runtime-status\.json|USER_PROFILE\.md|AGENTS\.md)$/i.test(path.posix.basename(name)) ||
        /\.(?:key|pem|p12|pfx|tgz|log|pyc)$/i.test(name)) fail(`private state or credential filename: ${name}`);
    checkDistributedText(name, bytes);
  }
  requiredFiles.forEach((name) => requireFile(files, name));
  const manifest = JSON.parse(files.get('package.json'));
  if (manifest.name !== 'oh-my-harness' || manifest.license !== 'MIT') fail('root package identity/license changed');
  const voiceBase = 'extensions/dsh-voice-input/';
  const voice = JSON.parse(files.get(voiceBase + 'package.json'));
  if (voice.name !== 'oh-my-harness-voice-input' || voice.license !== 'MIT') fail('voice package identity/license changed');
  for (const [pkg, keys] of [
    [manifest, ['.', './capabilities', './capabilities/contracts', './capabilities/protocol', './capabilities/realtime', './dsh', './client', './locale/*.json', './icon', './dsh/locale/*.json', './dsh/icon', './package.json']],
    [voice, ['.', './client', './locale/*.json', './icon']],
  ]) {
    for (const key of keys) if (!pkg.exports?.[key]) fail(`missing required export: ${key}`);
  }
  checkExports(files, manifest); checkExports(files, voice, voiceBase);
  for (const [base, pkg] of [['', manifest], [voiceBase, voice]]) {
    const patch = pkg.dsh?.bundle?.patch;
    if (!patch?.startsWith('./') || pkg.dsh?.client?.platform !== 'web') fail('missing native client/bundle prerequisite');
    requireFile(files, base + patch.slice(2));
  }
  for (const peer of ['@deepseek-ai/dsh-experimental-speech-to-text', '@deepseek-ai/dsh-experimental-api-speech-to-text']) {
    if (!voice.peerDependencies?.[peer]) fail('missing optional voice Host prerequisite');
  }
  for (const name of ['LICENSE', voiceBase + 'LICENSE']) {
    const license = files.get(name).toString('utf8');
    if (!license.includes('MIT License') || !license.includes('Copyright') || !license.includes('Permission is hereby granted')) fail(`invalid license: ${name}`);
  }
  if (files.get('extensions/dsh-native-codex/vendor/LICENSE').length < 100) fail('missing Native upstream license');
  for (const name of ['docs/architecture.json', 'config/default.json', 'config/providers.example.json', 'extensions/dsh-capabilities/locale/en.json', 'extensions/dsh-capabilities/locale/zh.json', voiceBase + 'locale/en.json', voiceBase + 'locale/zh.json']) JSON.parse(files.get(name));
  if (!files.get('docs/architecture.png').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('invalid architecture image');
  return requiredRelativeModuleClosure(files, [
    ...Object.values(manifest.exports).filter((value) => typeof value === 'string' && value.endsWith('.mjs')).map((value) => value.slice(2)),
    'src/http.mjs', 'src/stdio.mjs', 'bin/oh-my-harness.mjs', voiceBase + 'index.mjs',
  ]);
}

export async function verifyPackage({ sourceRoot = fileURLToPath(new URL('../', import.meta.url)) } = {}) {
  sourceRoot = await realpath(sourceRoot);
  const parent = await realpath(tmpdir());
  const owned = await mkdtemp(path.join(parent, 'oh-my-harness-package-'));
  try {
    // npm_execpath from npm run avoids relying on a different npm on PATH.
    const npm = process.env.npm_execpath;
    const args = ['pack', '--ignore-scripts', '--json', '--pack-destination', owned];
    const output = execFileSync(npm ? process.execPath : 'npm', npm ? [npm, ...args] : args,
      { cwd: sourceRoot, encoding: 'utf8', timeout: 120000, maxBuffer: maxArchiveBytes, env: { ...process.env, npm_config_cache: path.join(owned, 'npm-cache'), TMPDIR: owned, TMP: owned, TEMP: owned, NODE_DISABLE_COMPILE_CACHE: '1' } });
    const packs = JSON.parse(output);
    if (packs.length !== 1 || typeof packs[0].filename !== 'string' || !/^[\w.-]+\.tgz$/.test(packs[0].filename)) fail('invalid npm pack result');
    const archivePath = path.join(owned, packs[0].filename);
    if (path.dirname(archivePath) !== owned) fail('pack output escaped owned directory');
    const archive = await readFile(archivePath);
    const files = inspectArchive(archive);
    const closureModules = validatePackageFiles(files);
    const extracted = path.join(owned, 'extracted');
    // All archive paths/types/collisions/privacy and manifest targets were
    // verified above. Write regular files ourselves; never invoke tar extract.
    for (const [name, bytes] of files) {
      const target = path.resolve(extracted, name);
      if (!target.startsWith(extracted + path.sep)) fail('extraction escaped owned directory');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o644 });
    }
    const { build } = await import(pathToFileURL(path.join(extracted, 'extensions/dsh-capabilities/build-client.mjs')));
    if (build() !== files.get('extensions/dsh-capabilities/client.js').toString('utf8')) fail('detached generated client differs from shipped client');
    for (const name of ['src/capabilities/runtime.mjs', 'extensions/dsh-capabilities/index.mjs', 'extensions/dsh-capabilities/client.js', 'extensions/dsh-voice-input/index.mjs', 'extensions/dsh-voice-input/client.js']) {
      execFileSync(process.execPath, ['--check', path.join(extracted, name)], { timeout: 10000, stdio: 'pipe' });
    }
    const manifest = JSON.parse(files.get('package.json'));
    return { name: manifest.name, version: manifest.version, files: files.size, bytes: archive.length, closureModules,
      checks: ['actual tarball', 'safe entries', 'exports/assets/licenses', 'privacy', 'relative module closure', 'detached client build', 'entry syntax'],
      nativeCodex: 'source/recovery/license checked; generated SDK release and Host installation are separate, not executed' };
  } finally {
    // Strict ownership check immediately before recursively deleting anything.
    if (path.dirname(owned) !== parent || !path.basename(owned).startsWith('oh-my-harness-package-') || await realpath(owned) !== owned) fail('refusing cleanup of unowned directory');
    await rm(owned, { recursive: true, force: false });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await verifyPackage(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
