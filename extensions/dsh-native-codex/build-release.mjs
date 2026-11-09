import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stateRoot } from './paths.mjs';

// Immutable local releases avoid relying on cache invalidation of external files.
const root = new URL('./', import.meta.url);
const inputs = ['plugin.mjs', 'native-search.mjs', 'native-images.mjs', 'vendor/dsh-pi-adapter.mjs', 'vendor/LICENSE'];
const files = new Map(await Promise.all(inputs.map(async (path) => [path, await readFile(new URL(path, root), 'utf8')])));
const hash = createHash('sha256');
for (const [path, text] of files) hash.update(path + '\0' + text + '\0');
hash.update('release-format-1');
const release = hash.digest('hex').slice(0, 24);
const dir = new URL(`releases/${release}/`, stateRoot);
await mkdir(new URL('vendor/', dir), { recursive: true });
for (const [path, original] of files) {
  const text = path === 'plugin.mjs' ? original.replace("new URL('runtime-status.json', import.meta.url)", "new URL('../../runtime-status.json', import.meta.url)") : original;
  const target = new URL(path, dir);
  let existing;
  try { existing = await readFile(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing !== undefined && existing !== text) throw new Error(`Immutable release content mismatch: ${path}`);
  if (existing === undefined) await writeFile(target, text, { mode: 0o600, flag: 'wx' });
}
const manifestPath = new URL('release-manifest.json', stateRoot);
const manifest = { release, builtAt: new Date().toISOString(), entry: new URL('plugin.mjs', dir).href, directory: fileURLToPath(dir) };
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(manifest));
