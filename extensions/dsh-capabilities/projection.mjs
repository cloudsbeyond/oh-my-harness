import { createHash } from 'node:crypto';
import { CapabilityError, operationCapabilities, parseResult } from '../../src/capabilities/contracts.mjs';

const fail = () => { throw new CapabilityError('The native artifact cannot be persisted or mapped for this execution world', 'ARTIFACT_UNAVAILABLE'); };
const digest = (data) => createHash('sha256').update(data).digest('hex');
const positive = (value) => Number.isSafeInteger(value) && value > 0;
function imageRef(value) {
  if (!value || !/^sha256:[0-9a-f]{64}$/.test(value.attachmentId) || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value.mediaType) || !positive(value.bytes) || !positive(value.width) || !positive(value.height)) fail();
  return { attachmentId: value.attachmentId, mediaType: value.mediaType, bytes: value.bytes, width: value.width, height: value.height,
    ...(typeof value.name === 'string' ? { name: value.name } : {}) };
}
function fileRef(value, id, bytes) {
  if (!value || value.attachmentId !== 'sha256:' + id || value.bytes !== bytes || typeof value.name !== 'string' || !value.name || /[\\/\x00-\x1f\x7f]/.test(value.name)) fail();
  return { attachmentId: value.attachmentId, name: value.name, bytes: value.bytes };
}
async function mappedPath(ctx, path, signal) {
  const mapped = path && ctx.fs.processPathFromHostPath(path);
  if (!mapped) fail();
  const target = await ctx.fs.resolve(mapped, { signal });
  if ((await ctx.fs.stat(target, signal))?.type !== 'file') fail();
  signal?.throwIfAborted();
  return ctx.fs.processPath(target);
}

/** Persist bytes at the Host boundary; canonical tool values contain only JSON/refs. */
export async function projectResult(ctx, raw, exec, access) {
  const { signal } = exec;
  signal?.throwIfAborted();
  if (!raw || !/^[a-z][a-z0-9-]{0,39}$/.test(raw.provider) || !Object.hasOwn(operationCapabilities, raw.operation)) throw new CapabilityError('Invalid native capability result identity', 'RESULT_INVALID');
  const result = parseResult(raw.operation, raw);
  const identity = { provider: raw.provider, operation: raw.operation, ...(result.model ? { model: result.model } : {}) };
  if (result.kind === 'text') return { kind: 'text', text: result.text, ...identity, ...(result.sources ? { sources: result.sources } : {}) };
  const data = Buffer.from(result.data); // Detach from the provider's mutable output buffer.
  const id = digest(data);
  const name = (result.kind === 'image' ? 'image-' : 'speech-') + id.slice(0, 12) + (result.kind === 'image' ? '.png' : '.wav');
  let image;
  if (result.kind === 'image') {
    image = imageRef(await ctx.attachments.saveImage({ data: Buffer.from(data), mediaType: 'image/png', name }));
    signal?.throwIfAborted();
  }
  // saveFile has no signal. Await it, then observe cancellation before publishing.
  const file = fileRef(await ctx.attachments.saveFile({ data, name }), id, data.length);
  signal?.throwIfAborted();
  const path = await mappedPath(ctx, ctx.attachments.fileHostPath(file), signal);
  let previewPath;
  if (image && typeof ctx.attachments.imageHostPath === 'function') {
    const hostPath = ctx.attachments.imageHostPath(image);
    if (hostPath && ctx.fs.processPathFromHostPath(hostPath)) previewPath = await mappedPath(ctx, hostPath, signal);
  }
  signal?.throwIfAborted();
  const value = { kind: result.kind, ...identity, mimeType: result.mimeType, file, path,
    ...(image ? { image } : {}), ...(previewPath ? { previewPath } : {}), ...(result.transcript !== undefined ? { transcript: result.transcript } : {}) };
  access?.remember(exec.agent?.session, [{ type: 'file', attachment: file }, ...(image ? [{ type: 'image', attachment: image }] : [])]);
  return value;
}

const linkPath = (path) => encodeURI(path).replace(/[<>()#?]/g, (character) => '%' + character.charCodeAt(0).toString(16));
export function renderResult(value) {
  if (value.kind === 'text') return [{ type: 'text', text: value.text }];
  const label = value.kind === 'image' ? 'Original PNG' : 'Audio WAV';
  const text = `[${label}](<${linkPath(value.path)}>)\nProvider: ${value.provider}${value.model ? ' / ' + value.model : ''}. Use present to create a delivery card; saving alone does not present the file.` +
    (value.previewPath ? `\nNormalized image: ${value.previewPath}` : '') + (value.transcript ? `\nTranscript: ${value.transcript}` : '');
  return [{ type: 'text', text }, ...(value.image ? [{ type: 'image', attachment: value.image }] : []), { type: 'file', attachment: value.file }];
}
