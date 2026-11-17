import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildRoot, runtimeFiles, upstreamAdapter } from './paths.mjs';
import { captureDependencies, expectedHash, sha256 } from './baseline.mjs';
import { patchAdapter } from './adapter-patch.mjs';
export { expectedHash } from './baseline.mjs';

// Build against a selected, verified host. Never edit its installed adapter.
export const upstreamPath = path.join(upstreamAdapter, 'lib/index.js');
const source = await readFile(upstreamPath, 'utf8');
const generated = patchAdapter(source);
const dependencies = captureDependencies({ anchor: process.env.DSH_NODE_MODULES });
const outputs = new Map(await Promise.all(runtimeFiles.map(async (file) => [file, await readFile(new URL(file, import.meta.url), 'utf8')])));
outputs.set('vendor/dsh-pi-adapter.mjs', generated);
outputs.set('vendor/LICENSE', await readFile(path.join(upstreamAdapter, 'LICENSE'), 'utf8'));
outputs.set('vendor/dependencies.json', JSON.stringify({ format: 1, upstreamHash: expectedHash, generatedHash: sha256(generated), dependencies }, null, 2) + '\n');
for (const [file, content] of outputs) {
  const target = new URL(file, buildRoot);
  await mkdir(path.dirname(fileURLToPath(target)), { recursive: true });
  try { await readFile(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(target, content);
}
console.log(JSON.stringify({ build: fileURLToPath(buildRoot), upstreamHash: expectedHash, generatedHash: sha256(generated), dependencies }));
