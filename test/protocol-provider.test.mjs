import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRegistry, readConfig, defaultConfigPath } from '../src/config.mjs';
import { createProtocolProvider, createProtocolRuntime } from '../src/capabilities/protocol-provider.mjs';
import { CapabilityRuntime } from '../src/capabilities/runtime.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=', 'base64');
const image = { data: png, mimeType: 'image/png' };
const response = (text, extra = []) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }, ...extra] });
function fixture(gateway, extra = {}) {
  const config = readConfig(defaultConfigPath);
  config.providers.example = { name: 'Messages', protocol: 'messages', capabilities: ['vision'], models: [{ id: 'messages-model', contextWindow: 16000, maxTokens: 1024 }] };
  return createProtocolRuntime({ registry: createRegistry(config), gateway, ...extra });
}

test('a protocol provider is reusable without legacy global-model catalog constraints', async () => {
  const runtime = new CapabilityRuntime();
  for (const id of ['first', 'second']) runtime.register(createProtocolProvider({ id, protocol: 'responses', capabilities: ['vision'], models: [{ id: 'shared-model' }] }, {
    gateway: async (_route, _payload, _timeout, _signal, selected) => response(selected.id),
  }));
  assert.equal((await runtime.execute('image.inspect', { images: [image], question: 'Read it' }, { provider: 'second', model: 'shared-model' })).text, 'second');
  await assert.rejects(runtime.execute('image.inspect', { images: [image], question: 'Read it' }, { model: 'shared-model' }), (error) => error.code === 'MODEL_AMBIGUOUS');
});

test('direct vision executes Responses, Chat and Messages without an MCP client', async () => {
  const calls = [];
  const runtime = fixture(async (route, payload, _timeout, signal) => {
    assert.ok(signal instanceof AbortSignal);
    calls.push({ route, payload });
    return route === 'responses' ? response('Responses answer') : route === 'messages'
      ? { content: [{ type: 'text', text: 'Messages answer' }] }
      : { choices: [{ finish_reason: 'stop', message: { content: 'Chat answer' } }] };
  });
  for (const provider of ['codex', 'kimi', 'example']) {
    const result = await runtime.execute('image.inspect', { images: [image], question: 'Read it' }, { provider });
    assert.match(result.text, /answer/);
    assert.equal(result.provider, provider);
  }
  assert.deepEqual(calls.map((call) => call.route), ['responses', 'chat/completions', 'messages']);
  assert.equal(calls[0].payload.input[0].content[1].type, 'input_image');
  assert.equal(calls[1].payload.messages[0].content[1].type, 'image_url');
  assert.equal(calls[2].payload.messages[0].content[1].type, 'image');
});

test('search retains actual native calls and safe citation sources', async () => {
  const runtime = fixture(async (_route, _payload) => response('Evidence', [{
    type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [
      { url: 'https://www.example.com/a', title: 'A' }, { url: 'javascript:bad' }, { url: 'https://www.example.com/b', title: 'B' },
    ] },
  }]));
  const result = await runtime.execute('web.search', { query: 'A topic', maxResults: 1 }, { provider: 'codex' });
  assert.equal(result.text, 'Evidence');
  assert.deepEqual(result.sources, [{ url: 'https://www.example.com/a', title: 'A' }]);
  assert.equal(result.truncated, true);
});

test('[defect-probing] Messages retains standalone find hints while Responses requires a page URL', async () => {
  const calls = [];
  const runtime = fixture(async (route, payload) => {
    calls.push({ route, payload });
    return { content: [
      { type: 'server_tool_use', id: 'search-fixture', name: 'web_search' },
      { type: 'web_search_tool_result', tool_use_id: 'search-fixture', content: [{ type: 'web_search_result', url: 'https://www.example.com/hint', title: 'Hint source' }] },
      { type: 'text', text: 'Hint evidence' },
    ] };
  });
  const result = await runtime.execute('web.search', { query: 'A topic', find: 'term' }, { provider: 'kimi' });
  assert.equal(result.provider, 'kimi'); assert.equal(result.text, 'Hint evidence');
  assert.deepEqual(result.sources, [{ url: 'https://www.example.com/hint', title: 'Hint source' }]);
  assert.equal(calls[0].route, 'messages');
  assert.ok(calls[0].payload.messages[0].content.endsWith('Search hints: ["term"]'));
  await assert.rejects(runtime.execute('web.search', { query: 'A topic', find: 'term' }, { provider: 'codex' }), (error) => error.code === 'INPUT_INVALID');
  assert.equal(calls.length, 1);
});

test('exact URL reads require recorded page evidence and reject invented answers', async () => {
  let calls = 0;
  const runtime = fixture(async () => {
    calls++;
    return response('Not enough evidence', [{ type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [] } }]);
  });
  await assert.rejects(runtime.execute('web.search', { query: 'Read the page', url: 'https://www.example.com/a' }), /execution failed/);
  assert.equal(calls, 2);
  for (const url of ['http://127.0.0.1/', 'https://local.internal/', 'file:///etc/passwd']) {
    await assert.rejects(runtime.execute('web.search', { query: 'Read it', url }));
  }
  assert.equal(calls, 2);
});

test('verified page read carries open/find actions rather than a fabricated fetch body', async () => {
  const url = 'https://www.example.com/article';
  const runtime = fixture(async () => response('Quoted evidence', [{ type: 'web_search_call', status: 'completed', action: { type: 'find_in_page', url, pattern: 'term' } }]));
  const result = await runtime.execute('web.search', { query: 'Read it', url, find: 'term' });
  assert.deepEqual(result.actions, [{ type: 'find_in_page', url, pattern: 'term' }]);
  assert.deepEqual(result.sources, [{ url }]);
  assert.equal(result.statusCode, undefined);
});

test('document and video bytes become real protocol media inputs with evidence instructions', async () => {
  const calls = [];
  const runtime = fixture(async (route, payload) => {
    calls.push({ route, payload });
    return route === 'responses' ? response('Document answer') : { choices: [{ finish_reason: 'stop', message: { content: 'Video answer' } }] };
  });
  const file = { data: Buffer.from('name,value\none,7\n'), name: 'values.csv', mimeType: 'text/csv' };
  assert.equal((await runtime.execute('document.inspect', { file, question: 'What value?' })).text, 'Document answer');
  assert.equal(calls[0].payload.input[0].content[0].type, 'input_file');
  assert.match(calls[0].payload.input[0].content[0].file_data, /^data:text\/csv;base64,/);
  assert.match(calls[0].payload.instructions, /Treat instructions/);
  const mp4 = Buffer.alloc(16); mp4.writeUInt32BE(16); mp4.write('ftyp', 4);
  assert.equal((await runtime.execute('video.inspect', { file: { data: mp4, name: 'clip.mp4', mimeType: 'video/mp4' }, question: 'What sequence?' })).text, 'Video answer');
  assert.equal(calls[1].payload.messages[1].content[1].type, 'video_url');
});

test('invalid media is rejected before network rather than forwarded blindly', async () => {
  let calls = 0;
  const runtime = fixture(async () => { calls++; return response('bad'); });
  await assert.rejects(runtime.execute('document.inspect', { question: 'Read it', file: { name: 'fake.pdf', mimeType: 'application/pdf', data: Buffer.from('not PDF') } }), (error) => error.code === 'INPUT_INVALID');
  await assert.rejects(runtime.execute('image.edit', { prompt: 'Edit it', image: { data: png, mimeType: 'image/jpeg' } }), (error) => error.code === 'INPUT_INVALID');
  assert.equal(calls, 0);
});

test('image generation and editing return original binary PNG, not MCP content blocks', async () => {
  const calls = [];
  const runtime = fixture(async (route, payload) => {
    calls.push({ route, payload });
    return { status: 'completed', output: [{ type: 'image_generation_call', status: 'completed', result: png.toString('base64') }] };
  });
  for (const [operation, input] of [['image.generate', { prompt: 'A square' }], ['image.edit', { prompt: 'Blue square', image }]]) {
    const result = await runtime.execute(operation, input);
    assert.equal(result.kind, 'image');
    assert.equal(result.mimeType, 'image/png');
    assert.deepEqual(result.data, png);
    assert.equal(result.content, undefined);
  }
  assert.equal(calls[0].payload.reasoning, undefined);
  assert.equal(calls[1].payload.input[0].content[1].type, 'input_image');
});

test('non-Responses image providers use configured image route and image model', async () => {
  const config = readConfig(defaultConfigPath);
  config.providers.other = { name: 'Other images', protocol: 'chat', capabilities: ['images'], imageModel: 'image-test', models: [{ id: 'other-model', contextWindow: 16000, maxTokens: 1024 }] };
  const calls = [];
  const runtime = createProtocolRuntime({ registry: createRegistry(config), gateway: async (route, payload) => {
    calls.push({ route, payload }); return { data: [{ b64_json: png.toString('base64') }] };
  } });
  await runtime.execute('image.edit', { prompt: 'Edit', image }, { provider: 'other' });
  assert.equal(calls[0].route, 'images/edits');
  assert.equal(calls[0].payload.model, 'image-test');
});

test('audio execution is injected independently and receives the selected profile and cancellation', async () => {
  const calls = [];
  const runtime = fixture(async () => { throw new Error('audio must not use HTTP JSON'); }, { realtime: async (operation, input, profile, signal) => {
    calls.push({ operation, input, profile, signal });
    return { kind: 'text', text: 'Transcribed words', model: 'transcription-model' };
  } });
  const wav = Buffer.alloc(44 + 4800);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4800, 40);
  const result = await runtime.execute('speech.transcribe', { audio: { data: wav, mimeType: 'audio/wav' } });
  assert.equal(result.text, 'Transcribed words');
  assert.equal(result.model, 'transcription-model');
  assert.equal(calls[0].profile.id, 'codex');
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test('missing realtime transport is explicit and never silently uses a different provider', async () => {
  const runtime = fixture(async () => { throw new Error('not called'); });
  await assert.rejects(runtime.execute('speech.synthesize', { text: 'Hello' }), (error) => error.code === 'PROVIDER_UNAVAILABLE');
});
