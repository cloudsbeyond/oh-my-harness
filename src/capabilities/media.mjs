import { isIP } from 'node:net';
import { CapabilityError, imageMimeType, limits, pngSignature } from './contracts.mjs';
export { prompt } from './contracts.mjs';
export const maxFileInputBytes = limits.fileBytes;

export function decodeFileBase64(encoded) {
  const data = Buffer.from(encoded, 'base64');
  if (!data.length || data.length > maxFileInputBytes || data.toString('base64') !== encoded) throw new Error('Provide canonical base64 for a nonempty file up to 5 MiB');
  return data;
}

export function imageURL(bytes) {
  return `data:${imageMimeType(bytes)};base64,${Buffer.from(bytes).toString('base64')}`;
}

/** Inject this transport into a protocol runtime; it has no MCP or DSH dependencies. */
export async function requestUpstream(base, key, route, payload, timeoutMs, signal) {
  if (!key) throw new CapabilityError('The upstream credential is missing', 'MISSING_CREDENTIAL');
  const response = await fetch(new URL(route, base), {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
      ...(route === 'messages' || route === 'messages/count_tokens' ? { 'anthropic-version': '2023-06-01' } : {}) },
    body: JSON.stringify(payload), redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new CapabilityError(`Upstream request returned HTTP ${response.status}`, 'UPSTREAM_HTTP');
  }
  return response.json();
}

export function responseText(response) {
  const parts = (response.output ?? []).filter((item) => item.type === 'message').flatMap((item) => item.content ?? []).filter((part) => part.type === 'output_text');
  const text = parts.map((part) => part.text).join('\n').trim();
  if (response.status !== 'completed' || !text) throw new Error('The gateway did not return a completed answer');
  return { text, parts };
}

export function messagesText(response) {
  const text = (response.content ?? []).filter((item) => item.type === 'text').map((part) => part.text).join('\n').trim();
  if (!text) throw new Error('The gateway did not return a text answer');
  return text;
}

export function chatText(response) {
  const choice = response.choices?.[0];
  const text = choice?.message?.content;
  if (choice?.finish_reason !== 'stop' || typeof text !== 'string' || !text.trim()) throw new Error('The gateway did not return a completed answer');
  return text.trim();
}

export function decodeGeneratedImage(result) {
  const encoded = result.data?.[0]?.b64_json;
  if (typeof encoded !== 'string') throw new Error('The gateway did not return an image');
  const data = Buffer.from(encoded, 'base64');
  if (!data.subarray(0, 8).equals(pngSignature) || data.length > limits.imageBytes || data.toString('base64') !== encoded) throw new Error('The gateway returned an invalid or oversized PNG');
  return data;
}

export function publicPageURL(value) {
  const url = typeof value === 'string' && URL.canParse(value) ? new URL(value) : undefined;
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
      isIP(url.hostname) || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(url.hostname) ||
      /\.(?:local|localhost|localdomain|internal|test|invalid|example|onion|arpa)$/i.test(url.hostname)) return;
  url.hash = '';
  return url;
}

export function searchSources(entries, page) {
  const sources = new Map();
  for (const { url, title } of entries) {
    if (typeof url !== 'string' || url.length > 4096) continue;
    const parsed = URL.canParse(url) ? new URL(url) : undefined;
    if (!parsed || !['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) continue;
    if (page && publicPageURL(url)?.href !== page.href) continue;
    if (!sources.has(url)) sources.set(url, { url, ...(typeof title === 'string' ? { title: title.slice(0, 500) } : {}) });
    if (sources.size === 15) break;
  }
  return [...sources.values()];
}

export function reasoningFields(provider) {
  if (!provider.reasoningEffort) return {};
  return provider.protocol === 'responses' ? { reasoning: { effort: provider.reasoningEffort } }
    : provider.protocol === 'chat' ? { reasoning_effort: provider.reasoningEffort } : {};
}

export function visionContent(protocol, question, images) {
  if (protocol === 'messages') return [{ type: 'text', text: question }, ...images.map(({ data, mimeType }) => ({
    type: 'image', source: { type: 'base64', media_type: mimeType, data: Buffer.from(data).toString('base64') },
  }))];
  return protocol === 'responses'
    ? [{ type: 'input_text', text: question }, ...images.map(({ data }) => ({ type: 'input_image', image_url: imageURL(data) }))]
    : [{ type: 'text', text: question }, ...images.map(({ data }) => ({ type: 'image_url', image_url: { url: imageURL(data) } }))];
}
