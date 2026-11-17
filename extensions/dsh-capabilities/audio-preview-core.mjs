/** Browser-safe WAV preview logic, inlined by the deterministic client builder. */
export const previewMaxBytes = 8 * 1024 * 1024;
export const previewWindowBytes = 2 * 1024 * 1024;
const PREFIX = 'dsh-resource://file/';

function ascii(bytes, at, length) {
  let text = '';
  for (let i = 0; i < length; i++) text += String.fromCharCode(bytes[at + i]);
  return text;
}

/** Public file-address grammar; only session addresses authorize preview reads. */
export function parseFileAddress(address) {
  try {
    if (typeof address !== 'string' || !address.startsWith(PREFIX)) return undefined;
    const end = address.search(/[?#]/);
    const [scope, ...rest] = address.slice(PREFIX.length, end === -1 ? undefined : end).split('/');
    if (scope === 'session') {
      const [id, ...segments] = rest;
      if (id === undefined || id === '' || segments.length === 0) return undefined;
      return { scope, sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') };
    }
    if (scope === 'absolute') {
      const unc = rest[0] === '' && rest.length > 1;
      const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent);
      if (segments.length === 0 || segments[0] === '') return undefined;
      const path = segments.join('/');
      return { scope, path: unc ? `//${path}` : /^[A-Za-z]:$/.test(segments[0]) ? path : `/${path}` };
    }
    return undefined;
  } catch { return undefined; }
}

/** Validate a complete RIFF/WAVE container, not just a playable prefix.
 * Codec support is left to the browser; RF64/RIFX are not RIFF/WAVE previews. */
export function validateWavPrefix(bytes) {
  if (bytes.length < 44 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new Error('Expected a RIFF/WAVE audio file');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) throw new Error('Expected a complete WAV RIFF container');
  let at = 12, format = false, audio = false;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) throw new Error('Incomplete WAV chunk header');
    const kind = ascii(bytes, at, 4), length = view.getUint32(at + 4, true);
    const end = at + 8 + length;
    if (end + (length % 2) > bytes.length) throw new Error('Incomplete WAV chunk');
    if (kind === 'fmt ') {
      if (length < 16) throw new Error('Invalid WAV format chunk');
      format = true;
    }
    if (kind === 'data') audio = true;
    at = end + (length % 2);
  }
  if (!format || !audio) throw new Error('WAV requires format and data chunks');
}

function boundedInteger(value, ceiling, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new Error(`${name} limit must be a positive safe integer at most ${ceiling}`);
  }
}

function unwrap(result) {
  if (result?.ok !== true) throw result?.error ?? new Error('File read failed');
  if (!result.value || typeof result.value !== 'object') throw new Error('Invalid file read result');
  return result.value;
}

function checkMetadata(value, maxBytes) {
  if (typeof value.version !== 'string' || typeof value.absolutePath !== 'string') {
    throw new Error('File metadata requires a version and absolute path');
  }
  if (value.bytes !== undefined) {
    if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) throw new Error('Invalid file byte size');
    if (value.bytes > maxBytes) throw new Error('The audio file exceeds the preview size limit');
  }
}

/** Read one bounded complete version of a WAV via native Remote byte windows.
 * readBytes(sessionId, path, { range: { offset, length } }, signal) => RemoteResult
 * readStat(sessionId, path, signal) => RemoteResult; the final stat catches a
 * change during the last read, whose version was sampled by Host before I/O.
 * Freshness remains only as strong as the backend's opaque version token. */
export async function readWavPreview({ readBytes, readStat, resourceAddress, signal, maxBytes = previewMaxBytes, window = previewWindowBytes }) {
  const address = parseFileAddress(resourceAddress);
  if (!address || address.scope !== 'session' || address.path === '') throw new Error('Audio preview requires a session-scoped file address');
  boundedInteger(maxBytes, previewMaxBytes, 'Preview size');
  boundedInteger(window, previewWindowBytes, 'Read window');
  if (typeof readBytes !== 'function' || typeof readStat !== 'function') throw new Error('Audio preview requires byte and metadata readers');
  let offset = 0, metadata, buffer;
  for (;;) {
    signal?.throwIfAborted();
    const length = Math.min(window, maxBytes - offset);
    if (length === 0) throw new Error('The audio file exceeds the preview size limit');
    const result = await readBytes(address.sessionId, address.path, { range: { offset, length } }, signal);
    signal?.throwIfAborted();
    const value = unwrap(result);
    checkMetadata(value, maxBytes);
    if (metadata === undefined) {
      metadata = { version: value.version, absolutePath: value.absolutePath, bytes: value.bytes };
      // One bounded destination, even when a backend cannot report file size;
      // never an accumulating list of tiny remote-window allocations.
      buffer = new Uint8Array(value.bytes ?? maxBytes);
    } else if (value.version !== metadata.version || value.absolutePath !== metadata.absolutePath || value.bytes !== metadata.bytes) {
      throw new Error('The file changed while it was being read');
    }
    if (value.offset !== offset) throw new Error('The file read returned an unexpected offset');
    const data = value.data;
    if (!ArrayBuffer.isView(data) || Object.prototype.toString.call(data) !== '[object Uint8Array]') throw new Error('File read requires native Uint8Array bytes');
    if (data.byteLength > length) throw new Error('The file read exceeded its requested window');
    if (offset + data.byteLength > buffer.length) throw new Error('File bytes exceed the reported size');
    if (typeof value.eof !== 'boolean') throw new Error('Invalid file EOF marker');
    buffer.set(data, offset);
    offset += data.byteLength;
    if (value.eof) {
      if (metadata.bytes !== undefined && offset !== metadata.bytes) throw new Error('File EOF did not include the complete byte size');
      break;
    }
    if (data.byteLength === 0) throw new Error('The file read made no progress');
  }
  const data = buffer.subarray(0, offset);
  validateWavPrefix(data);
  signal?.throwIfAborted();
  const stat = unwrap(await readStat(address.sessionId, address.path, signal));
  signal?.throwIfAborted();
  checkMetadata(stat, maxBytes);
  if (stat.version !== metadata.version || stat.absolutePath !== metadata.absolutePath || (stat.bytes !== undefined && stat.bytes !== offset)) {
    throw new Error('The file changed while it was being read');
  }
  return { version: metadata.version, data };
}
