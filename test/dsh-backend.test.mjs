import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHostBackend } from '../extensions/dsh-capabilities/backend.mjs';
import { parseNativeConfig } from '../extensions/dsh-capabilities/config.mjs';
import { wave } from './dsh-host-fixture.mjs';
import { createRealtimeExecutor } from '../src/capabilities/realtime.mjs';

const provider = (credential, baseURL) => ({ protocol: 'responses', baseURL, credential, models: ['shared-model'], operations: ['document.inspect'] });
const configuration = () => ({ providers: {
  first: provider('FIRST_KEY', 'https://first.example.com/v1'), second: provider('SECOND_KEY', 'https://second.example.com/v1'),
}, defaults: { 'document.inspect': { provider: 'second', model: 'shared-model' } } });
const file = { name: 'values.csv', mimeType: 'text/csv', data: Buffer.from('a,b\n1,2\n') };
const input = () => ({ question: 'What is the value?', file });
const response = (text) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
const ctx = { credentials: { resolve: async (ref) => ({ value: 'test-secret-' + ref }) } };

test('native backend directly calls each selected provider endpoint without MCP or a global model catalog', async () => {
  const calls = [];
  const backend = createHostBackend(ctx, configuration(), { request: async (base, key, route, payload, _timeout, signal) => {
    calls.push({ base: String(base), key, route, payload, signal }); return response('Direct analysis');
  } });
  const result = await backend.execute('document.inspect', input());
  assert.equal(result.provider, 'second'); assert.equal(result.text, 'Direct analysis');
  assert.equal(calls[0].base, 'https://second.example.com/v1/'); assert.equal(calls[0].key, 'test-secret-SECOND_KEY');
  await backend.execute('document.inspect', input(), { provider: 'first', model: 'shared-model' });
  assert.equal(calls[1].base, 'https://first.example.com/v1/');
  assert.ok(calls[1].signal instanceof AbortSignal);
  await backend.dispose();
});

test('status reports operation bindings and readiness without endpoint or credential disclosure', async () => {
  const backend = createHostBackend(ctx, configuration(), { request: async () => response('ok') });
  const status = await backend.status();
  assert.equal(status.defaults['document.inspect'].provider, 'second');
  assert.ok(status.providers.every((item) => item.credentialReady));
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes('test-secret'), false); assert.equal(serialized.includes('SECOND_KEY'), false); assert.equal(serialized.includes('second.example.com'), false);
  await backend.dispose();
});

test('missing credentials fail before network, and disabled defaults never fall back', async () => {
  let calls = 0;
  const backend = createHostBackend({ credentials: { resolve: async () => undefined } }, configuration(), { request: async () => { calls++; return response('bad'); } });
  await assert.rejects(backend.execute('document.inspect', input()), (error) => error.code === 'MISSING_CREDENTIAL');
  assert.equal(calls, 0); assert.equal((await backend.status()).providers[0].credentialReady, false);
  await backend.dispose();
  const config = configuration(); config.providers.second.enabled = false;
  const disabled = createHostBackend(ctx, config, { request: async () => { calls++; return response('bad'); } });
  await assert.rejects(disabled.execute('document.inspect', input()), (error) => error.code === 'PROVIDER_NOT_FOUND');
  assert.equal(calls, 0); await disabled.dispose();
});

test('provider configuration is closed, reference-only and explicit about protocol capabilities', () => {
  assert.deepEqual(parseNativeConfig({}).providers, {});
  for (const change of [
    { baseURL: 'https://gateway.example.com/mcp' }, { credential: 'Bearer inline-secret' },
    { protocol: 'chat' }, { apiKey: 'not-allowed' }, { operations: ['unsupported'] },
  ]) {
    const config = configuration(); Object.assign(config.providers.first, change);
    assert.throws(() => parseNativeConfig(config));
  }
});

test('transcription and synthesis can bind independently to model-free replacement providers', async () => {
  let credentialCalls = 0;
  const backend = createHostBackend({ credentials: { resolve: async () => { credentialCalls++; return undefined; } } }, {
    defaults: { 'speech.transcribe': { provider: 'stt-source' }, 'speech.synthesize': { provider: 'tts-source' } },
  });
  backend.register({ id: 'stt-source', operations: ['speech.transcribe'], execute: async () => ({ kind: 'text', text: 'Independent STT' }) });
  backend.register({ id: 'tts-source', operations: ['speech.synthesize'], execute: async () => ({ kind: 'audio', data: wave(), mimeType: 'audio/wav' }) });
  assert.equal((await backend.execute('speech.transcribe', { audio: { data: wave(), mimeType: 'audio/wav' } })).provider, 'stt-source');
  assert.equal((await backend.execute('speech.synthesize', { text: 'Short fixture' })).provider, 'tts-source');
  assert.equal(await backend.ready('speech.transcribe'), true); assert.equal(credentialCalls, 0);
  await backend.dispose();
});

test('plugin shutdown propagates cancellation and waits for active driver cleanup', async () => {
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  let cleaned = false;
  const backend = createHostBackend(ctx, {});
  backend.register({ id: 'local', operations: ['document.inspect'], execute: (_op, _input, { signal }) => new Promise((resolve) => {
    started(); signal.addEventListener('abort', () => queueMicrotask(() => { cleaned = true; resolve({ kind: 'text', text: 'discarded' }); }), { once: true });
  }) });
  const pending = backend.execute('document.inspect', input()).catch((error) => error);
  await entered; await backend.dispose();
  assert.equal(cleaned, true); assert.equal((await pending).code, 'CANCELLED');
  await assert.rejects(backend.execute('document.inspect', input()), (error) => error.code === 'SERVICE_UNAVAILABLE');
});

test('native disposal remains pending until its WebSocket is actually closed', async () => {
  let entered; let closing; let socket;
  const started = new Promise((resolve) => { entered = resolve; });
  const closeRequested = new Promise((resolve) => { closing = resolve; });
  class DelayedSocket extends EventTarget {
    constructor() { super(); this.readyState = 1; socket = this; entered(); }
    close() { this.readyState = 2; closing(); }
    send() {}
    finishClose() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const executor = createRealtimeExecutor({ upstream: new URL('http://127.0.0.1:8317/v1/'), token: 'test-key', WebSocketImpl: DelayedSocket });
  const backend = createHostBackend(ctx, {});
  backend.register({ id: 'audio', operations: ['speech.synthesize'], execute: (op, input, { signal }) => executor(op, input, { realtimeModel: 'fixture' }, signal) });
  const pending = backend.execute('speech.synthesize', { text: 'Fixture' }).catch((error) => error);
  await started;
  let disposed = false;
  const disposal = backend.dispose().then(() => { disposed = true; });
  await closeRequested; await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposed, false, 'close() request alone is not quiescent cleanup');
  socket.finishClose(); await disposal;
  assert.equal(socket.readyState, 3); assert.equal((await pending).code, 'CANCELLED');
});

test('native task concurrency is bounded and cannot silently queue paid work', async () => {
  let finish;
  const backend = createHostBackend(ctx, { maxConcurrentTasks: 1 });
  backend.register({ id: 'local', operations: ['document.inspect'], execute: () => new Promise((resolve) => { finish = resolve; }) });
  const first = backend.execute('document.inspect', input());
  await Promise.resolve(); await Promise.resolve();
  await assert.rejects(backend.execute('document.inspect', input()), (error) => error.code === 'CAPABILITY_BUSY');
  finish({ kind: 'text', text: 'done' }); assert.equal((await first).text, 'done');
  await backend.dispose();
});
