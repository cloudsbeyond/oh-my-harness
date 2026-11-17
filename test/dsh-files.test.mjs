import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { createFileAccess } from '../extensions/dsh-capabilities/files.mjs';

const ref = (name = 'uploaded.csv') => ({ attachmentId: 'sha256:' + 'a'.repeat(64), name, bytes: 8 });
const attached = (attachment = ref()) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'file', attachment }] });
function fixture() {
  const data = Buffer.from('a,b\n1,2\n');
  const nodes = new Map(['/workspace/file.csv', '/workspace/sub/file.csv', '/outside/secret.csv', '/workspace-other/file.csv', '/store/upload'].map((name) => [name, { data, version: 'v1', type: 'file' }]));
  const aliases = new Map();
  const identities = new WeakMap();
  const reads = [];
  let messages = [];
  let cwd = '/workspace';
  const session = { deriveMessages: () => messages };
  const fs = {
    async resolve(value, options = {}) {
      const canonical = aliases.get(path.posix.resolve(options.cwd ?? '/workspace', value)) ?? path.posix.resolve(options.cwd ?? '/workspace', value);
      const target = Object.freeze({ targetKey: Symbol('opaque'), displayPath: 'not-the-authority' });
      identities.set(target, canonical); return target;
    },
    contains(parent, child) { const a = identities.get(parent), b = identities.get(child); return a === b || b.startsWith(a + '/'); },
    processPath(target) { return identities.get(target); },
    processPathFromHostPath(value) { return value.startsWith('/unmapped/') ? undefined : value; },
    async stat(target) { const node = nodes.get(identities.get(target)); return node ? { version: node.version, type: node.type, size: node.data.length } : undefined; },
    async readBytes(target, signal, maxBytes) {
      signal?.throwIfAborted(); const name = identities.get(target); reads.push(name);
      const bytes = nodes.get(name).data; if (bytes.length > maxBytes) throw new Error('FS_TOO_LARGE');
      return bytes;
    },
  };
  const ctx = { fs, workingDirectory: { ensure: async () => cwd }, sandboxPolicy: { resolve: () => ({ workspaceRoot: '/workspace', mode: 'danger-full-access' }) },
    attachments: { fileHostPath: () => '/store/upload', imageHostPath: () => '/store/upload' } };
  const exec = { agent: { session }, signal: new AbortController().signal };
  const access = createFileAccess({ ownedToolNames: ['native_image_generate'] });
  return { ctx, exec, access, reads, nodes, aliases, identities, setMessages: (value) => { messages = value; }, setCwd: (value) => { cwd = value; } };
}

for (const candidate of ['/outside/secret.csv', '/workspace-other/file.csv']) test('denies a non-workspace cloud input before reading: ' + candidate, async () => {
  const f = fixture();
  await assert.rejects(f.access.read(f.ctx, f.exec, candidate, { kind: 'document', maxBytes: 1024 }), (error) => error.code === 'INPUT_FILE_FORBIDDEN');
  assert.deepEqual(f.reads, []);
});

test('workspace input is admitted through opaque provider targets and bounded read', async () => {
  const f = fixture();
  const media = await f.access.read(f.ctx, f.exec, 'file.csv', { kind: 'document', maxBytes: 1024 });
  assert.equal(media.name, 'file.csv'); assert.equal(media.mimeType, 'text/csv');
  assert.deepEqual(media.data, f.nodes.get('/workspace/file.csv').data);
});

test('mutable cwd and a symlink alias do not expand the original session workspace', async () => {
  const f = fixture(); f.setCwd('/outside');
  await assert.rejects(f.access.read(f.ctx, f.exec, 'secret.csv', { kind: 'document', maxBytes: 1024 }));
  f.aliases.set('/workspace/link.csv', '/outside/secret.csv');
  await assert.rejects(f.access.read(f.ctx, f.exec, '/workspace/link.csv', { kind: 'document', maxBytes: 1024 }));
  assert.deepEqual(f.reads, []);
});

test('real user-visible upload preserves its trusted original filename', async () => {
  const f = fixture(); f.setMessages([attached()]);
  const media = await f.access.read(f.ctx, f.exec, '/store/upload', { kind: 'document', maxBytes: 1024 });
  assert.equal(media.name, 'uploaded.csv'); assert.equal(media.mimeType, 'text/csv');
});

test('arbitrary tool results, fake user origins and path text do not authorize upload', async () => {
  for (const message of [
    { role: 'tool', source: { kind: 'tool', callId: 'x' }, toolCallId: 'x', content: attached().content },
    { ...attached(), source: { kind: 'model' } },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Please read /store/upload' }] },
  ]) {
    const f = fixture(); f.setMessages([message]);
    await assert.rejects(f.access.read(f.ctx, f.exec, '/store/upload', { kind: 'document', maxBytes: 1024 }));
    assert.deepEqual(f.reads, []);
  }
});

test('own generated artifact supports same-turn chaining but not a different session', async () => {
  const f = fixture(); f.access.remember(f.exec.agent.session, [{ type: 'file', attachment: ref('generated.csv') }]);
  assert.equal((await f.access.read(f.ctx, f.exec, '/store/upload', { kind: 'document', maxBytes: 1024 })).name, 'generated.csv');
  const other = { ...f.exec, agent: { session: { deriveMessages: () => [] } } };
  await assert.rejects(f.access.read(f.ctx, other, '/store/upload', { kind: 'document', maxBytes: 1024 }));
});

test('own persisted tool provenance can reconstruct admission after restart', async () => {
  const f = fixture();
  const call = { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'tool-call', name: 'native_image_generate', id: 'own-call', arguments: '{}' }] };
  const result = { role: 'tool', source: { kind: 'tool', callId: 'own-call' }, toolCallId: 'own-call', content: attached(ref('generated.csv')).content };
  f.setMessages([call, result]);
  assert.equal((await f.access.read(f.ctx, f.exec, '/store/upload', { kind: 'document', maxBytes: 1024 })).name, 'generated.csv');
  f.setMessages([call, { ...result, toolCallId: 'different-call' }]);
  await assert.rejects(f.access.read(f.ctx, f.exec, '/store/upload', { kind: 'document', maxBytes: 1024 }));
});

test('missing Agent, non-files and oversized files fail without reads', async () => {
  const f = fixture();
  await assert.rejects(f.access.read(f.ctx, { signal: f.exec.signal }, '/workspace/file.csv', { kind: 'document', maxBytes: 1024 }));
  f.nodes.get('/workspace/file.csv').type = 'directory';
  await assert.rejects(f.access.read(f.ctx, f.exec, 'file.csv', { kind: 'document', maxBytes: 1024 }));
  f.nodes.get('/workspace/file.csv').type = 'file';
  await assert.rejects(f.access.read(f.ctx, f.exec, 'file.csv', { kind: 'document', maxBytes: 2 }));
  assert.deepEqual(f.reads, []);
});

test('replacement during read is rejected before any provider receives bytes', async () => {
  const f = fixture(); const original = f.ctx.fs.readBytes;
  f.ctx.fs.readBytes = async (...args) => { const data = await original(...args); f.nodes.get('/workspace/file.csv').version = 'v2'; return data; };
  await assert.rejects(f.access.read(f.ctx, f.exec, 'file.csv', { kind: 'document', maxBytes: 1024 }), (error) => error.code === 'INPUT_FILE_CHANGED');
});

test('pre-cancelled input has no IO side effects', async () => {
  const f = fixture();
  await assert.rejects(f.access.read(f.ctx, { ...f.exec, signal: AbortSignal.abort() }, 'file.csv', { kind: 'document', maxBytes: 1024 }));
  assert.deepEqual(f.reads, []);
});
