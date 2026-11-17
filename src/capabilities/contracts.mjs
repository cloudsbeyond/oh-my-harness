import { z } from 'zod';

export const limits = Object.freeze({ fileBytes: 5 * 1024 * 1024, imageBytes: 8 * 1024 * 1024, audioBytes: 2 * 1024 * 1024, timeoutMs: 190_000 });
export const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const operationCapabilities = Object.freeze({
  'web.search': 'search',
  'image.inspect': 'vision',
  'image.generate': 'images',
  'image.edit': 'images',
  'document.inspect': 'documents',
  'video.inspect': 'video',
  'speech.synthesize': 'audio',
  'speech.transcribe': 'audio',
  'audio.inspect': 'audio',
});

export class CapabilityError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = 'CapabilityError';
    this.code = code;
  }
}

export function imageMimeType(bytes) {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.subarray(0, 8).equals(pngSignature)) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('Expected PNG, JPEG, or WebP bytes');
}

const officeTypes = new Map([
  ['docx', ['word/document.xml', 'wordprocessingml.document']],
  ['xlsx', ['xl/workbook.xml', 'spreadsheetml.sheet']],
  ['pptx', ['ppt/presentation.xml', 'presentationml.presentation']],
]);

export function documentMimeType(name, bytes) {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const extension = name.toLowerCase().split('.').at(-1);
  if (extension === 'pdf' && data.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  if (officeTypes.has(extension)) {
    const [member, subtype] = officeTypes.get(extension);
    if (data.length >= 4 && data.readUInt32LE(0) === 0x04034b50 && data.includes('[Content_Types].xml') && data.includes(member)) {
      return 'application/vnd.openxmlformats-officedocument.' + subtype;
    }
  }
  if (extension === 'csv') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (text.trim() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return 'text/csv';
  }
  throw new Error('Expected PDF, DOCX, XLSX, PPTX, or UTF-8 CSV bytes matching the filename');
}

/** Validate a complete canonical 24 kHz mono PCM16 WAV; return its PCM bytes. */
export function wavPcm(bytes, minBytes = 4_800) {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = () => { throw new Error('Expected 24 kHz mono PCM16 WAV within the audio limit'); };
  if (data.length < 44 || data.length > limits.audioBytes + 44 || data.toString('ascii', 0, 4) !== 'RIFF' ||
      data.toString('ascii', 8, 12) !== 'WAVE' || data.readUInt32LE(4) !== data.length - 8) fail();
  let format;
  let pcm;
  let offset = 12;
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4);
    const length = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (length > data.length - start) fail();
    if (id === 'fmt ') {
      if (format || length < 16) fail();
      format = data.subarray(start, start + length);
    }
    if (id === 'data') {
      if (pcm) fail();
      pcm = data.subarray(start, start + length);
    }
    offset = start + length + length % 2;
  }
  if (offset !== data.length || !format || format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1 ||
      format.readUInt32LE(4) !== 24_000 || format.readUInt32LE(8) !== 48_000 || format.readUInt16LE(12) !== 2 ||
      format.readUInt16LE(14) !== 16 || !pcm || pcm.length < minBytes || pcm.length > limits.audioBytes || pcm.length % 2) fail();
  return pcm;
}

const bytes = (max) => z.custom((data) => data instanceof Uint8Array && data.byteLength > 0 && data.byteLength <= max);
const filename = z.string().min(1).refine((name) => Buffer.byteLength(name) <= 255 && !/[\\/\x00-\x1f\x7f]/.test(name));
const media = (max) => z.strictObject({ data: bytes(max), mimeType: z.string().min(1), name: filename.optional() });
const checked = (schema, check) => schema.refine((value) => { try { return check(value); } catch { return false; } });
const image = checked(media(limits.fileBytes), (value) => imageMimeType(value.data) === value.mimeType);
const document = checked(media(limits.fileBytes).extend({ name: filename }), (value) => documentMimeType(value.name, value.data) === value.mimeType);
const video = checked(media(limits.fileBytes).extend({ name: filename }), (value) => {
  const data = Buffer.from(value.data);
  return value.name.toLowerCase().endsWith('.mp4') && value.mimeType === 'video/mp4' && data.length >= 16 &&
    data.toString('ascii', 4, 8) === 'ftyp' && data.readUInt32BE(0) >= 16 && data.readUInt32BE(0) <= data.length;
});
const audio = checked(media(limits.audioBytes + 44), (value) => value.mimeType === 'audio/wav' && Boolean(wavPcm(value.data)));
const question = z.string().trim().min(1).max(1600);
export const prompt = z.string().trim().min(1).max(8000);
const publicURL = z.string().max(4096).refine((value) => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
});
const source = z.object({ url: publicURL, title: z.string().max(500).optional() });
const inputSchemas = {
  'web.search': z.strictObject({ query: question, url: z.string().trim().min(1).max(2048).optional(), find: z.string().trim().min(1).max(160).optional(), maxResults: z.number().int().min(1).max(50).optional() }),
  'image.inspect': z.strictObject({ question, images: z.array(image).min(1).max(2).refine((values) => values.reduce((sum, value) => sum + value.data.byteLength, 0) <= limits.fileBytes) }),
  'image.generate': z.strictObject({ prompt }),
  'image.edit': z.strictObject({ prompt, image }),
  'document.inspect': z.strictObject({ question, file: document, detail: z.enum(['auto', 'low', 'high']).optional() }),
  'video.inspect': z.strictObject({ question, file: video }),
  'speech.synthesize': z.strictObject({ text: z.string().trim().min(1).max(600) }),
  'speech.transcribe': z.strictObject({ audio }),
  'audio.inspect': z.strictObject({ question, audio }),
};
const textResult = z.object({
  kind: z.literal('text'), text: z.string().max(128_000), model: z.string().min(1).max(120).optional(),
  sources: z.array(source).max(50).optional(), mode: z.literal('search').optional(), truncated: z.boolean().optional(),
  actions: z.array(z.object({ type: z.enum(['open_page', 'find_in_page']), url: publicURL, pattern: z.string().optional() })).max(50).optional(),
});
const resultSchemas = {
  text: textResult,
  image: checked(z.object({ kind: z.literal('image'), data: bytes(limits.imageBytes), mimeType: z.literal('image/png'), model: z.string().min(1).max(120).optional() }), (value) => Buffer.from(value.data).subarray(0, 8).equals(pngSignature)),
  audio: checked(z.object({ kind: z.literal('audio'), data: bytes(limits.audioBytes + 44), mimeType: z.literal('audio/wav'), transcript: z.string().max(8000).optional(), model: z.string().min(1).max(120).optional() }), (value) => Boolean(wavPcm(value.data, 2))),
};

export function parseInput(operation, input) {
  if (!Object.hasOwn(inputSchemas, operation)) throw new CapabilityError('Unknown capability operation', 'OPERATION_UNKNOWN');
  const parsed = inputSchemas[operation].safeParse(input);
  if (!parsed.success) throw new CapabilityError('Invalid capability input or unsupported media format/size', 'INPUT_INVALID');
  return parsed.data;
}

export function parseResult(operation, result) {
  const kind = operation === 'image.generate' || operation === 'image.edit' ? 'image' : operation === 'speech.synthesize' ? 'audio' : 'text';
  const parsed = resultSchemas[kind].safeParse(result);
  if (!parsed.success || (kind === 'text' && !parsed.data.text.trim() && operation !== 'speech.transcribe' && !(operation === 'web.search' && parsed.data.sources?.length))) {
    throw new CapabilityError('Provider returned an invalid capability result', 'RESULT_INVALID');
  }
  return parsed.data;
}
