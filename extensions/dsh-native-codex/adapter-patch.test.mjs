import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { patchAdapter } from './adapter-patch.mjs';
import { expectedHash, sha256 } from './baseline.mjs';
import { upstreamAdapter } from './paths.mjs';

test('current reviewed adapter patch is deterministic and preserves headers preparation and replay digest', async () => {
  const source = await readFile(path.join(upstreamAdapter, 'lib/index.js'), 'utf8');
  assert.equal(sha256(source), expectedHash);
  const generated = patchAdapter(source);
  assert.equal(generated, patchAdapter(source));
  assert.equal(sha256(source), expectedHash);
  assert.match(generated, /fetch: extension\?\.fetch/);
  assert.ok(generated.includes('requestHeaders(profile.headers, options, model.baseUrl, this.config.prepareHeaders)'));
  assert.ok(generated.includes('model.contextWindow, options.signal, model.id, digest)'));
  assert.equal(sha256(generated), '11dcc7fcdf5c190625f711aae6d1bfb10a69ce8fa65617ef10ef89a4c04012e8');
});

test('unreviewed or mutated upstream code cannot be patched optimistically', () => {
  assert.throws(() => patchAdapter('different upstream'), /changed|fingerprint/);
});
