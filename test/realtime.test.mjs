import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createRealtimeExecutor } from '../src/capabilities/realtime.mjs';

function encodeWav(pcm = Buffer.alloc(4800)) {
  const data = Buffer.alloc(44 + pcm.length);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(24000, 24); data.writeUInt32LE(48000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(pcm.length, 40); pcm.copy(data, 44);
  return data;
}
const profile = { realtimeModel: 'realtime-test', transcriptionModel: 'transcription-test' };
class FakeSocket extends EventTarget {
  static instances = [];
  constructor(url, options) {
    super(); this.url = url; this.options = options; this.sent = []; this.closed = false; this.readyState = 1;
    FakeSocket.instances.push(this);
    queueMicrotask(() => this.emit({ type: 'session.created' }));
  }
  emit(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  send(raw) {
    const event = JSON.parse(raw); this.sent.push(event);
    if (event.type === 'session.update') queueMicrotask(() => this.emit({ type: 'session.updated' }));
    if (event.type === 'input_audio_buffer.commit') queueMicrotask(() => {
      this.emit({ type: 'input_audio_buffer.committed' });
      this.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Fixture words' });
    });
    if (event.type === 'response.create') queueMicrotask(() => {
      this.emit({ type: 'response.output_audio.delta', delta: Buffer.alloc(4800).toString('base64') });
      this.emit({ type: 'response.output_audio_transcript.delta', delta: 'Hello fixture' });
      this.emit({ type: 'response.done', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Spoken evidence' }] }] } });
    });
  }
  close() { this.closed = true; this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
const execute = (extra = {}) => createRealtimeExecutor({ upstream: new URL('http://127.0.0.1:8317/v1/'), token: 'test-upstream-key-fixture', WebSocketImpl: FakeSocket, ...extra });

test('audio operations run without MCP and preserve WAV/transcript results', async () => {
  const audio = { data: encodeWav(), mimeType: 'audio/wav' };
  const transcribed = await execute()('speech.transcribe', { audio }, profile, new AbortController().signal);
  assert.deepEqual(transcribed, { kind: 'text', text: 'Fixture words', model: 'transcription-test' });
  const synthesized = await execute()('speech.synthesize', { text: 'Hello fixture' }, profile, new AbortController().signal);
  assert.equal(synthesized.kind, 'audio');
  assert.equal(synthesized.mimeType, 'audio/wav');
  assert.deepEqual(synthesized.data, encodeWav());
  assert.equal(synthesized.transcript, 'Hello fixture');
  const answer = await execute()('audio.inspect', { audio, question: 'What was said?' }, profile, new AbortController().signal);
  assert.equal(answer.text, 'Spoken evidence');
  assert.ok(FakeSocket.instances.every((socket) => socket.closed));
  assert.equal(FakeSocket.instances[0].options.headers.Authorization, 'Bearer test-upstream-key-fixture');
});

test('a completed silent transcription is an empty transcript rather than a provider failure', async () => {
  class SilentSocket extends FakeSocket {
    send(raw) {
      if (JSON.parse(raw).type === 'input_audio_buffer.commit') {
        queueMicrotask(() => this.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: '' }));
        return;
      }
      super.send(raw);
    }
  }
  const result = await execute({ WebSocketImpl: SilentSocket })('speech.transcribe', { audio: { data: encodeWav(), mimeType: 'audio/wav' } }, profile, new AbortController().signal);
  assert.equal(result.kind, 'text'); assert.equal(result.text, ''); assert.equal(FakeSocket.instances.at(-1).closed, true);
});

test('audio cancellation closes the actual socket and pre-abort never connects', async () => {
  class PendingSocket extends FakeSocket { send() {} }
  const controller = new AbortController();
  const pending = execute({ WebSocketImpl: PendingSocket })('speech.synthesize', { text: 'Hello' }, profile, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancel|timed out/i);
  assert.equal(FakeSocket.instances.at(-1).closed, true);
  const count = FakeSocket.instances.length;
  await assert.rejects(execute()('speech.synthesize', { text: 'Hello' }, profile, AbortSignal.abort()));
  assert.equal(FakeSocket.instances.length, count);
});

test('failed or empty audio is rejected rather than delivered as a successful artifact', async () => {
  class EmptySocket extends FakeSocket {
    send(raw) {
      if (JSON.parse(raw).type === 'session.update') queueMicrotask(() => this.emit({ type: 'session.updated' }));
      if (JSON.parse(raw).type === 'response.create') queueMicrotask(() => this.emit({ type: 'response.done', response: { status: 'completed' } }));
    }
  }
  await assert.rejects(execute({ WebSocketImpl: EmptySocket })('speech.synthesize', { text: 'Hello' }, profile, new AbortController().signal), /complete PCM audio/);
  assert.equal(FakeSocket.instances.at(-1).closed, true);
});

test('real Node WebSocket transport sends upstream authentication in the upgrade handshake', async (t) => {
  let headers;
  const server = createServer();
  server.on('upgrade', (req, socket) => { headers = req.headers; socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const run = createRealtimeExecutor({ upstream: new URL(`http://127.0.0.1:${server.address().port}/v1/`), token: 'test-upstream-key-fixture' });
  await assert.rejects(run('speech.synthesize', { text: 'Hello' }, profile, new AbortController().signal));
  assert.equal(headers.authorization, 'Bearer test-upstream-key-fixture');
});
