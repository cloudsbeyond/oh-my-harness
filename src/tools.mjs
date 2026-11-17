import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { modelId } from './config.mjs';
import { createProtocolRuntime } from './capabilities/protocol-provider.mjs';
import { documentMimeType, imageMimeType, operationCapabilities } from './capabilities/contracts.mjs';
import { decodeFileBase64, maxFileInputBytes, prompt } from './capabilities/media.mjs';

// Retain helper exports for existing imports while their owner is now transport-neutral.
export { chatText, decodeFileBase64, maxFileInputBytes, messagesText, prompt, requestUpstream, responseText } from './capabilities/media.mjs';
export function textResult(data) { return { content: [{ type: 'text', text: JSON.stringify(data) }] }; }

const question = z.string().trim().min(1).max(1600);
const providerInput = z.string().max(40).optional();
const selection = { provider: providerInput, model: modelId.optional() };
const base64 = z.string().min(1).max(Math.ceil(maxFileInputBytes / 3) * 4);
const fileInput = { ...selection, filename: z.string().min(1).max(255), file_base64: base64, question };
const audioInput = z.string().min(1).max(Math.ceil((2 * 1024 * 1024 + 44) / 3) * 4);
const wireImage = (encoded) => { const data = decodeFileBase64(encoded); return { data, mimeType: imageMimeType(data) }; };
const wireAudio = (encoded) => ({ data: decodeFileBase64(encoded), mimeType: 'audio/wav' });

function wireFile(args, video = false) {
  const data = decodeFileBase64(args.file_base64);
  return { data, name: args.filename, mimeType: video ? 'video/mp4' : documentMimeType(args.filename, data) };
}

const definitions = [
  ['web_search', 'web.search', 'Search the public web with a configured provider. Responses search can read an exact public URL and find text on it. Messages search uses URL and find as hints.',
    { ...selection, query: question, url: z.string().trim().min(1).max(2048).optional(), find: z.string().trim().min(1).max(160).optional() },
    (args) => ({ query: args.query, ...(args.url ? { url: args.url } : {}), ...(args.find ? { find: args.find } : {}) }), true],
  ['inspect_image', 'image.inspect', 'Answer about one or two ordered PNG, JPEG, or WebP images, up to 5 MiB total.',
    { ...selection, image_base64: base64, second_image_base64: base64.optional(), question },
    (args) => ({ question: args.question, images: [wireImage(args.image_base64), ...(args.second_image_base64 === undefined ? [] : [wireImage(args.second_image_base64)])] }), true],
  ['inspect_document', 'document.inspect', 'Answer about a PDF, DOCX, XLSX, PPTX, or UTF-8 CSV. Optional detail controls PDF page image detail.',
    { ...fileInput, detail: z.enum(['auto', 'low', 'high']).optional() },
    (args) => ({ question: args.question, file: wireFile(args), ...(args.detail === undefined ? {} : { detail: args.detail }) })],
  ['inspect_video', 'video.inspect', 'Answer about visible content and sequence in a short MP4, up to 5 MiB.', fileInput,
    (args) => ({ question: args.question, file: wireFile(args, true) })],
  ['generate_image', 'image.generate', 'Generate one PNG with a configured image provider.', { ...selection, prompt }, (args) => ({ prompt: args.prompt }), true],
  ['edit_image', 'image.edit', 'Edit one PNG, JPEG, or WebP up to 5 MiB and return a PNG.', { ...selection, prompt, image_base64: base64 },
    (args) => ({ prompt: args.prompt, image: wireImage(args.image_base64) }), true],
  ['synthesize_speech', 'speech.synthesize', 'Read short text aloud with Gateway Realtime and return a 24 kHz mono PCM16 WAV.',
    { provider: providerInput, text: z.string().trim().min(1).max(600) }, (args) => ({ text: args.text }), false, false],
  ['transcribe_audio', 'speech.transcribe', 'Transcribe a short 24 kHz mono PCM16 WAV, supplied as canonical base64.',
    { provider: providerInput, audio_base64: audioInput }, (args) => ({ audio: wireAudio(args.audio_base64) })],
  ['ask_audio', 'audio.inspect', 'Answer a question about spoken content in a canonical Base64 24 kHz mono PCM16 WAV.',
    { provider: providerInput, audio_base64: audioInput, question }, (args) => ({ audio: wireAudio(args.audio_base64), question: args.question })],
];

function wireResult(result) {
  if (result.kind === 'image' || result.kind === 'audio') return { content: [
    { type: 'text', text: JSON.stringify({ ...(result.kind === 'audio' ? { transcript: result.transcript ?? '' } : {}), mimeType: result.mimeType, bytes: result.data.byteLength }) },
    { type: result.kind, mimeType: result.mimeType, data: Buffer.from(result.data).toString('base64') },
  ] };
  if (result.operation === 'speech.transcribe') return textResult({ transcript: result.text });
  if (result.operation === 'web.search') return textResult({ answer: result.text, sources: result.sources ?? [],
    ...(result.mode ? { provider: result.provider, mode: result.mode } : {}), ...(result.actions ? { actions: result.actions } : {}) });
  return textResult({ answer: result.text,
    ...(['document.inspect', 'video.inspect', 'audio.inspect'].includes(result.operation) ? { model: result.model } : {}) });
}

/** MCP is only a schema/encoding boundary; it can host any independently registered provider. */
export function registerCapabilityTools(server, { capabilities, registry, operations, includeList = operations === undefined }) {
  const providers = capabilities.list();
  const supported = new Set(providers.flatMap((provider) => provider.operations));
  if (includeList) server.registerTool('list_providers', {
    description: 'List configured provider IDs, models and enabled capabilities.', inputSchema: z.object({}), annotations: { readOnlyHint: true },
  }, async () => {
    const declared = new Map(registry?.list().map((provider) => [provider.id, provider]) ?? []);
    return textResult({ providers: capabilities.list().map((provider) => {
      const profile = declared.get(provider.id);
      return { id: provider.id, name: profile?.name ?? provider.id, ...(profile ? { protocol: profile.protocol } : {}),
        models: profile?.models ?? provider.models.map((id) => ({ id })), capabilities: [...new Set(provider.operations.map((operation) => operationCapabilities[operation]))] };
    }) });
  });
  for (const [name, operation, description, schema, mapInput, openWorldHint = false, readOnlyHint = true] of definitions) {
    if (!supported.has(operation) || (operations && !operations.includes(operation))) continue;
    server.registerTool(name, { description, inputSchema: z.object(schema), annotations: { readOnlyHint, openWorldHint } }, async (args, { signal }) => {
      const result = await capabilities.execute(operation, mapInput(args), {
        ...(args.provider === undefined ? {} : { provider: args.provider }), ...(args.model === undefined ? {} : { model: args.model }), signal,
      });
      return wireResult(result);
    });
  }
}

export function createTools({ capabilities, gateway, registry }) {
  const server = new McpServer({ name: 'oh-my-harness', version: '0.1.0' });
  registerCapabilityTools(server, { capabilities: capabilities ?? createProtocolRuntime({ registry, gateway }), registry,
    // The legacy composition adds registerRealtimeTools separately. Only an explicitly
    // supplied runtime owns unified audio registration and its actual executor.
    ...(capabilities ? {} : { operations: Object.keys(operationCapabilities).filter((operation) => operationCapabilities[operation] !== 'audio'), includeList: true }),
  });
  return server;
}
