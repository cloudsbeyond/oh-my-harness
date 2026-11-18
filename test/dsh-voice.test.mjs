import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resampleRecording, maxRecordingBytes, maxRecordingSeconds } from '../extensions/dsh-voice-input/resample.mjs';
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


test('cloud deployment reuses official speech rows and adds no second browser client', () => {
  const voice = new URL('../extensions/dsh-voice-input/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('package.json', voice), 'utf8'));
  assert.equal(manifest.dsh.client, undefined);
  assert.equal(manifest.exports['./client'], undefined);
  assert.ok(!manifest.files.includes('client.js'));
  const patch = readFileSync(new URL(manifest.dsh.bundle.patch, voice), 'utf8');
  assert.deepEqual([...patch.matchAll(/^\s*- id: (\S+)$/gm)].map((match) => match[1]), ['api-speech-to-text', 'omh-voice-input']);
  assert.match(patch, new RegExp('maxDurationSeconds: ' + maxRecordingSeconds + '$', 'm'));
  assert.match(patch, new RegExp('maxAudioBytes: ' + maxRecordingBytes + '$', 'm'));
  assert.equal(manifest.peerDependencies['oh-my-harness'], '^0.2.0');
  assert.equal(manifest.peerDependenciesMeta['@deepseek-ai/dsh-experimental-speech-to-text']?.optional, true);
});
