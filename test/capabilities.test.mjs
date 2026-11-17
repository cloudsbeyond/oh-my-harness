import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CapabilityRuntime, CapabilityError } from '../src/capabilities/runtime.mjs';

const op = 'image.inspect';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=', 'base64');
const input = () => ({ question: 'What is visible?', images: [{ data: png, mimeType: 'image/png' }] });
const driver = (id, extra = {}) => ({
  id, operations: [op], models: ['model-' + id],
  execute: async () => ({ kind: 'text', text: id }), ...extra,
});
const code = (expected) => (error) => error instanceof CapabilityError && error.code === expected;

test('one caller uses either independent provider without SDK or transport dependencies', async () => {
  const runtime = new CapabilityRuntime();
  runtime.register(driver('first'));
  runtime.register(driver('second'));
  for (const id of ['first', 'second']) {
    const result = await runtime.execute(op, input(), { provider: id });
    assert.equal(result.text, id);
    assert.equal(result.provider, id);
    assert.equal(result.operation, op);
  }
  await assert.rejects(runtime.execute(op, input()), code('PROVIDER_AMBIGUOUS'));
});

test('defaults are explicit operation bindings and retain configured model', async () => {
  let selected;
  const defaults = { [op]: { provider: 'first', model: 'model-first' } };
  const runtime = new CapabilityRuntime({ defaults });
  runtime.register(driver('first', { execute: async (_op, _input, context) => {
    selected = context.model;
    assert.ok(context.signal instanceof AbortSignal);
    assert.ok(context.remainingMs > 0 && context.remainingMs <= 190_000);
    return { kind: 'text', text: 'ok' };
  } }));
  defaults[op].provider = 'external-mutation';
  const result = await runtime.execute(op, input());
  assert.equal(selected, 'model-first');
  assert.equal(result.model, 'model-first');
});

test('provider-local model ids may overlap but bare model selection must be unique', async () => {
  const runtime = new CapabilityRuntime();
  runtime.register(driver('first', { models: ['shared'] }));
  runtime.register(driver('second', { models: ['shared'] }));
  await assert.rejects(runtime.execute(op, input(), { model: 'shared' }), code('MODEL_AMBIGUOUS'));
  assert.equal((await runtime.execute(op, input(), { provider: 'second', model: 'shared' })).text, 'second');
  await assert.rejects(runtime.execute(op, input(), { provider: 'first', model: 'unknown' }), code('MODEL_NOT_FOUND'));
  await assert.rejects(runtime.execute(op, input(), { model: 'unknown' }), code('MODEL_NOT_FOUND'));
});

test('model selects its unique owner instead of the configured operation default', async () => {
  const runtime = new CapabilityRuntime({ defaults: { [op]: { provider: 'first' } } });
  runtime.register(driver('first'));
  runtime.register(driver('second'));
  assert.equal((await runtime.execute(op, input(), { model: 'model-second' })).provider, 'second');
});

test('missing or unavailable explicit/default providers do not fall back', async () => {
  const runtime = new CapabilityRuntime({ defaults: { [op]: { provider: 'missing' } } });
  runtime.register(driver('other'));
  runtime.register(driver('unavailable', { available: () => false }));
  await assert.rejects(runtime.execute(op, input()), code('PROVIDER_NOT_FOUND'));
  await assert.rejects(runtime.execute(op, input(), { provider: 'missing' }), code('PROVIDER_NOT_FOUND'));
  await assert.rejects(runtime.execute(op, input(), { provider: 'unavailable' }), code('PROVIDER_UNAVAILABLE'));
});

test('unsupported operation on an explicit provider fails before dispatch', async () => {
  const runtime = new CapabilityRuntime();
  runtime.register(driver('first'));
  await assert.rejects(runtime.execute('image.generate', { prompt: 'A square' }, { provider: 'first' }), code('PROVIDER_UNSUPPORTED'));
});

test('duplicate registrations fail and detached list metadata cannot mutate routing', async () => {
  const runtime = new CapabilityRuntime();
  const provider = driver('first');
  const dispose = runtime.register(provider);
  assert.throws(() => runtime.register(driver('first')), code('PROVIDER_DUPLICATE'));
  provider.operations.push('image.generate');
  const listed = runtime.list();
  assert.deepEqual(listed[0].operations, [op]);
  try { listed[0].operations.push('image.generate'); } catch {}
  assert.deepEqual(runtime.list()[0].operations, [op]);
  dispose();
  dispose();
  assert.deepEqual(runtime.list(), []);
  await assert.rejects(runtime.execute(op, input()), code('PROVIDER_UNAVAILABLE'));
});

test('old disposal cannot unregister a subsequent provider with the same id', async () => {
  const runtime = new CapabilityRuntime();
  const dispose = runtime.register(driver('first'));
  dispose();
  runtime.register(driver('first', { execute: async () => ({ kind: 'text', text: 'new' }) }));
  dispose();
  assert.equal((await runtime.execute(op, input())).text, 'new');
});

test('provider removal blocks new requests but does not cancel already dispatched work', async () => {
  let finish;
  let signal;
  const runtime = new CapabilityRuntime();
  const dispose = runtime.register(driver('first', { execute: (_op, _input, context) => {
    signal = context.signal;
    return new Promise((resolve) => { finish = resolve; });
  } }));
  const pending = runtime.execute(op, input());
  await Promise.resolve();
  dispose();
  assert.equal(signal.aborted, false);
  finish({ kind: 'text', text: 'finished' });
  assert.equal((await pending).text, 'finished');
});

test('unknown operation, invalid input and unknown fields never dispatch', async () => {
  let calls = 0;
  const runtime = new CapabilityRuntime();
  runtime.register(driver('first', { execute: async () => { calls++; return { kind: 'text', text: 'ok' }; } }));
  await assert.rejects(runtime.execute('unknown', {}), code('OPERATION_UNKNOWN'));
  await assert.rejects(runtime.execute(op, { ...input(), surprise: 'ignored?' }), code('INPUT_INVALID'));
  await assert.rejects(runtime.execute(op, { ...input(), question: '' }), code('INPUT_INVALID'));
  await assert.rejects(runtime.execute(op, { ...input(), images: [{ data: png, mimeType: 'image/jpeg' }] }), code('INPUT_INVALID'));
  await assert.rejects(runtime.execute(op, { ...input(), images: [{ data: Buffer.alloc(5 * 1024 * 1024 + 1), mimeType: 'image/png' }] }), code('INPUT_INVALID'));
  assert.equal(calls, 0);
});

test('pre-aborted calls never invoke the provider', async () => {
  let calls = 0;
  const runtime = new CapabilityRuntime();
  runtime.register(driver('first', { execute: async () => { calls++; return { kind: 'text', text: 'ok' }; } }));
  await assert.rejects(runtime.execute(op, input(), { signal: AbortSignal.abort() }), code('CANCELLED'));
  assert.equal(calls, 0);
});

test('cancellation reaches the provider and rejects without waiting for late results', async () => {
  let selectedSignal;
  let finish;
  const runtime = new CapabilityRuntime();
  runtime.register(driver('first', { execute: (_op, _input, { signal }) => {
    selectedSignal = signal;
    return new Promise((resolve) => { finish = resolve; });
  } }));
  const controller = new AbortController();
  const pending = runtime.execute(op, input(), { signal: controller.signal });
  await Promise.resolve();
  controller.abort(new Error('private input must not be leaked'));
  await assert.rejects(pending, (error) => code('CANCELLED')(error) && !error.message.includes('private'));
  assert.equal(selectedSignal.aborted, true);
  finish({ kind: 'text', text: 'too late' });
});

test('deadline is bounded by the runtime limit even with a larger call timeout', async () => {
  let observed;
  const runtime = new CapabilityRuntime({ timeoutMs: 20 });
  runtime.register(driver('first', { execute: (_op, _input, { signal }) => {
    observed = signal;
    return new Promise(() => {});
  } }));
  await assert.rejects(runtime.execute(op, input(), { timeoutMs: 1000 }), code('TIMEOUT'));
  assert.equal(observed.aborted, true);
});

test('synchronous local work cannot return success after its deadline', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  let signal;
  const runtime = new CapabilityRuntime({ timeoutMs: 5 });
  runtime.register(driver('local-parser', { execute: (_operation, _input, context) => {
    signal = context.signal;
    now += 40; // Advance the wall clock before the timer gets an event-loop turn.
    return { kind: 'text', text: 'late answer' };
  } }));
  await assert.rejects(runtime.execute(op, input()), code('TIMEOUT'));
  assert.equal(signal.aborted, true);
});

test('result validation cannot admit a result that crosses the deadline', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const runtime = new CapabilityRuntime({ timeoutMs: 5 });
  runtime.register(driver('local-parser', { execute: () => ({ kind: 'text', get text() {
    now += 40;
    return 'late validated answer';
  } }) }));
  await assert.rejects(runtime.execute(op, input()), code('TIMEOUT'));
});

test('native consumers can await cooperative provider cleanup after cancellation', async () => {
  let finish;
  let settled = false;
  const runtime = new CapabilityRuntime();
  runtime.register(driver('first', { execute: () => new Promise((resolve) => { finish = resolve; }) }));
  const controller = new AbortController();
  const pending = runtime.execute(op, input(), { signal: controller.signal, awaitProviderOnCancel: true })
    .then(() => { settled = true; return null; }, (error) => { settled = true; return error; });
  await Promise.resolve();
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'native tool must not settle before the driver cleanup finishes');
  finish({ kind: 'text', text: 'late result, not delivered' });
  assert.equal((await pending).code, 'CANCELLED');
});

test('silence is a valid empty transcript, not an empty vision answer', async () => {
  const runtime = new CapabilityRuntime();
  runtime.register({ id: 'stt', operations: ['speech.transcribe'], execute: async () => ({ kind: 'text', text: '' }) });
  const wav = Buffer.alloc(44 + 4800);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4800, 40);
  assert.equal((await runtime.execute('speech.transcribe', { audio: { data: wav, mimeType: 'audio/wav' } })).text, '');
});

test('invalid configuration and execution timeouts fail without timers or dispatch', async () => {
  for (const timeoutMs of [0, -1, NaN, Infinity, 190_001, 1.5]) {
    assert.throws(() => new CapabilityRuntime({ timeoutMs }), code('CONFIG_INVALID'));
  }
  const runtime = new CapabilityRuntime();
  runtime.register(driver('first'));
  await assert.rejects(runtime.execute(op, input(), { timeoutMs: 0 }), code('INPUT_INVALID'));
});

test('wrong result kinds, empty answers and unsafe sources are rejected', async () => {
  for (const result of [
    { kind: 'audio', data: png, mimeType: 'audio/wav' },
    { kind: 'text', text: '' },
    { kind: 'text', text: 'ok', sources: [{ url: 'javascript:alert(1)' }] },
  ]) {
    const runtime = new CapabilityRuntime();
    runtime.register(driver('first', { execute: async () => result }));
    await assert.rejects(runtime.execute(op, input()), code('RESULT_INVALID'));
  }
});

test('provider cannot spoof the authoritative provider or operation identity', async () => {
  const runtime = new CapabilityRuntime();
  runtime.register(driver('first', { execute: async () => ({ kind: 'text', text: 'ok', provider: 'spoof', operation: 'spoof' }) }));
  const result = await runtime.execute(op, input());
  assert.equal(result.provider, 'first');
  assert.equal(result.operation, op);
});

test('untyped provider errors are sanitized and never trigger another provider', async () => {
  let fallbackCalls = 0;
  const runtime = new CapabilityRuntime();
  runtime.register(driver('first', { execute: async () => { throw new Error('Bearer private-key-fixture'); } }));
  runtime.register(driver('second', { execute: async () => { fallbackCalls++; return { kind: 'text', text: 'not called' }; } }));
  await assert.rejects(runtime.execute(op, input(), { provider: 'first' }), (error) =>
    code('PROVIDER_FAILED')(error) && !error.message.includes('private-key-fixture'));
  assert.equal(fallbackCalls, 0);
});
