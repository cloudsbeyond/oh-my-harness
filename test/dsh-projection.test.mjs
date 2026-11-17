import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { projectResult, renderResult } from '../extensions/dsh-capabilities/projection.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=', 'base64');
const hash = (data) => 'sha256:' + createHash('sha256').update(data).digest('hex');
function fixture() {
  const saves = [];
  const remembered = [];
  const preview = { attachmentId: 'sha256:' + 'b'.repeat(64), mediaType: 'image/webp', bytes: 40, width: 1, height: 1 };
  const ctx = {
    attachments: {
      async saveImage(value) { saves.push({ kind: 'image', ...value }); return preview; },
      async saveFile(value) { saves.push({ kind: 'file', ...value }); return { attachmentId: hash(value.data), bytes: value.data.length, name: value.name }; },
      fileHostPath(value) { return '/store/' + value.name; },
    },
    fs: { processPathFromHostPath: (path) => path, resolve: async (path) => ({ path }), processPath: ({ path }) => path, stat: async () => ({ type: 'file', version: 'v1' }) },
  };
  const exec = { agent: { session: {} }, signal: new AbortController().signal };
  const access = { remember: (...args) => remembered.push(args) };
  return { ctx, exec, access, saves, remembered, preview };
}

function wav() {
  const data = Buffer.alloc(44 + 4800); data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(24000, 24); data.writeUInt32LE(48000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(4800, 40); return data;
}

test('native image output stores exact original PNG and separate normalized ref', async () => {
  const f = fixture();
  const value = await projectResult(f.ctx, { kind: 'image', data: png, mimeType: 'image/png', provider: 'independent', operation: 'image.generate' }, f.exec, f.access);
  assert.equal(value.kind, 'image'); assert.deepEqual(value.image, f.preview);
  assert.equal(value.file.attachmentId, hash(png)); assert.equal(value.file.bytes, png.length);
  assert.deepEqual(f.saves[1].data, png); assert.equal(value.data, undefined); assert.equal(value.content, undefined);
  assert.equal(f.remembered[0][0], f.exec.agent.session);
  assert.ok(renderResult(value).some((block) => block.type === 'image' && block.attachment.attachmentId === f.preview.attachmentId));
  assert.ok(renderResult(value).some((block) => block.type === 'file' && block.attachment.attachmentId === hash(png)));
  assert.equal(JSON.stringify(value).includes(png.toString('base64')), false);
});

test('native audio result is a durable generic file, not a fake audio ContentBlock', async () => {
  const f = fixture(); const data = wav();
  const value = await projectResult(f.ctx, { kind: 'audio', data, mimeType: 'audio/wav', transcript: 'Hello', provider: 'independent', operation: 'speech.synthesize' }, f.exec, f.access);
  assert.deepEqual(f.saves[0].data, data); assert.equal(value.file.attachmentId, hash(data));
  const rendered = renderResult(value);
  assert.equal(rendered.some((block) => block.type === 'audio'), false);
  assert.ok(rendered.some((block) => block.type === 'file'));
  assert.match(rendered[0].text, /present|交付/);
});

test('text results remain canonical text with provider identity and no artifact writes', async () => {
  const f = fixture();
  const value = await projectResult(f.ctx, { kind: 'text', text: 'Analysis', provider: 'parser', operation: 'document.inspect', model: 'model' }, f.exec, f.access);
  assert.equal(value.text, 'Analysis'); assert.equal(value.provider, 'parser');
  assert.equal(renderResult(value)[0].type, 'text'); assert.deepEqual(f.saves, []);
});

test('cancelled normalization is awaited and never publishes a file or remembers an artifact', async () => {
  const f = fixture(); let finish;
  f.ctx.attachments.saveImage = () => new Promise((resolve) => { finish = resolve; });
  const controller = new AbortController();
  const pending = projectResult(f.ctx, { kind: 'image', data: png, mimeType: 'image/png', provider: 'x', operation: 'image.generate' }, { ...f.exec, signal: controller.signal }, f.access);
  await Promise.resolve(); controller.abort(); finish(f.preview);
  await assert.rejects(pending); assert.deepEqual(f.saves, []); assert.deepEqual(f.remembered, []);
});

test('unmapped artifacts do not return invented download URLs or false delivery success', async () => {
  const f = fixture(); f.ctx.fs.processPathFromHostPath = () => undefined;
  await assert.rejects(projectResult(f.ctx, { kind: 'image', data: png, mimeType: 'image/png', provider: 'x', operation: 'image.generate' }, f.exec, f.access), (error) => error.code === 'ARTIFACT_UNAVAILABLE');
  assert.deepEqual(f.remembered, []);
});

test('invalid attachment refs and unvalidated provider media fail closed', async () => {
  const f = fixture(); f.ctx.attachments.saveFile = async () => ({ fileId: 'not-canonical', name: 'fake.png', bytes: png.length });
  await assert.rejects(projectResult(f.ctx, { kind: 'image', data: png, mimeType: 'image/png', provider: 'x', operation: 'image.generate' }, f.exec, f.access));
  await assert.rejects(projectResult(f.ctx, { kind: 'image', data: Buffer.from('not PNG'), mimeType: 'image/png', provider: 'x', operation: 'image.generate' }, f.exec, f.access));
});
