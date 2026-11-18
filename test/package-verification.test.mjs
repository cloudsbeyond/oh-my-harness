import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { inspectArchive, requiredRelativeModuleClosure, validatePackageFiles } from '../bin/verify-package.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let owned, parent, shipped;
before(async () => {
  parent = await realpath(tmpdir());
  owned = await mkdtemp(path.join(parent, 'omh-package-tests-'));
  const args = ['pack', '--ignore-scripts', '--json', '--pack-destination', owned];
  const npm = process.env.npm_execpath;
  const result = JSON.parse(execFileSync(npm ? process.execPath : 'npm', npm ? [npm, ...args] : args,
    { cwd: root, encoding: 'utf8', timeout: 120000, env: { ...process.env, npm_config_cache: path.join(owned, 'npm-cache'), TMPDIR: owned, TMP: owned, TEMP: owned, NODE_DISABLE_COMPILE_CACHE: '1' } }));
  assert.match(result[0].filename, /^[\w.-]+\.tgz$/);
  shipped = inspectArchive(await readFile(path.join(owned, result[0].filename)));
});
after(async () => {
  if (!owned) return;
  assert.equal(path.dirname(owned), parent);
  assert.ok(path.basename(owned).startsWith('omh-package-tests-'));
  assert.equal(await realpath(owned), owned);
  await rm(owned, { recursive: true, force: false });
});

function archive(entries, { terminate = true } = {}) {
  const chunks = [];
  for (const { name, data = '', type = '0', link = '', prefix = '' } of entries) {
    const bytes = Buffer.from(data), header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write('0000644\0', 100);
    header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136); header.fill(32, 148, 156);
    header.write(type, 156); header.write(link, 157, 100);
    header.write('ustar\0', 257); header.write('00', 263); header.write(prefix, 345, 155);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  if (terminate) chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function changedJson(name, change) {
  const files = new Map(shipped), value = JSON.parse(files.get(name));
  change(value); files.set(name, Buffer.from(JSON.stringify(value)));
  return files;
}

test('actual npm tarball retains runtime, optional bundles, architecture and licenses', () => {
  assert.ok(shipped.has('extensions/dsh-native-codex/native-images.mjs'));
  assert.ok(shipped.has('extensions/dsh-native/release.mjs'));
  assert.ok(shipped.has('extensions/dsh-voice-input/LICENSE'));
  assert.ok(shipped.has('extensions/skill-source-management/manage.py'));
  assert.ok(validatePackageFiles(shipped) >= 15);
});

test('voice distribution ships only the Host provider, with no second client', () => {
  const voicePath = 'extensions/dsh-voice-input/';
  assert.ok(!shipped.has(voicePath + 'client.js'));
  assert.throws(() => validatePackageFiles(changedJson(voicePath + 'package.json', (pkg) => {
    pkg.dsh.client = { platform: 'web' };
  })), /voice provider must not ship a separate client/);
});

test('actual distribution includes the deployment templates linked from its guide', () => {
  for (const name of ['deploy/Caddyfile.example', 'deploy/nginx.conf.example']) {
    assert.ok(shipped.has(name), 'deployment guide target missing: ' + name);
    const files = new Map(shipped); files.delete(name);
    assert.throws(() => validatePackageFiles(files), /missing/);
  }
});

test('package validation rejects a missing Skill CLI import before delivery', () => {
  for (const name of ['cli.py', 'core.py', 'packages.py']) {
    const files = new Map(shipped);
    files.delete('extensions/skill-source-management/skill_source_management/' + name);
    assert.throws(() => validatePackageFiles(files), /missing/, 'missing CLI dependency: ' + name);
  }
});

test('archive validation accepts portable files and rejects unsafe headers before extraction', async (t) => {
  const files = inspectArchive(archive([{ name: 'package/', type: '5' }, { name: 'file.mjs', prefix: 'package/src', data: 'export const x = 1;' }]));
  assert.equal(files.get('src/file.mjs').toString(), 'export const x = 1;');
  for (const name of ['/outside', 'package/../outside', 'package//file', 'package/./file', 'package/a\\b', 'C:/outside', 'outside/file', 'package/file\nname']) {
    await t.test('reject path ' + JSON.stringify(name), () => assert.throws(() => inspectArchive(archive([{ name }]))));
  }
  for (const type of ['1', '2', '3', '4', '6', 'x', 'g', 'L', 'K']) {
    await t.test('reject special entry ' + type, () => assert.throws(() => inspectArchive(archive([{ name: 'package/file', type }]))));
  }
  assert.throws(() => inspectArchive(archive([{ name: 'package/file', link: 'outside' }])), /links/);
  assert.throws(() => inspectArchive(archive([{ name: 'package/file' }, { name: 'package/file' }])), /duplicate/);
  assert.throws(() => inspectArchive(archive([{ name: 'package/file' }, { name: 'package/file/child' }])), /collision/);
  assert.throws(() => inspectArchive(archive([{ name: 'package' }])), /root/);
  assert.throws(() => inspectArchive(archive([{ name: 'package/file' }], { terminate: false })), /unterminated/);
  assert.throws(() => inspectArchive(gzipSync(Buffer.alloc(1024))), /empty/);
  const damaged = archive([{ name: 'package/file', data: 'ok' }]);
  assert.throws(() => inspectArchive(damaged.subarray(0, damaged.length - 8)));
  const corruptHeader = gunzipSync(damaged); corruptHeader[0] ^= 1;
  assert.throws(() => inspectArchive(gzipSync(corruptHeader)), /checksum/);
  const mutateHeader = (change) => {
    const bytes = gunzipSync(damaged); change(bytes);
    bytes.fill(32, 148, 156);
    bytes.write(bytes.subarray(0, 512).reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    return gzipSync(bytes);
  };
  assert.throws(() => inspectArchive(mutateHeader((bytes) => bytes.write('not-octal', 124))), /number/);
  assert.throws(() => inspectArchive(mutateHeader((bytes) => bytes.write('07777777777\0', 124))), /truncated/);
  assert.throws(() => inspectArchive(mutateHeader((bytes) => bytes.write('other', 257))), /format/);
  const corruptEnd = gunzipSync(damaged); corruptEnd[corruptEnd.length - 1] = 1;
  assert.throws(() => inspectArchive(gzipSync(corruptEnd)), /terminator/);
});

test('package contract rejects missing files, retained exports, prerequisites and relative dependencies', async (t) => {
  for (const name of ['LICENSE', 'docs/architecture.png', 'extensions/dsh-capabilities/client.js', 'extensions/dsh-voice-input/resample.mjs', 'extensions/dsh-native-codex/vendor/LICENSE', 'extensions/skill-source-management/manage.py']) {
    await t.test('missing ' + name, () => {
      const files = new Map(shipped); files.delete(name);
      assert.throws(() => validatePackageFiles(files), /missing/);
    });
  }
  await t.test('retained runtime export keys', () => {
    assert.throws(() => validatePackageFiles(changedJson('package.json', (pkg) => { delete pkg.exports['./dsh']; })), /required export/);
  });
  assert.throws(() => validatePackageFiles(changedJson('package.json', (pkg) => { pkg.exports['./client'] = './missing.js'; })), /export|missing/);
  assert.throws(() => validatePackageFiles(changedJson('package.json', (pkg) => { pkg.exports['./extra'] = './absent/*.json'; })), /wildcard/);
  assert.throws(() => validatePackageFiles(changedJson('extensions/dsh-voice-input/package.json', (pkg) => { delete pkg.peerDependencies['@deepseek-ai/dsh-experimental-speech-to-text']; })), /prerequisite/);
  const files = new Map([['src/a.mjs', Buffer.from("import {\n value\n} from './missing.mjs';\n")]]);
  await t.test('multiline relative import closure', () => {
    assert.throws(() => requiredRelativeModuleClosure(files, ['src/a.mjs']), /missing/);
  });
  files.set('src/a.mjs', Buffer.from("import './b.mjs'; export { value } from './b.mjs'; import('./b.mjs');"));
  files.set('src/b.mjs', Buffer.from("import './a.mjs'; export const value = 1;"));
  assert.equal(requiredRelativeModuleClosure(files, ['src/a.mjs']), 2);
  files.set('src/a.mjs', Buffer.from("import '../../outside.mjs';"));
  assert.throws(() => requiredRelativeModuleClosure(files, ['src/a.mjs']), /unsafe/);
});

test('distributed package rejects private filenames and text without echoing sensitive values', async (t) => {
  for (const name of ['.state/config.json', 'config/.env', 'credentials.json', 'session/data.json', 'USER_PROFILE.md', 'runtime-status.json', 'config/client.key']) {
    await t.test('reject private filename ' + name, () => {
      const files = new Map(shipped); files.set(name, Buffer.from('{}'));
      assert.throws(() => validatePackageFiles(files), /private state/);
    });
  }
  // Assemble private-looking values at runtime: the test source is distributed,
  // but is not itself an instance configuration or a leaked credential.
  for (const text of ['/Users/' + 'alice/private', '/home/' + 'alice/private', 'https://' + '10.12.13.14/v1', 'https://' + 'host.local/v1', 'https://' + 'alice:password@provider.example.com/v1', 'https://' + 'provider.example.com/v1?api_key=private', 'sk-' + 'a'.repeat(40)]) {
    const files = new Map(shipped); files.set('config/leak.txt', Buffer.from(text));
    assert.throws(() => validatePackageFiles(files), (error) => {
      assert.match(error.message, /personal|private endpoint|credential signature/);
      assert.ok(!error.message.includes(text)); return true;
    });
  }
});

test('actual pack gate validates detached client and cleans only its unique directory on pass and failure', async () => {
  const temp = path.join(owned, 'gate-temp'), empty = path.join(owned, 'empty-source');
  await mkdir(temp); await mkdir(empty);
  await writeFile(path.join(temp, 'keep.txt'), 'owned by the test, not the verifier');
  const env = { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp, NODE_DISABLE_COMPILE_CACHE: '1' };
  const success = spawnSync(process.execPath, ['bin/verify-package.mjs'], { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(success.status, 0, success.stderr);
  const result = JSON.parse(success.stdout);
  assert.ok(result.checks.includes('detached client build'));
  assert.match(result.nativeCodex, /not executed/);
  assert.deepEqual(await readdir(temp), ['keep.txt']);
  const failure = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { verifyPackage } from './bin/verify-package.mjs'; await verifyPackage({ sourceRoot: process.argv[1] });", empty],
  { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  assert.notEqual(failure.status, 0);
  assert.deepEqual(await readdir(temp), ['keep.txt']);
  assert.equal(await readFile(path.join(temp, 'keep.txt'), 'utf8'), 'owned by the test, not the verifier');
});
