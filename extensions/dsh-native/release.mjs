import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function publishRelease({ stateRoot, inputs, entry = 'plugin.mjs' }) {
  if (!inputs.has(entry)) throw new Error('Release entry must be included in inputs');
  const hash = createHash('sha256');
  for (const [file, text] of inputs) {
    if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(file) || file.split('/').some((part) => part === '.' || part === '..')) {
      throw new Error('Invalid release file: ' + file);
    }
    hash.update(file + '\0' + text + '\0');
  }
  hash.update('release-format-1');
  const release = hash.digest('hex').slice(0, 24);
  const releases = new URL('releases/', stateRoot);
  const directory = new URL(release + '/', releases);
  await mkdir(releases, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(path.join(fileURLToPath(releases), '.stage-'));
  try {
    for (const [file, text] of inputs) {
      const target = path.join(stage, file);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, text, { mode: 0o600, flag: 'wx' });
    }
    try {
      await rename(stage, fileURLToPath(directory));
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      for (const [file, text] of inputs) {
        if (await readFile(new URL(file, directory), 'utf8') !== text) {
          throw new Error('Immutable release content mismatch: ' + file);
        }
      }
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  const manifest = {
    release, builtAt: new Date().toISOString(), entry: new URL(entry, directory).href,
    directory: fileURLToPath(directory),
  };
  const temp = new URL('.release-manifest-' + randomUUID(), stateRoot);
  try {
    await writeFile(temp, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, new URL('release-manifest.json', stateRoot));
  } finally {
    try { await unlink(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return manifest;
}
