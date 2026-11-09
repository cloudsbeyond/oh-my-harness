import { createHash } from 'node:crypto';

/** No I/O, credentials, global state, or provider SDK dependencies live here. */
export class NativeSearchError extends Error {
  constructor(message, code = 'NATIVE_SEARCH_POLICY') {
    super(message);
    this.name = 'NativeSearchError';
    this.code = code;
  }
}

export const NATIVE_SEARCH_LIMITS = Object.freeze({
  maxSources: 12,
  maxMetadataBytes: 64 * 1024,
  hardMaxSources: 32,
  hardMaxMetadataBytes: 1024 * 1024,
  maxItems: 64,
  maxAnnotations: 128,
  maxUrlLength: 2048,
});

const ownObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');
const digest = (v) => createHash('sha256').update(canonical(v)).digest('hex');
const validId = (v) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
const normalizePart = (v) => v.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64).replace(/_+$/, '');
const plainText = (v, size = 256) => typeof v === 'string'
  ? v.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, size)
  : '';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v ?? null)).join(',')}]`;
  if (ownObject(value)) return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

function jsonArguments(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function canonicalContent(content) {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (block.type === 'text' || block.type === 'reasoning') return { type: block.type, text: block.text };
    if (block.type === 'tool-call') return {
      type: block.type, id: block.id, name: block.name, arguments: jsonArguments(block.arguments),
    };
    return block;
  });
}

function historyFingerprint(messages) {
  return digest(messages.map((m) => ({
    role: m.role,
    content: canonicalContent(m.content),
    ...(m.role === 'assistant' && m.source ? { source: { provider: m.source.provider, model: m.source.model } } : {}),
  })));
}

function safeUrl(value) {
  if (typeof value !== 'string' || value.length > NATIVE_SEARCH_LIMITS.maxUrlLength ||
      /[\u0000-\u0020\u007f\\]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) return undefined;
    // Angle-delimited Markdown links must not allow closing the destination or HTML.
    return url.href.replace(/[<>`]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch { return undefined; }
}

function textId(signature) {
  if (typeof signature !== 'string') return undefined;
  try {
    const parsed = JSON.parse(signature);
    if (parsed.v === 1 && typeof parsed.id === 'string') return parsed.id;
  } catch { /* pi also accepts the legacy, plain-id signature. */ }
  return signature;
}

/** Compare only fields that pi actually projects into the next wire request. */
function anchorValue(item) {
  if (!ownObject(item) || !validId(item.id)) return undefined;
  if (item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)) {
    if (item.content.some((part) => !['output_text', 'refusal'].includes(part.type))) return undefined;
    return {
      type: 'message', id: item.id, role: 'assistant',
      text: item.content.map((p) => p.type === 'output_text' ? p.text : p.refusal).join(''),
      ...item.phase === undefined ? {} : { phase: item.phase },
    };
  }
  if (item.type === 'function_call') return {
    type: item.type, id: item.id, call_id: item.call_id, name: item.name,
    arguments: jsonArguments(item.arguments),
    ...item.namespace === undefined ? {} : { namespace: item.namespace },
  };
  if (item.type === 'reasoning') return item;
  return undefined;
}

function boundedInteger(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new NativeSearchError(`${name} must be an integer between ${min} and ${max}`, 'NATIVE_SEARCH_INVALID_POLICY');
  }
  return value;
}

/**
 * Per-call native Responses search hooks. The caller decides which plugin routes
 * receive this factory; an absent/false policy never authorizes search. Any
 * auxiliary purpose is off by default. Hooks remain installed while disabled so
 * a proxy cannot silently inject native tools. onPayload returns a detached copy.
 *
 * Replay uses the existing pi-ai/version=2 envelope. nativeSearch/version=1 is
 * optional adapter-private metadata, never an alternate response kind. Its
 * hashes cover authoritative Harness content AND the preceding conversation.
 * Bounded/lossy captures deliberately fall back to the ordinary visible text.
 */
export function prepareNativeSearch(options = {}, policy = {}, images) {
  const enabled = policy.enabled === true && (options.purpose == null || policy.allowAuxiliary === true);
  const maxSources = boundedInteger(policy.maxSources, NATIVE_SEARCH_LIMITS.maxSources,
    1, NATIVE_SEARCH_LIMITS.hardMaxSources, 'maxSources');
  const maxMetadataBytes = boundedInteger(policy.maxMetadataBytes, NATIVE_SEARCH_LIMITS.maxMetadataBytes,
    1024, NATIVE_SEARCH_LIMITS.hardMaxMetadataBytes, 'maxMetadataBytes');
  // Snapshot only replay-relevant inputs; do not retain options (signal, secrets,
  // services, etc.) inside durable metadata or native provider event captures.
  const messages = structuredClone(options.messages ?? []);
  const route = { provider: options.provider, model: options.model };
  const contextFingerprint = historyFingerprint(messages);
  const sources = new Map();
  const items = new Map();
  const annotationEvents = new Map();
  let allowedFunctions = new Set();
  let payloadSeen = false;
  let searchSeen = false;
  let lossy = false;
  let fatal;
  let outputCount = 0;
  let sourceOverflow = 0;
  let invalidSources = 0;

  function fail(message, code) {
    fatal ??= new NativeSearchError(message, code);
    throw fatal;
  }
  function authorizeSearch() {
    if (!enabled) fail('Native web search was returned for a call that does not authorize search', 'NATIVE_SEARCH_DISABLED');
    searchSeen = true;
  }
  function source(url, title) {
    const safe = safeUrl(url);
    if (!safe) { lossy = true; invalidSources += 1; return undefined; }
    const existing = sources.get(safe);
    if (existing) {
      if (title && !existing.title) existing.title = plainText(title);
      return safe;
    }
    if (sources.size >= maxSources) { lossy = true; sourceOverflow += 1; return undefined; }
    sources.set(safe, { url: safe, ...(plainText(title) ? { title: plainText(title) } : {}) });
    return safe;
  }
  function annotation(value) {
    if (value?.type !== 'url_citation') { lossy = true; return undefined; }
    authorizeSearch();
    const url = source(value.url, value.title);
    if (!url || !Number.isInteger(value.start_index) || !Number.isInteger(value.end_index) ||
        value.start_index < 0 || value.end_index < value.start_index) { lossy = true; return undefined; }
    if (typeof value.title !== 'string' || value.title.length > 256) lossy = true;
    return { type: 'url_citation', start_index: value.start_index, end_index: value.end_index,
      title: plainText(value.title), url };
  }
  function searchItem(value) {
    authorizeSearch();
    if (!validId(value.id) || !ownObject(value.action) ||
        !['in_progress', 'searching', 'completed', 'failed', 'incomplete'].includes(value.status)) {
      lossy = true; return undefined;
    }
    const action = value.action;
    let clean;
    if (action.type === 'search') {
      clean = { type: 'search' };
      if (action.query !== undefined) {
        if (typeof action.query !== 'string' || action.query.length > 1024) lossy = true;
        clean.query = plainText(action.query, 1024);
      }
      if (action.queries !== undefined) {
        if (!Array.isArray(action.queries) || action.queries.length > 8) lossy = true;
        clean.queries = (Array.isArray(action.queries) ? action.queries : []).slice(0, 8).map((q) => {
          if (typeof q !== 'string' || q.length > 1024) lossy = true;
          return plainText(q, 1024);
        });
      }
      if (action.sources !== undefined) {
        if (!Array.isArray(action.sources)) lossy = true;
        clean.sources = [];
        for (const s of (Array.isArray(action.sources) ? action.sources : []).slice(0, maxSources + 1)) {
          const url = s?.type === 'url' ? source(s.url, s.title) : undefined;
          if (url) clean.sources.push({ type: 'url', url }); else lossy = true;
        }
        if (action.sources?.length > maxSources) lossy = true;
      }
    } else if (action.type === 'open_page' || action.type === 'find_in_page') {
      clean = { type: action.type };
      if (action.url != null) {
        const url = source(action.url);
        if (!url) return undefined;
        clean.url = url;
      } else if (action.type === 'find_in_page') { lossy = true; return undefined; }
      if (action.type === 'find_in_page') {
        if (typeof action.pattern !== 'string' || action.pattern.length > 1024) lossy = true;
        clean.pattern = plainText(action.pattern, 1024);
      }
    } else { lossy = true; return undefined; }
    return { id: value.id, type: 'web_search_call', status: value.status, action: clean };
  }
  function checkItem(item) {
    if (!ownObject(item)) return;
    if (item.type === 'image_generation_call') {
      if (!images?.tool) fail('Native image generation is not authorized for this request', 'NATIVE_IMAGE_UNSUPPORTED');
      return;
    }
    if (item.type === 'web_search_call') { authorizeSearch(); return; }
    if (!['message', 'reasoning', 'function_call'].includes(item.type)) {
      fail('Provider returned a native tool that was not authorized by this call', 'UNAPPROVED_NATIVE_TOOL');
    }
    if (item.type === 'function_call' && payloadSeen && item.name && !allowedFunctions.has(item.name)) {
      fail('Provider returned a function tool that was not declared by this call', 'UNAPPROVED_NATIVE_TOOL');
    }
  }
  function capture(item, index) {
    checkItem(item);
    if (!ownObject(item)) return;
    if (item.type === 'image_generation_call') { images.capture(item); lossy = true; return; }
    if (!Number.isInteger(index) || index < 0 || index >= NATIVE_SEARCH_LIMITS.maxItems) { lossy = true; return; }
    outputCount = Math.max(outputCount, index + 1);
    if (item.type === 'web_search_call') {
      const clean = searchItem(item);
      if (clean) items.set(index, { type: 'search', item: clean });
    } else {
      const anchor = anchorValue(item);
      if (!anchor) { lossy = true; return; }
      const record = { type: 'anchor', id: item.id, itemType: item.type, fingerprint: digest(anchor), annotations: [] };
      if (item.type === 'message') {
        // pi flattens the provider message's parts into one output_text on replay.
        let offset = 0;
        for (const part of item.content) {
          for (const value of (part.annotations ?? []).slice(0, NATIVE_SEARCH_LIMITS.maxAnnotations + 1)) {
            const clean = annotation(value);
            if (clean && record.annotations.length < NATIVE_SEARCH_LIMITS.maxAnnotations) {
              if (clean.end_index > (part.text?.length ?? 0)) lossy = true;
              record.annotations.push({ contentIndex: 0, annotation: {
                ...clean, start_index: clean.start_index + offset, end_index: clean.end_index + offset,
              } });
            } else lossy = true;
          }
          if ((part.annotations?.length ?? 0) > NATIVE_SEARCH_LIMITS.maxAnnotations) lossy = true;
          offset += (part.text ?? part.refusal ?? '').length;
        }
      }
      items.set(index, record);
    }
  }

  function replay(payload, model) {
    if (!enabled || !Array.isArray(payload.input)) return;
    const input = payload.input;
    for (const [messageIndex, message] of messages.entries()) {
      try {
      const state = message.source?.replayState;
      const native = state?.response?.nativeSearch;
      if (message.role !== 'assistant' || !ownObject(native) || native.version !== 1 || native.replayable !== true ||
          state.response.kind !== 'pi-ai' || state.response.version !== 2 ||
          !Array.isArray(state.blocks) || state.blocks.length !== message.content?.length ||
          state.blocks.some((b, i) => b.type !== message.content[i].type) ||
          message.source.provider !== route.provider || message.source.model !== route.model ||
          native.route?.provider !== route.provider || native.route?.model !== route.model ||
          state.response.provider !== model.provider || state.response.model !== model.id || state.response.api !== model.api ||
          native.contentFingerprint !== digest(canonicalContent(message.content)) ||
          native.contextFingerprint !== historyFingerprint(messages.slice(0, messageIndex)) ||
          !Array.isArray(native.sequence) || native.sequence.length > NATIVE_SEARCH_LIMITS.maxItems ||
          bytes(native) > maxMetadataBytes) continue;
        const anchors = native.sequence.filter((entry) => entry.type === 'anchor');
        if (!anchors.length || anchors.length > state.blocks.length) continue;
        const positions = [];
        let valid = true;
        for (const a of anchors) {
          const found = input.flatMap((entry, i) => entry?.id === a.id ? [i] : []);
          if (!validId(a.id) || found.length !== 1 || input[found[0]].type !== a.itemType ||
              !anchorValue(input[found[0]]) || digest(anchorValue(input[found[0]])) !== a.fingerprint ||
              !Array.isArray(a.annotations) || a.annotations.length > NATIVE_SEARCH_LIMITS.maxAnnotations) { valid = false; break; }
          positions.push(found[0]);
        }
        // No anchor gaps, duplicates, or intervening changed/pruned history.
        if (!valid || positions.some((p, i) => i > 0 && p !== positions[i - 1] + 1)) continue;
        const trace = input[positions.at(-1) + 1];
        if (trace?.type !== 'message' || trace.role !== 'assistant' || !Array.isArray(trace.content) ||
            trace.content.some((p) => p.type !== 'output_text') ||
            digest(trace.content.map((p) => p.text).join('')) !== native.traceFingerprint) continue;
        const replacement = [];
        let anchorIndex = 0;
        const replayIds = new Set(input.map((entry) => entry?.id).filter(Boolean));
        for (const entry of native.sequence) {
          if (entry.type === 'search') {
            // Validate persisted metadata again: never trust arbitrary session JSON.
            const clean = validateStoredSearch(entry.item, maxSources);
            if (!clean || replayIds.has(clean.id)) { valid = false; break; }
            replayIds.add(clean.id);
            replacement.push(clean);
          } else if (entry.type === 'anchor') {
            const item = structuredClone(input[positions[anchorIndex++]]);
            for (const a of entry.annotations) {
              const part = item.content?.[a.contentIndex];
              const clean = validateStoredAnnotation(a.annotation);
              if (!part || part.type !== 'output_text' || !clean || clean.end_index > part.text.length) { valid = false; break; }
              part.annotations = [...(part.annotations ?? []), clean];
            }
            replacement.push(item);
          } else { valid = false; break; }
        }
        if (valid && anchorIndex === anchors.length) input.splice(positions[0], anchors.length, ...replacement);
      } catch { /* Invalid/obsolete metadata always degrades to its existing text. */ }
    }
  }

  function onPayload(payload, model) {
    if (fatal) throw fatal;
    if (!ownObject(payload) || !ownObject(model)) fail('Native search requires a Responses payload and model', 'NATIVE_SEARCH_INVALID_PAYLOAD');
    const result = structuredClone(payload);
    if (result.tools !== undefined && !Array.isArray(result.tools)) {
      fail('Responses tool declarations must be an array', 'NATIVE_SEARCH_UNSUPPORTED_TOOL');
    }
    for (const tool of result.tools ?? []) {
      if (!['function', 'web_search', 'web_search_preview', 'image_generation'].includes(tool?.type) ||
          (tool.type === 'function' && (typeof tool.name !== 'string' || !tool.name.length))) {
        fail('This adapter supports only declared function tools and native web search', 'NATIVE_SEARCH_UNSUPPORTED_TOOL');
      }
    }
    const functions = (result.tools ?? []).filter((t) => t.type === 'function');
    allowedFunctions = new Set(functions.map((t) => t.name));
    payloadSeen = true;
    result.tools = [...functions, ...(enabled ? [{ type: 'web_search' }] : []), ...(images?.tool ? [images.tool] : [])];
    // Installed openai SDK ToolChoiceAllowed has flat {type, mode, tools}.
    // An explicit allowlist also constrains reverse proxies that auto-inject tools.
    const allowed = [...allowedFunctions].map((name) => ({ type: 'function', name }));
    if (enabled) allowed.push({ type: 'web_search' });
    if (images?.tool) allowed.push({ type: 'image_generation' });
    result.tool_choice = allowed.length ? { type: 'allowed_tools', mode: 'auto', tools: allowed } : 'none';
    if (Array.isArray(result.include)) result.include = result.include.filter((v) =>
      typeof v === 'string' && !v.startsWith('web_search_call.') && !v.startsWith('image_generation_call.'));
    if (enabled) result.include = [...new Set([...(result.include ?? []), 'web_search_call.action.sources'])];
    if (Array.isArray(result.input)) result.input = result.input.filter((entry) =>
      !['web_search_call', 'image_generation_call'].includes(entry?.type));
    replay(result, model);
    return images ? images.project(result) : result;
  }

  function onProviderStreamEvent(event, model) {
    if (fatal) throw fatal;
    try {
    if (!ownObject(event)) return;
    if (typeof event.type === 'string' && event.type.startsWith('response.image_generation_call.')) {
      if (!images?.tool) fail('Native image generation is not authorized for this request', 'NATIVE_IMAGE_UNSUPPORTED');
      return;
    }
    if (/^response\.(?:file_search_call|computer_call|code_interpreter_call|mcp_call|local_shell_call)\./.test(event.type ?? '')) {
      fail('Provider returned a native tool that was not authorized by this call', 'UNAPPROVED_NATIVE_TOOL');
    }
    if (event.type?.startsWith('response.web_search_call.')) authorizeSearch();
    if (event.item) {
      checkItem(event.item);
      if (event.type === 'response.output_item.done') capture(event.item, event.output_index);
    }
    if (event.type === 'response.output_text.annotation.added') {
      const clean = annotation(event.annotation);
      if (clean) {
        if (annotationEvents.size >= NATIVE_SEARCH_LIMITS.maxAnnotations) lossy = true;
        else annotationEvents.set(`${event.item_id}:${event.content_index}:${event.annotation_index}`, {
          id: event.item_id, contentIndex: event.content_index, annotation: clean,
        });
      }
    }
    if (Array.isArray(event.response?.output)) {
      // Terminal responses can be the only place a proxy reports native items.
      for (const [index, item] of event.response.output.entries()) capture(item, index);
    }
    } catch (error) {
      if (error instanceof NativeSearchError) throw error;
      fail('Provider returned malformed native search metadata', 'NATIVE_SEARCH_INVALID_EVENT');
    }
  }

  function metadata(blocks, state) {
    const sequence = [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => structuredClone(item));
    const completeAnnotationIds = new Set(sequence.filter((entry) => entry.type === 'anchor' && entry.annotations.length)
      .map((entry) => entry.id));
    for (const value of annotationEvents.values()) {
      const anchor = sequence.find((entry) => entry.type === 'anchor' && entry.id === value.id);
      if (!anchor) { lossy = true; continue; }
      // Completed output items are authoritative and have already been flattened.
      if (completeAnnotationIds.has(value.id)) continue;
      if (value.contentIndex !== 0) { lossy = true; continue; }
      if (!anchor.annotations.some((a) => a.contentIndex === value.contentIndex && canonical(a.annotation) === canonical(value.annotation))) {
        if (anchor.annotations.length >= NATIVE_SEARCH_LIMITS.maxAnnotations) lossy = true;
        else anchor.annotations.push({ contentIndex: value.contentIndex, annotation: value.annotation });
      }
    }
    const originalBlocks = blocks.slice(0, state.blocks.length);
    const ids = originalBlocks.map((block, index) => {
      const replayBlock = state.blocks[index];
      if (block.type === 'text') return textId(replayBlock.textSignature);
      if (block.type === 'reasoning') {
        try { return JSON.parse(replayBlock.thinkingSignature).id; } catch { return undefined; }
      }
      if (block.type === 'tool-call') {
        const raw = block.id.split('|')[1];
        return raw?.startsWith('fc_') ? normalizePart(raw) : undefined;
      }
      return undefined;
    });
    const anchors = sequence.filter((entry) => entry.type === 'anchor');
    const aligned = ids.length === anchors.length && ids.every((id, i) => id === anchors[i].id);
    const value = {
      version: 1, route: { provider: route.provider ?? state.response.provider, model: route.model ?? state.response.model },
      contentFingerprint: digest(canonicalContent(blocks)), contextFingerprint,
      traceFingerprint: digest(blocks.at(-1)?.text ?? ''),
      replayable: !lossy && aligned && outputCount === sequence.length && sequence.length > 0,
      sources: [...sources.values()], sequence,
      capture: { lossy, aligned, outputCount, sequenceLength: sequence.length,
        anchorCount: anchors.length, normalizedBlockCount: originalBlocks.length,
        sourceCount: sources.size, sourceOverflow, invalidSources },
    };
    if (!value.replayable || bytes(value) > maxMetadataBytes) {
      value.replayable = false;
      delete value.sequence;
    }
    while (bytes(value) > maxMetadataBytes && value.sources.length) value.sources.pop();
    return value;
  }

  async function* wrapStream(stream) {
    const blocks = [];
    const usage = [];
    let maximumIndex = -1;
    try {
      for await (const chunk of stream) {
        if (fatal) throw fatal;
        if (Number.isInteger(chunk.index)) maximumIndex = Math.max(maximumIndex, chunk.index);
        if (chunk.type === 'block-end') blocks[chunk.index] = structuredClone(chunk.block);
        if (chunk.type === 'usage') { usage.push(chunk); continue; }
        if (chunk.type !== 'finish') { yield chunk; continue; }
        if (fatal) throw fatal;
        const state = chunk.replayState;
        if (searchSeen && !['error', 'aborted'].includes(chunk.reason?.kind) &&
            state?.response?.kind === 'pi-ai' && state.response.version === 2 && Array.isArray(state.blocks) && state.blocks.length > 0) {
          const index = maximumIndex + 1;
          const trace = sourceTrace([...sources.values()]);
          const nextState = structuredClone(state);
          yield { type: 'block-start', index, blockType: 'text' };
          yield { type: 'text-delta', index, text: trace };
          yield { type: 'block-end', index, block: { type: 'text', text: trace } };
          const complete = blocks.length === state.blocks.length && blocks.every((block, i) => block && block.type === state.blocks[i].type);
          if (!complete) lossy = true;
          blocks[index] = { type: 'text', text: trace };
          nextState.blocks.push({ type: 'text' });
          nextState.response.nativeSearch = metadata(blocks, state);
          for (const item of usage) yield item;
          yield { ...chunk, replayState: nextState };
        } else {
          for (const item of usage) yield item;
          yield chunk;
        }
        return;
      }
      if (fatal) throw fatal;
      for (const item of usage) yield item;
    } catch (error) {
      throw fatal ?? error;
    }
  }
  return { onPayload, onProviderStreamEvent, wrapStream };
}

function sourceTrace(sources) {
  if (!sources.length) return '\n\nNative web search was used; no usable HTTP(S) sources were returned.';
  const escape = (s) => s.replace(/[\\`*_{}\[\]()<>!#|]/g, '\\$&');
  return '\n\nSources (native web search):\n' + sources.map((s, i) =>
    `${i + 1}. [${escape(s.title || new URL(s.url).hostname)}](<${s.url}>)`).join('\n');
}

function validateStoredAnnotation(value) {
  if (!ownObject(value) || value.type !== 'url_citation' || !Number.isInteger(value.start_index) ||
      !Number.isInteger(value.end_index) || value.start_index < 0 || value.end_index < value.start_index ||
      typeof value.title !== 'string' || value.title !== plainText(value.title) || safeUrl(value.url) !== value.url) return undefined;
  return { type: value.type, start_index: value.start_index, end_index: value.end_index, title: value.title, url: value.url };
}

function validateStoredSearch(value, maxSources) {
  if (!ownObject(value) || !validId(value.id) || value.type !== 'web_search_call' || !ownObject(value.action) ||
      !['in_progress', 'searching', 'completed', 'failed', 'incomplete'].includes(value.status)) return undefined;
  const action = value.action;
  const clean = { type: action.type };
  if (action.type === 'search') {
    if (action.query !== undefined) {
      if (typeof action.query !== 'string' || action.query !== plainText(action.query, 1024)) return undefined;
      clean.query = action.query;
    }
    if (action.queries !== undefined) {
      if (!Array.isArray(action.queries) || action.queries.length > 8 || action.queries.some((q) => typeof q !== 'string' || q !== plainText(q, 1024))) return undefined;
      clean.queries = [...action.queries];
    }
    if (action.sources !== undefined) {
      if (!Array.isArray(action.sources) || action.sources.length > maxSources ||
          action.sources.some((s) => s?.type !== 'url' || safeUrl(s.url) !== s.url)) return undefined;
      clean.sources = action.sources.map((s) => ({ type: 'url', url: s.url }));
    }
  } else if (['open_page', 'find_in_page'].includes(action.type)) {
    if (action.url !== undefined) {
      if (safeUrl(action.url) !== action.url) return undefined;
      clean.url = action.url;
    } else if (action.type === 'find_in_page') return undefined;
    if (action.type === 'find_in_page') {
      if (typeof action.pattern !== 'string' || action.pattern !== plainText(action.pattern, 1024)) return undefined;
      clean.pattern = action.pattern;
    }
  } else return undefined;
  return { id: value.id, type: value.type, status: value.status, action: clean };
}
