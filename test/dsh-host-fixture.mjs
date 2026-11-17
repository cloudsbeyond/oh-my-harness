import { createHash } from 'node:crypto';
import path from 'node:path';
import { createHostBackend } from '../extensions/dsh-capabilities/backend.mjs';

export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=', 'base64');
export function wave() {
  const data = Buffer.alloc(44 + 4800); data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(24000, 24); data.writeUInt32LE(48000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(4800, 40); return data;
}
const hash = (data) => 'sha256:' + createHash('sha256').update(data).digest('hex');
const answer = (text) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
export function hostFixture() {
  const doc = Buffer.from('name,value\none,7\n');
  const files = new Map([['/workspace/values.csv', doc], ['/private/secret.csv', doc]]);
  const filePaths = new Map(); const imagePaths = new Map();
  const calls = []; const reads = []; let messages = [];
  const session = { deriveMessages: () => messages };
  const ctx = {
    credentials: { resolve: async () => ({ value: 'test-native-provider-key' }) },
    workingDirectory: { ensure: async () => '/workspace' }, sandboxPolicy: { resolve: () => ({ workspaceRoot: '/workspace', mode: 'danger-full-access' }) },
    fs: {
      resolve: async (value, options = {}) => ({ canonical: path.posix.resolve(options.cwd ?? '/workspace', value) }),
      contains: (a, b) => a.canonical === b.canonical || b.canonical.startsWith(a.canonical + '/'),
      processPath: (target) => target.canonical, processPathFromHostPath: (value) => value,
      stat: async (target) => files.has(target.canonical) ? { type: 'file', version: 'v1', size: files.get(target.canonical).length } : undefined,
      readBytes: async (target, signal, max) => { signal.throwIfAborted(); reads.push(target.canonical); const data = files.get(target.canonical); if (data.length > max) throw new Error('FS_TOO_LARGE'); return data; },
    },
    attachments: {
      saveImage: async ({ data, mediaType, name }) => { const id = hash(data), saved = '/store/preview-' + name; files.set(saved, data); imagePaths.set(id, saved); return { attachmentId: id, bytes: data.length, mediaType, width: 1, height: 1, name }; },
      saveFile: async ({ data, name }) => { const id = hash(data), saved = '/store/' + name; files.set(saved, data); filePaths.set(id, saved); return { attachmentId: id, bytes: data.length, name }; },
      fileHostPath: (ref) => filePaths.get(ref.attachmentId), imageHostPath: (ref) => imagePaths.get(ref.attachmentId),
    },
  };
  const operations = ['image.inspect', 'image.generate', 'image.edit', 'document.inspect', 'speech.synthesize', 'speech.transcribe', 'audio.inspect'];
  const config = { providers: {
    primary: { protocol: 'responses', baseURL: 'https://provider.example.com/v1', credential: 'TEST_KEY', models: ['test-model'], operations, imageModel: 'image-model', realtimeModel: 'realtime-model', transcriptionModel: 'transcription-model' },
    video: { protocol: 'chat', baseURL: 'https://video.example.com/v1', credential: 'TEST_KEY', models: ['video-model'], operations: ['video.inspect'] },
  }, defaults: Object.fromEntries(operations.map((op) => [op, { provider: 'primary' }])) };
  const backend = createHostBackend(ctx, config, {
    request: async (base, _key, route, payload) => {
      calls.push({ base, route, payload });
      if (payload.tools?.[0]?.type === 'image_generation') return { status: 'completed', output: [{ type: 'image_generation_call', status: 'completed', result: png.toString('base64') }] };
      if (route === 'chat/completions') return { choices: [{ finish_reason: 'stop', message: { content: 'Fixture video analysis' } }] };
      return answer('Fixture analysis');
    },
    realtimeFactory: () => async (op) => op === 'speech.synthesize'
      ? { kind: 'audio', data: wave(), mimeType: 'audio/wav', transcript: 'Spoken fixture', model: 'realtime-model' }
      : { kind: 'text', text: op === 'speech.transcribe' ? 'Transcribed fixture' : 'Heard fixture', model: 'realtime-model' },
  });
  const exec = { agent: { session }, signal: new AbortController().signal };
  return { ctx, backend, exec, files, calls, reads, setMessages: (value) => { messages = value; },
    async upload(name = 'uploaded.csv') { const ref = await ctx.attachments.saveFile({ data: doc, name }); const file = ctx.attachments.fileHostPath(ref); return { file, ref }; } };
}
