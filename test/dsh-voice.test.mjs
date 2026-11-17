import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resampleRecording, maxRecordingBytes } from '../extensions/dsh-voice-input/resample.mjs';
import { createSpeechProvider, apply } from '../extensions/dsh-voice-input/index.mjs';
import { wavPcm } from '../src/capabilities/contracts.mjs';
import { createHostBackend } from '../extensions/dsh-capabilities/backend.mjs';

function recording(frames = 1600, sample = () => 0) {
  const data = Buffer.alloc(44 + frames * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) data.writeInt16LE(sample(i), 44 + i * 2);
  return data;
}
const invalid = (error) => error.code === 'INPUT_INVALID';

test('recording conversion actually interpolates 16k PCM into 24k samples and preserves source', () => {
  const source = recording(1600, (i) => i * 3 - 2400); const before = Buffer.from(source);
  const result = resampleRecording(source); const pcm = wavPcm(result.data);
  assert.equal(result.audioSeconds, 0.1); assert.equal(pcm.length, 4800);
  assert.equal(result.data.readUInt32LE(24), 24000); assert.equal(result.data.readUInt32LE(28), 48000);
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => pcm.readInt16LE(i * 2)), [-2400, -2398, -2396, -2394, -2392, -2390]);
  assert.equal(pcm.readInt16LE(pcm.length - 2), source.readInt16LE(source.length - 2));
  assert.deepEqual(source, before); assert.notEqual(result.data.buffer, source.buffer);
});

test('conversion preserves clipped PCM values and handles a subarray recording', () => {
  const source = recording(1600, (i) => i % 2 ? 32767 : -32768);
  const padded = Buffer.concat([Buffer.alloc(7), source, Buffer.alloc(9)]);
  const pcm = wavPcm(resampleRecording(padded.subarray(7, 7 + source.length)).data);
  assert.equal(pcm.readInt16LE(0), -32768); assert.equal(pcm.readInt16LE(6), -32768);
  assert.equal(pcm.readInt16LE(pcm.length - 2), 32767);
});

test('canonical input validation rejects wrong headers, lengths, formats and duration', () => {
  const cases = [[], new Uint8Array(44), recording(1599), recording(640001), Buffer.concat([recording(), Buffer.from([0])])];
  for (const [offset, bytes] of [[0, Buffer.from('RIFX')], [8, Buffer.from('AVI ')], [12, Buffer.from('JUNK')], [36, Buffer.from('LIST')]]) {
    const data = recording(); bytes.copy(data, offset); cases.push(data);
  }
  for (const [offset, size, value] of [[4, 4, 0], [16, 4, 18], [20, 2, 3], [22, 2, 2], [24, 4, 24000], [28, 4, 1], [32, 2, 4], [34, 2, 8], [40, 4, 1]]) {
    const data = recording(); data.writeUIntLE(value, offset, size); cases.push(data);
  }
  for (const data of cases) assert.throws(() => resampleRecording(data), invalid);
});

test('conversion admits exactly forty seconds and stays inside core and Remote byte bounds', () => {
  const input = recording(640000);
  assert.equal(input.length, maxRecordingBytes);
  const result = resampleRecording(input);
  assert.equal(result.audioSeconds, 40); assert.equal(wavPcm(result.data).byteLength, 1920000);
});

test('speech provider delegates canonical media to operation default and returns native timing fields', async () => {
  const calls = []; const signal = new AbortController().signal;
  const provider = createSpeechProvider({ execute: async (...args) => { calls.push(args); return { kind: 'text', text: 'A microphone fixture.', provider: 'replacement' }; } });
  assert.equal(provider.info.id, 'oh-my-harness'); assert.equal(provider.info.location, 'cloud');
  assert.deepEqual(provider.info.languages, ['auto']);
  const result = await provider.transcribe({ audio: recording(), language: 'auto' }, signal);
  assert.equal(result.text, 'A microphone fixture.'); assert.equal(result.audioSeconds, 0.1);
  assert.ok(Number.isFinite(result.inferenceSeconds) && result.inferenceSeconds >= 0);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'speech.transcribe');
  assert.equal(calls[0][1].audio.mimeType, 'audio/wav'); assert.equal(wavPcm(calls[0][1].audio.data).length, 4800);
  assert.deepEqual(calls[0][2], { signal });
});

test('invalid recording, unsupported language and pre-cancellation never dispatch speech', async () => {
  let calls = 0; const provider = createSpeechProvider({ execute: async () => { calls++; return { kind: 'text', text: 'unexpected' }; } });
  await assert.rejects(provider.transcribe({ audio: recording(), language: 'zh' }, new AbortController().signal), invalid);
  await assert.rejects(provider.transcribe({ audio: recording(1599), language: 'auto' }, new AbortController().signal), invalid);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(provider.transcribe({ audio: recording(), language: 'auto' }, abort.signal), (error) => error.name === 'AbortError');
  assert.equal(calls, 0);
});

test('silence remains a successful empty transcription', async () => {
  const provider = createSpeechProvider({ execute: async () => ({ kind: 'text', text: '' }) });
  assert.equal((await provider.transcribe({ audio: recording(), language: 'auto' }, new AbortController().signal)).text, '');
});

test('same speech adapter uses replaceable backend defaults and never falls back from removed default', async (t) => {
  for (const selected of ['first', 'second']) {
    const calls = [];
    const backend = createHostBackend({ credentials: {} }, { defaults: { 'speech.transcribe': { provider: selected } } });
    t.after(() => backend.dispose());
    const disposers = {};
    for (const id of ['first', 'second']) disposers[id] = backend.register({
      id, operations: ['speech.transcribe'], execute: async (op, input) => {
        calls.push({ id, op, bytes: input.audio.data.length }); return { kind: 'text', text: id };
      },
    });
    const provider = createSpeechProvider(backend);
    const result = await provider.transcribe({ audio: recording(), language: 'auto' }, new AbortController().signal);
    assert.equal(result.text, selected); assert.deepEqual(calls, [{ id: selected, op: 'speech.transcribe', bytes: 4844 }]);
    disposers[selected]();
    await assert.rejects(provider.transcribe({ audio: recording(), language: 'auto' }, new AbortController().signal), (error) => error.code === 'PROVIDER_NOT_FOUND');
    assert.equal(calls.length, 1);
  }
});

test('speech cancellation reaches backend and waits for cooperative cleanup before rejecting', async (t) => {
  let start, close; const started = new Promise((resolve) => { start = resolve; });
  const backend = createHostBackend({ credentials: {} }, {}); t.after(() => backend.dispose());
  backend.register({ id: 'source', operations: ['speech.transcribe'], execute: (_op, _input, { signal }) => new Promise((resolve) => {
    start(); signal.addEventListener('abort', () => { close = () => resolve({ kind: 'text', text: 'late' }); }, { once: true });
  }) });
  const abort = new AbortController(); let settled = false;
  const pending = createSpeechProvider(backend).transcribe({ audio: recording(), language: 'auto' }, abort.signal).catch((error) => { settled = true; return error; });
  await started; abort.abort(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(typeof close, 'function'); close();
  assert.equal((await pending).code, 'CANCELLED');
});

test('Host speech registration owns its async disposer without owning the shared backend', async () => {
  let registered, disposed = false; const effects = []; const backend = { execute: async () => ({ kind: 'text', text: 'native' }) };
  apply({ omhCapabilities: backend, speechToText: { register: (value) => { registered = value; return async () => { await Promise.resolve(); disposed = true; }; } }, effect: (setup) => effects.push(setup()) });
  assert.equal(registered.info.id, 'oh-my-harness'); assert.equal(effects.length, 1);
  await effects[0](); assert.equal(disposed, true);
});


const tick = () => new Promise((resolve) => setImmediate(resolve));
const clientCode = readFileSync(new URL('../extensions/dsh-voice-input/client.js', import.meta.url), 'utf8');
function catalog(id = 'oh-my-harness', phase = 'ready', language = 'auto') {
  return { providers: [{ id, languages: ['auto'], preparation: { phase } }], selection: { providerId: id, language }, maxDurationSeconds: 40, maxAudioBytes: 1280044 };
}
function events() {
  const listeners = new Map();
  return { addEventListener: (name, callback) => { const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set); },
    removeEventListener: (name, callback) => listeners.get(name)?.delete(callback),
    dispatch: (name, value = {}) => { for (const cb of listeners.get(name) ?? []) cb(value); },
    count: () => [...listeners.values()].reduce((sum, value) => sum + value.size, 0) };
}
function createClient({ hooks, recordingEnv = {}, mountWait, uiFailure, reuse = false } = {}) {
  let entry; const registrations = []; const cleanups = []; const scopeCleanups = []; const calls = []; const timers = new Map();
  const windowEvents = events(), documentEvents = events();
  const sandbox = { window: { ...windowEvents, __ModuleLoader__: { load: (value) => { entry = value; } } },
    document: { ...documentEvents, hidden: false }, navigator: {}, console, AbortController, DOMException, Uint8Array, DataView,
    Blob, btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
    setTimeout: (fn, delay) => { const id = {}; timers.set(id, { fn, delay }); return id; }, clearTimeout: (id) => timers.delete(id), ...recordingEnv };
  vm.runInNewContext(clientCode, sandbox, { filename: 'voice-client.js' });
  const react = hooks ?? { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [initial, () => {}], useEffect: () => {}, useLayoutEffect: () => {}, useRef: (value) => ({ current: value }) };
  class CarrierError extends Error {}
  const contribution = { package: '@deepseek-ai/dsh-experimental-api-speech-to-text', descriptors: [{ namespace: 'speech' }] };
  const modules = { react, '@deepseek-ai/dsh-client-ui-primitives': new Proxy({}, { get: (_, name) => name }),
    '@deepseek-ai/dsh-experimental-api-speech-to-text/remote': { default: contribution, TYPERT_REMOTE: contribution },
    '@deepseek-ai/dsh-api-gateway/client': { RemoteStreamCarrierError: CarrierError } };
  const exported = entry.factory((name) => { assert.ok(modules[name], 'declared client module ' + name); return modules[name]; });
  let emit, fail, streamClosed = false, currentCatalog = catalog();
  const readyQueue = []; let wake;
  const stream = { async *[Symbol.asyncIterator]() { while (!streamClosed) { if (!readyQueue.length) await new Promise((resolve) => { wake = resolve; }); if (streamClosed) return; const value = readyQueue.shift(); yield { value, accept: () => calls.push('accept') }; } },
    dispose: async () => { calls.push('stream.dispose'); streamClosed = true; wake?.(); } };
  const speech = { catalog: async () => ({ ok: true, value: currentCatalog }), transcribe: async (request, signal) => { calls.push({ request, signal }); return { ok: true, value: { text: 'dictated' } }; }, configure: async () => ({ ok: true }) };
  const remote = { speech, $mount: async (value) => { calls.push({ mount: value }); if (mountWait) await mountWait; return async () => { calls.push('remote.dispose'); }; },
    $stream: (options) => { emit = (value) => { currentCatalog = value; readyQueue.push(value); wake?.(); }; fail = options.carrierFailed; calls.push('stream.open'); return stream; } };
  const scope = { effect: (setup) => { const value = setup(); if (value) scopeCleanups.push(value); },
    locale: { register: (ns, dicts) => { assert.equal(ns, 'omh-voice'); assert.ok(dicts.en && dicts.zh); return () => calls.push('locale.dispose'); } },
    slots: { inject: (name, cb) => cb(), register: (options, component) => { registrations.push({ ...options, component, actions: options.inject() }); return () => calls.push('slot.dispose'); } },
    get: () => ({ openBundle: (name) => calls.push({ settings: name }) }), remote };
  const ctx = { remote, effect: (setup) => { const value = setup(); if (value) { Promise.resolve(value).catch(() => {}); cleanups.push(value); } return value; },
    get: (name) => reuse && name === 'remote.speech' ? speech : undefined,
    inject: (deps, cb) => { assert.deepEqual([...deps], ['remote.speech', 'slots', 'locale']); calls.push('ui.inject');
      const loading = Promise.resolve().then(() => { if (uiFailure) throw uiFailure; cb(scope); });
      return { then: (yes, no) => loading.then(() => yes?.({ dispose() {} }), no), dispose: async () => { calls.push('ui.dispose'); for (const cleanup of [...scopeCleanups].reverse()) await cleanup(); } }; } };
  exported.apply(ctx);
  return { calls, registrations, timers, sandbox, exported, contribution, remote, emit: (value) => emit(value), fail: (error) => fail(error),
    ready: async () => { for (const value of cleanups) if (typeof value !== 'function') await value; await tick(); },
    dispose: async () => { for (const value of [...cleanups].reverse()) { const cleanup = await value; if (typeof cleanup === 'function') await cleanup(); } },
    listeners: () => windowEvents.count() + documentEvents.count() };
}

test('voice client mounts generated default contribution and disposes a non-Promise Fiber before Remote', async () => {
  const client = createClient(); await client.ready();
  assert.equal(client.calls.find((item) => item.mount)?.mount, client.contribution);
  assert.deepEqual(client.registrations.map((item) => item.name), ['conversation.input.activity', 'plugins.bundle.config', 'plugins.bundle.activation']);
  assert.ok(client.registrations.every((item) => item.locale === 'omh-voice'));
  assert.ok(client.registrations.slice(1).every((item) => item.key === 'oh-my-harness-voice-input'));
  await client.dispose();
  assert.ok(client.calls.indexOf('ui.dispose') < client.calls.indexOf('remote.dispose'));
  assert.ok(client.calls.includes('stream.dispose'));
});

test('voice client startup failure withdraws both the UI fiber and its Remote mount', async () => {
  const failure = new Error('UI registration failed'); const client = createClient({ uiFailure: failure });
  await assert.rejects(client.ready(), (error) => error === failure);
  assert.ok(client.calls.includes('ui.dispose')); assert.ok(client.calls.includes('remote.dispose'));
});

test('[defect-probing] voice setup and recovery navigate to capability settings without changing card ownership', async (t) => {
  const client = createClient(); t.after(() => client.dispose()); await client.ready();
  for (const registration of client.registrations) registration.actions.openSettings();
  assert.deepEqual(client.calls.filter((value) => value.settings).map((value) => value.settings), ['oh-my-harness', 'oh-my-harness', 'oh-my-harness']);
  assert.ok(client.registrations.slice(1).every((value) => value.key === 'oh-my-harness-voice-input'));
});

test('voice peer declaration identifies the separately configured capability bundle', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extensions/dsh-voice-input/package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.peerDependencies['oh-my-harness'], '^0.2.0');
  for (const name of ['oh-my-harness', '@deepseek-ai/dsh-experimental-speech-to-text', '@deepseek-ai/dsh-experimental-api-speech-to-text'])
    assert.equal(manifest.peerDependenciesMeta[name]?.optional, true);
  assert.equal(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots'), false);
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-api-gateway'));
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-primitives'));
});


function renderer() {
  const values = [], effects = []; let cursor = 0, scheduled = [];
  const effect = (setup, deps) => { const at = cursor++; const old = effects[at]; if (!old || deps.some((value, i) => value !== old.deps[i])) scheduled.push(() => { old?.cleanup?.(); effects[at] = { deps, cleanup: setup() }; }); };
  const hooks = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => { const at = cursor++; if (!(at in values)) values[at] = initial; return [values[at], (value) => { values[at] = typeof value === 'function' ? value(values[at]) : value; }]; },
    useRef: (initial) => { const at = cursor++; return values[at] ??= { current: initial }; },
    useEffect: effect, useLayoutEffect: effect, useSyncExternalStore: (_subscribe, snapshot) => snapshot() };
  return { hooks, render: (component, props) => { cursor = 0; scheduled = []; const tree = component(props); for (const commit of scheduled) commit(); return tree; },
    unmount: () => { for (const value of effects) value?.cleanup?.(); } };
}
function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap((child) => Array.isArray(child) ? child.flatMap(nodes) : nodes(child))]; }
function button(tree, label) { return nodes(tree).find((node) => node.type === 'Button' && (node.props['aria-label'] === label || node.children.includes(label))); }
async function composer(options = {}) {
  const ui = renderer(); const client = createClient({ ...options, hooks: ui.hooks }); await client.ready(); client.emit(catalog()); await tick();
  const registration = client.registrations[0]; let span = 0; const insertions = []; let insertAccepted = true;
  const props = { ...registration.actions, sessionId: 'session-a', locked: false, onActiveChange: () => {}, t: (key) => key,
    inputActions: { captureInsertion: () => ({ revision: ++span }), insertText: (text, selection) => { insertions.push({ text, selection }); return insertAccepted; }, submit: () => assert.fail('dictation never submits') } };
  const captures = [];
  props.createRecording = () => { const capture = { start: async (onError) => { capture.onError = onError; }, stop: async () => recording(),
    dispose: async () => { capture.disposed = true; } }; captures.push(capture); return capture; };
  return { client, props, captures, insertions, ui, render: () => ui.render(registration.component, props), refuseInsert: () => { insertAccepted = false; }, acceptInsert: () => { insertAccepted = true; },
    close: async () => { ui.unmount(); await client.dispose(); } };
}

test('voice readiness observes provider changes and reconnects without admitting other recognizers', async () => {
  const c = await composer();
  assert.equal(button(c.render(), 'start').props.disabled, false);
  for (const value of [catalog('sensevoice'), catalog('oh-my-harness', 'unprepared'), catalog('oh-my-harness', 'failed'), catalog('oh-my-harness', 'ready', 'zh')]) {
    c.client.emit(value); await tick(); button(c.render(), 'setupPrompt').props.onClick(); assert.equal(c.captures.length, 0);
  }
  c.client.emit(catalog()); await tick(); c.client.fail(new Error('carrier disconnected'));
  button(c.render(), 'setupPrompt').props.onClick(); assert.equal(c.captures.length, 0);
  c.client.emit(catalog()); await tick(); assert.ok(button(c.render(), 'start'));
  let observed = 0; const unsubscribe = c.props.readiness.subscribe(() => observed++);
  c.client.emit(catalog('oh-my-harness', 'standby')); await tick(); assert.equal(observed, 1); unsubscribe();
  c.client.emit(catalog('oh-my-harness', 'waking')); await tick(); assert.equal(observed, 1); assert.ok(button(c.render(), 'start'));
  assert.ok(c.client.calls.filter((value) => value === 'accept').length >= 7);
  await c.close(); assert.equal(c.client.listeners(), 0);
});

test('dictation sends canonical base64 and inserts exactly once into the captured draft without submitting', async () => {
  const c = await composer(); button(c.render(), 'start').props.onClick(); await tick();
  assert.ok(button(c.render(), 'stop')); assert.equal(c.client.timers.size, 1);
  button(c.render(), 'stop').props.onClick(); await tick();
  const sent = c.client.calls.find((value) => value.request);
  assert.deepEqual(Object.keys(sent.request).sort(), ['audioBase64', 'language', 'providerId']);
  assert.equal(sent.request.audioBase64, recording().toString('base64')); assert.equal(sent.request.providerId, 'oh-my-harness'); assert.equal(sent.request.language, 'auto');
  assert.deepEqual(c.insertions, [{ text: 'dictated', selection: { revision: 1 } }]);
  assert.ok(button(c.render(), 'start')); assert.equal(c.client.timers.size, 0);
  await c.close();
});

test('changed drafts retain transcription for explicit fresh-span insertion and session changes discard it', async () => {
  const c = await composer(); c.refuseInsert(); button(c.render(), 'start').props.onClick(); await tick(); button(c.render(), 'stop').props.onClick(); await tick();
  assert.ok(button(c.render(), 'insert')); c.acceptInsert(); button(c.render(), 'insert').props.onClick();
  assert.equal(c.insertions.length, 2); assert.deepEqual(c.insertions[1].selection, { revision: 2 });
  c.refuseInsert(); button(c.render(), 'start').props.onClick(); await tick(); button(c.render(), 'stop').props.onClick(); await tick();
  assert.ok(button(c.render(), 'discard')); c.props.sessionId = 'session-b'; c.render();
  assert.ok(button(c.render(), 'start')); assert.equal(button(c.render(), 'insert'), undefined);
  await c.close();
});

test('cancel during permission or transcription invalidates late results and clears microphone activity', async (t) => {
  for (const phase of ['permission', 'transcription', 'session']) await t.test(phase, async () => {
    const c = await composer(); let resolve;
    const pending = new Promise((done) => { resolve = done; }); let disposed = 0;
    c.props.createRecording = () => ({ start: () => phase === 'permission' ? pending : Promise.resolve(), stop: async () => recording(), dispose: async () => { disposed++; } });
    c.props.transcribe = { transcribe: (_request, signal) => { c.signal = signal; return pending; } };
    button(c.render(), 'start').props.onClick(); await tick();
    if (phase !== 'permission') { button(c.render(), 'stop').props.onClick(); await tick(); }
    if (phase === 'session') { c.props.sessionId = 'session-b'; c.render(); } else button(c.render(), 'cancel').props.onClick();
    resolve({ ok: true, value: { text: 'too late' } }); await tick();
    assert.equal(c.insertions.length, 0); assert.equal(disposed, 1); assert.equal(c.client.timers.size, 0);
    if (c.signal) assert.equal(c.signal.aborted, true);
    assert.ok(button(c.render(), 'start')); await c.close();
  });
});

test('blur visibility Escape interruption and locked composers stop or refuse capture', async (t) => {
  for (const reason of ['blur', 'visibility', 'escape', 'interruption']) await t.test(reason, async () => {
    const c = await composer(); c.props.locked = true; assert.equal(button(c.render(), 'setupPrompt').props.disabled, true);
    c.props.locked = false; button(c.render(), 'start').props.onClick(); await tick();
    if (reason === 'blur') c.client.sandbox.window.dispatch('blur');
    if (reason === 'visibility') { c.client.sandbox.document.hidden = true; c.client.sandbox.document.dispatch('visibilitychange'); }
    if (reason === 'escape') c.client.sandbox.document.dispatch('keydown', { key: 'Escape', preventDefault() {} });
    if (reason === 'interruption') c.captures[0].onError(new Error('microphone removed'));
    await tick(); assert.equal(c.client.timers.size, 0); assert.equal(c.insertions.length, 0);
    if (reason !== 'interruption') assert.equal(c.captures[0].disposed, true);
    await c.close(); assert.equal(c.client.listeners(), 0);
  });
});

test('already mounted speech namespace remains owned by its existing contributor', async () => {
  const c = createClient({ reuse: true }); await c.ready();
  assert.equal(c.calls.some((value) => value.mount), false); assert.equal(c.registrations.length, 3);
  await c.dispose(); assert.equal(c.calls.includes('remote.dispose'), false); assert.ok(c.calls.includes('ui.dispose'));
});

test('microphone permission grants arriving after disposal release tracks without starting a recorder', async () => {
  let grant; let stopped = 0, recorders = 0;
  const c = createClient({ recordingEnv: { navigator: { mediaDevices: { getUserMedia: () => new Promise((resolve) => { grant = resolve; }) } }, MediaRecorder: class { constructor() { recorders++; } } } });
  await c.ready(); const capture = c.registrations[0].actions.createRecording(); const starting = capture.start();
  const rejection = assert.rejects(starting, (error) => error.kind === 'cancelled');
  const disposal = capture.dispose(); assert.equal(capture.dispose(), disposal); await disposal;
  grant({ getTracks: () => [{ stop: () => { stopped++; } }] }); await rejection;
  assert.equal(stopped, 1); assert.equal(recorders, 0); await c.dispose();
});

test('microphone denial setup failures and interruptions release capture resources', async (t) => {
  for (const reason of ['permission', 'deviceMissing', 'setup', 'interruption']) await t.test(reason, async () => {
    let stopped = 0, closed = 0, ended; const track = { stop: () => { stopped++; }, addEventListener: (_name, cb) => { ended = cb; } };
    const c = createClient({ recordingEnv: { navigator: { mediaDevices: { getUserMedia: async () => {
      if (reason === 'permission') throw new DOMException('denied', 'NotAllowedError');
      if (reason === 'deviceMissing') throw new DOMException('missing', 'NotFoundError');
      return { getTracks: () => [track] };
    } } }, AudioContext: class { state = 'running'; close() { closed++; this.state = 'closed'; return Promise.resolve(); } },
    MediaRecorder: class { state = 'inactive'; constructor() { if (reason === 'setup') throw new Error('bad recorder'); } start() { this.state = 'recording'; } stop() { this.state = 'inactive'; } } } });
    await c.ready(); const capture = c.registrations[0].actions.createRecording(); let failure;
    if (reason === 'interruption') { await capture.start((error) => { failure = error; }); ended(); await tick(); assert.equal(failure.kind, 'interrupted'); }
    else await assert.rejects(capture.start(), (error) => reason === 'setup' ? error.message === 'bad recorder' : error.kind === reason);
    await capture.dispose();
    assert.equal(stopped, reason === 'setup' || reason === 'interruption' ? 1 : 0);
    assert.equal(closed, reason === 'setup' || reason === 'interruption' ? 1 : 0);
    await c.dispose();
  });
});
