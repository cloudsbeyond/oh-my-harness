import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

test('an independent DSH plugin can publish and load a versioned release', async (t) => {
  const { publishRelease } = await import('../extensions/dsh-native/release.mjs');
  const scratch = await mkdtemp(path.join(tmpdir(), 'dsh-plugin-release-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const stateRoot = pathToFileURL(scratch + path.sep);
  const inputs = new Map([
    ['extension.mjs', "export { provider } from './support/provider.mjs';\n"],
    ['support/provider.mjs', "export const provider = 'example-messages';\n"],
  ]);
  const publish = () => publishRelease({ stateRoot, inputs, entry: 'extension.mjs' });
  const [first, duplicate] = await Promise.all([publish(), publish()]);
  assert.equal(duplicate.entry, first.entry);
  assert.equal((await import(first.entry)).provider, 'example-messages');
  assert.equal((await publish()).entry, first.entry);

  inputs.set('support/provider.mjs', "export const provider = 'another-example';\n");
  const next = await publish();
  assert.notEqual(first.entry, next.entry);
  assert.equal((await import(first.entry)).provider, 'example-messages');
  assert.equal((await import(next.entry)).provider, 'another-example');
  assert.equal(JSON.parse(await readFile(new URL('release-manifest.json', stateRoot), 'utf8')).entry, next.entry);

  inputs.set('../outside.mjs', 'invalid');
  await assert.rejects(publish, /Invalid release file/);
});
