import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNativeTools } from '../extensions/dsh-capabilities/tools.mjs';
import { hostFixture, png } from './dsh-host-fixture.mjs';

function fixture(t) {
  const host = hostFixture(); t.after(() => host.backend.dispose());
  const tools = new Map(createNativeTools({ ctx: host.ctx, backend: host.backend, defineTool: (options) => options }).map((tool) => [tool.name, tool]));
  const call = (name, args, exec = host.exec) => tools.get(name).execute(args, exec);
  return { ...host, tools, call };
}

test('native definitions expose operation-specific tools without a duplicate search or MCP wrapper', (t) => {
  const f = fixture(t);
  assert.equal(f.tools.size, 9);
  assert.equal(f.tools.has('web_search'), false); assert.equal(f.tools.has('native_web_search'), false);
  assert.ok(f.tools.has('native_document_inspect')); assert.ok(f.tools.has('capability_providers'));
});

test('native document understanding directly feeds admitted bytes to the provider', async (t) => {
  const f = fixture(t);
  const value = await f.call('native_document_inspect', { file: 'values.csv', question: 'Read the value' });
  assert.equal(value.kind, 'text'); assert.equal(value.text, 'Fixture analysis'); assert.equal(value.provider, 'primary');
  assert.equal(value.content, undefined);
  const media = f.calls[0].payload.input[0].content[0];
  assert.equal(media.type, 'input_file'); assert.match(media.file_data, /^data:text\/csv;base64,/);
});

test('uploaded document is consumed directly from the session without manual Gateway-directory copying', async (t) => {
  const f = fixture(t); const uploaded = await f.upload();
  f.setMessages([{ role: 'user', source: { kind: 'user' }, content: [{ type: 'file', attachment: uploaded.ref }] }]);
  assert.equal((await f.call('native_document_inspect', { file: uploaded.file, question: 'Read it' })).text, 'Fixture analysis');
  assert.equal(f.calls[0].payload.input[0].content[0].filename, 'uploaded.csv');
});

test('unknown arguments and private files fail before IO/network side effects', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.call('native_document_inspect', { file: 'values.csv', question: 'Read it', raw_key: 'must-not-be-used' }), (error) => error.code === 'INPUT_INVALID');
  await assert.rejects(f.call('native_document_inspect', { file: '/private/secret.csv', question: 'Read it' }), (error) => error.code === 'INPUT_FILE_FORBIDDEN');
  assert.deepEqual(f.calls, []); assert.deepEqual(f.reads, []);
});

test('generated image is canonical native output and can be edited within the same session', async (t) => {
  const f = fixture(t);
  const image = await f.call('native_image_generate', { prompt: 'A square' });
  assert.equal(image.kind, 'image'); assert.equal(image.file.bytes, png.length);
  assert.equal(image.data, undefined); assert.equal(image.content, undefined);
  const edited = await f.call('native_image_edit', { file: image.path, prompt: 'Make it blue' });
  assert.equal(edited.kind, 'image');
  const content = f.calls[1].payload.input[0].content;
  assert.ok(content.some((part) => part.type === 'input_image' && part.image_url.endsWith(png.toString('base64'))));
  const rendered = f.tools.get('native_image_generate').output.render({}, image);
  assert.ok(rendered.some((part) => part.type === 'image'));
});

test('speech output and follow-up transcription use native file refs, not MCP media blocks', async (t) => {
  const f = fixture(t);
  const speech = await f.call('native_speech_synthesize', { text: 'A short fixture' });
  assert.equal(speech.kind, 'audio'); assert.equal(speech.mimeType, 'audio/wav');
  const transcript = await f.call('native_speech_transcribe', { file: speech.path });
  assert.equal(transcript.text, 'Transcribed fixture');
  assert.ok(f.tools.get('native_speech_synthesize').output.render({}, speech).some((part) => part.type === 'file'));
});

test('agentless paid file/tool calls are rejected while status remains programmatically available', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.call('native_image_generate', { prompt: 'A square' }, { signal: f.exec.signal }), (error) => error.code === 'AGENT_REQUIRED');
  const status = await f.call('capability_providers', {}, { signal: f.exec.signal });
  assert.ok(status.providers.length > 0); assert.equal(JSON.stringify(status).includes('test-native-provider-key'), false);
});
