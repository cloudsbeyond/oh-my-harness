import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureDependencies, expectedHash, expectedVersion, verifyDependencies } from './baseline.mjs';

const names = ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm-pi-ai', '@earendil-works/pi-ai', '@deepseek-ai/cordis', '@deepseek-ai/schemastery'];

test('actual ESM dependency resolution is captured without leaking local roots into release identity', () => {
  const snapshot = captureDependencies({ anchor: process.env.DSH_NODE_MODULES });
  assert.equal(snapshot.format, 1);
  assert.deepEqual(Object.keys(snapshot.packages), names);
  assert.equal(snapshot.packages['@deepseek-ai/dsh-llm'].version, expectedVersion);
  assert.equal(snapshot.packages['@deepseek-ai/dsh-llm-pi-ai'].entryHash, expectedHash);
  assert.ok(['1.3.0', '1.5.2'].includes(snapshot.packages['@earendil-works/pi-ai'].version));
  assert.equal(JSON.stringify(snapshot).includes(process.env.DSH_NODE_MODULES), false);
  assert.deepEqual(captureDependencies({ anchor: process.env.DSH_NODE_MODULES }), snapshot);
  assert.doesNotThrow(() => verifyDependencies(snapshot));
});

test('a changed dependency version or content fingerprint fails before adapter activation', () => {
  const snapshot = captureDependencies();
  for (const field of ['version', 'entryHash', 'manifestHash']) {
    const changed = structuredClone(snapshot);
    changed.packages['@earendil-works/pi-ai'][field] = 'changed';
    assert.throws(() => verifyDependencies(changed), /dependencies changed/);
  }
});

test('missing or extra dependency entries and unsupported lock formats fail closed', () => {
  const snapshot = captureDependencies();
  const missing = structuredClone(snapshot); delete missing.packages['@deepseek-ai/dsh-llm'];
  const extra = structuredClone(snapshot); extra.packages.unreviewed = { version: '1' };
  for (const value of [undefined, { ...snapshot, format: 2 }, missing, extra]) {
    assert.throws(() => verifyDependencies(value), /dependencies changed/);
  }
});

test('a build anchor that differs from actual imports is rejected rather than creating a mixed release', () => {
  assert.throws(() => captureDependencies({ anchor: '/not-the-installed-host/node_modules' }));
});
