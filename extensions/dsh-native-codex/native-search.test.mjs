import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareNativeSearch, NativeSearchError, NATIVE_SEARCH_LIMITS } from './native-search.mjs';

const model = { api: 'openai-responses', provider: 'native-route', id: 'test-model' };
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const initial = [user('Find the source.')];
const options = (messages = initial, extra = {}) => ({ provider: model.provider, model: model.id, messages, ...extra });
const policy = { enabled: true };
const fn = { type: 'function', name: 'read_local', description: 'Read a file', parameters: { type: 'object' } };
const citation = { type: 'url_citation', start_index: 0, end_index: 6, title: 'Example docs', url: 'https://example.com/docs' };
const search = { type: 'web_search_call', id: 'ws_one', status: 'completed', action: {
  type: 'search', queries: ['current docs'], sources: [{ type: 'url', url: citation.url }],
} };
const answer = { type: 'message', id: 'msg_one', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'Answer found.', annotations: [citation] }] };
const functionCall = { type: 'function_call', id: 'fc_one', call_id: 'call_one', name: fn.name, arguments: '{"path":"test"}', status: 'completed' };
const reasoning = { type: 'reasoning', id: 'rs_one', summary: [{ type: 'summary_text', text: 'Thinking.' }], encrypted_content: 'opaque-signature' };
async function* values(items) { yield* items; }
async function collect(stream) { const result = []; for await (const value of stream) result.push(value); return result; }
function payload(input = []) { return { model: model.id, input, tools: [fn], include: ['reasoning.encrypted_content'] }; }
function piBlock(item) {
  if (item.type === 'message') return { type: 'text', text: item.content.map((p) => p.text ?? p.refusal).join('') };
  if (item.type === 'reasoning') return { type: 'reasoning', text: 'Thinking.' };
  return { type: 'tool-call', id: `${item.call_id}|${item.id}`, name: item.name, arguments: item.arguments };
}
function replayBlock(item) {
  if (item.type === 'message') return { type: 'text', textSignature: JSON.stringify({ v: 1, id: item.id, ...(item.phase ? { phase: item.phase } : {}) }) };
  if (item.type === 'reasoning') return { type: 'reasoning', thinkingSignature: JSON.stringify(item) };
  return { type: 'tool-call' };
}
async function completed(output = [search, answer], config = policy, opts = options()) {
  const hooks = prepareNativeSearch(opts, config);
  hooks.onPayload(payload(), model);
  for (const [output_index, item] of output.entries()) {
    hooks.onProviderStreamEvent({ type: 'response.output_item.added', output_index, item }, model);
    hooks.onProviderStreamEvent({ type: 'response.output_item.done', output_index, item }, model);
  }
  hooks.onProviderStreamEvent({ type: 'response.completed', response: { output } }, model);
  const standard = output.filter((item) => item.type !== 'web_search_call');
  const chunks = [];
  standard.forEach((item, index) => {
    const block = piBlock(item);
    chunks.push({ type: 'block-start', index, blockType: block.type }, { type: 'block-end', index, block });
  });
  chunks.push({ type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }, { type: 'finish', reason: { kind: 'stop' }, replayState: {
    response: { kind: 'pi-ai', version: 2, api: model.api, provider: model.provider, model: model.id, stopReason: 'stop' },
    blocks: standard.map(replayBlock),
  } });
  const result = await collect(hooks.wrapStream(values(chunks)));
  const state = result.at(-1).replayState;
  const message = { role: 'assistant', content: result.filter((c) => c.type === 'block-end').map((c) => c.block),
    source: { provider: opts.provider, model: opts.model, replayState: state } };
  const wire = standard.map((item) => item.type === 'message'
    ? { ...structuredClone(item), content: [{ type: 'output_text', text: piBlock(item).text, annotations: [] }] }
    : item.type === 'function_call' ? { ...structuredClone(item), status: undefined } : structuredClone(item));
  wire.push({ type: 'message', role: 'assistant', id: 'msg_pi_trace', status: 'completed',
    content: [{ type: 'output_text', text: message.content.at(-1).text, annotations: [] }] });
  return { result, state, message, wire, hooks, chunks };
}
function replay(fixture, changeMessages = (m) => m, changePayload = (p) => p, config = policy, target = model) {
  const messages = changeMessages([...structuredClone(initial), structuredClone(fixture.message), user('Summarize it.')]);
  const hooks = prepareNativeSearch(options(messages), config);
  return hooks.onPayload(changePayload(payload(structuredClone(fixture.wire))), target);
}
function noNative(result) { assert.ok(!result.input.some((i) => i.type === 'web_search_call')); }

// These tests deliberately import no provider clients and perform no network I/O.
test('payload declares exact flat SDK allowed_tools, preserves functions, and is detached', () => {
  const input = payload([{ role: 'user', content: 'hello' }]);
  input.tools.push({ type: 'image_generation', model: 'unapproved' }, { type: 'web_search_preview' });
  const before = structuredClone(input);
  const hooks = prepareNativeSearch(options(), policy);
  const result = hooks.onPayload(input, model);
  assert.deepEqual(result.tools, [fn, { type: 'web_search' }]);
  assert.deepEqual(result.tool_choice, { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: fn.name }, { type: 'web_search' }] });
  assert.deepEqual(result.include, ['reasoning.encrypted_content', 'web_search_call.action.sources']);
  result.tools[0].parameters.type = 'changed';
  result.input[0].content = 'changed';
  assert.deepEqual(input, before);
});

test('unsupported declared tools fail explicitly instead of silently changing functionality', () => {
  for (const declaration of [{ type: 'custom', name: 'custom_tool' }, { type: 'namespace', name: 'ns' },
    { type: 'mcp', server_label: 'unapproved' }, { type: 'function', name: '' }]) {
    const hooks = prepareNativeSearch(options(), policy);
    assert.throws(() => hooks.onPayload({ tools: [declaration], input: [] }, model), { code: 'NATIVE_SEARCH_UNSUPPORTED_TOOL' });
  }
});

test('disabled and auxiliary calls retain only function permissions; empty toolset uses none', () => {
  for (const opts of [options(), options(initial, { purpose: 'session-title' }), options(initial, { purpose: 'compaction' })]) {
    const hooks = prepareNativeSearch(opts, opts.purpose ? policy : { enabled: false });
    const result = hooks.onPayload(payload(), model);
    assert.deepEqual(result.tools, [fn]);
    assert.deepEqual(result.tool_choice.tools, [{ type: 'function', name: fn.name }]);
    assert.ok(!result.include.includes('web_search_call.action.sources'));
  }
  assert.equal(prepareNativeSearch(options(), {}).onPayload({ input: [] }, model).tool_choice, 'none');
  assert.ok(prepareNativeSearch(options(initial, { purpose: 'compaction' }), { enabled: true, allowAuxiliary: true })
    .onPayload(payload(), model).tools.some((t) => t.type === 'web_search'));
});

test('ordinary text stream is unchanged and failed/empty streams do not become success', async () => {
  const ordinary = [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
    { type: 'usage', usage: {} }, { type: 'finish', reason: { kind: 'stop' } }];
  assert.deepEqual(await collect(prepareNativeSearch(options(), policy).wrapStream(values(ordinary))), ordinary);
  const hooks = prepareNativeSearch(options(), policy);
  hooks.onProviderStreamEvent({ type: 'response.output_item.done', output_index: 0, item: search }, model);
  for (const kind of ['error', 'aborted']) {
    const end = [{ type: 'finish', reason: { kind, failure: { code: 'EMPTY_RESPONSE' } } }];
    assert.deepEqual(await collect(hooks.wrapStream(values(end))), end);
  }
});

test('sources become standard visible text and aligned pi-ai/version2 replay blocks', async () => {
  const { result, state, message } = await completed();
  assert.equal(state.response.kind, 'pi-ai');
  assert.equal(state.response.version, 2);
  assert.equal(state.response.nativeSearch.version, 1);
  assert.equal(state.response.nativeSearch.replayable, true);
  assert.equal(state.blocks.length, message.content.length);
  assert.deepEqual(state.blocks.at(-1), { type: 'text' });
  assert.match(message.content.at(-1).text, /\[Example docs\]\(<https:\/\/example.com\/docs>\)/);
  assert.deepEqual(result.slice(-2).map((c) => c.type), ['usage', 'finish']);
  assert.ok(result.every((c) => ['block-start', 'block-end', 'text-delta', 'usage', 'finish'].includes(c.type)));
  assert.ok(!result.some((c) => c.block?.type === 'tool-call'));
});

test('same-model unchanged history restores native order, items and annotations exactly', async () => {
  const fixture = await completed([reasoning, search, functionCall, answer]);
  const result = replay(fixture);
  assert.deepEqual(result.input.slice(0, 4).map((i) => i.id), ['rs_one', 'ws_one', 'fc_one', 'msg_one']);
  assert.deepEqual(result.input[1], search);
  assert.deepEqual(result.input[3].content[0].annotations, [citation]);
  assert.deepEqual(result.input[2].arguments, functionCall.arguments);
  assert.equal(result.input.at(-1).id, 'msg_pi_trace');
});

test('changed content, pruned blocks, changed prefix, wrong route/model all degrade to existing text', async () => {
  const fixture = await completed();
  noNative(replay(fixture, (m) => { m[1].content[0].text += ' Edited.'; return m; }));
  noNative(replay(fixture, (m) => { m[1].content.pop(); m[1].source.replayState.blocks.pop(); return m; }));
  noNative(replay(fixture, (m) => { m[0].content[0].text = 'different question'; return m; }));
  noNative(replay(fixture, (m) => m.slice(1)));
  noNative(replay(fixture, (m) => { m[1].source.provider = 'other-route'; return m; }));
  noNative(replay(fixture, (m) => m, (p) => p, policy, { ...model, id: 'other-model' }));
  noNative(replay(fixture, (m) => m, (p) => p, { enabled: false }));
});

test('missing, duplicated, reordered or changed wire id anchors never reinsert native metadata', async () => {
  const fixture = await completed([reasoning, search, answer]);
  noNative(replay(fixture, (m) => m, (p) => { p.input.splice(0, 1); return p; }));
  noNative(replay(fixture, (m) => m, (p) => { p.input.push(structuredClone(p.input[0])); return p; }));
  noNative(replay(fixture, (m) => m, (p) => { [p.input[0], p.input[1]] = [p.input[1], p.input[0]]; return p; }));
  noNative(replay(fixture, (m) => m, (p) => { p.input[1].content[0].text = 'changed'; return p; }));
  noNative(replay(fixture, (m) => m, (p) => { p.input.pop(); return p; }));
});

test('malformed stored metadata degrades instead of throwing or replaying unsafe items', async () => {
  const fixture = await completed();
  noNative(replay(fixture, (m) => { m[1].source.replayState.blocks[0] = null; return m; }));
  noNative(replay(fixture, (m) => { m[1].source.replayState.response.nativeSearch.sequence[0].item.action.sources[0].url = 'javascript:evil'; return m; }));
  noNative(replay(fixture, (m) => { m[1].source.replayState.response.nativeSearch.sequence[1].annotations[0].annotation.url = 'data:bad'; return m; }));
  noNative(replay(fixture, (m) => { m[1].source.replayState.response.nativeSearch.sequence.push(null); return m; }));
});

test('multipart annotations are flattened to pi replay offsets; stream-only annotations are captured', async () => {
  const multiple = structuredClone(answer);
  multiple.content.unshift({ type: 'output_text', text: 'Prefix ', annotations: [] });
  const fixture = await completed([search, multiple]);
  const actual = replay(fixture).input.find((i) => i.id === answer.id).content[0].annotations[0];
  assert.deepEqual(actual, { ...citation, start_index: 7, end_index: 13 });
  const single = structuredClone(answer);
  single.content[0].annotations = [];
  const hooks = prepareNativeSearch(options(), policy);
  hooks.onProviderStreamEvent({ type: 'response.output_text.annotation.added', item_id: answer.id, content_index: 0, annotation_index: 0, annotation: citation }, model);
  hooks.onProviderStreamEvent({ type: 'response.output_item.done', output_index: 0, item: single }, model);
  const chunks = [
    { type: 'block-end', index: 0, block: piBlock(single) },
    { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { kind: 'pi-ai', version: 2, ...model, model: model.id, stopReason: 'stop' }, blocks: [replayBlock(single)] } },
  ];
  const wrapped = await collect(hooks.wrapStream(values(chunks)));
  assert.deepEqual(wrapped.at(-1).replayState.response.nativeSearch.sequence[0].annotations, [{ contentIndex: 0, annotation: citation }]);
});

test('URL schemes, credentials and Markdown injection are never emitted or persisted', async () => {
  const evil = structuredClone(answer);
  evil.content[0].annotations = [
    { ...citation, url: 'javascript:alert(1)', title: 'bad' },
    { ...citation, url: 'data:image/png;base64,SECRET', title: 'bad' },
    { ...citation, url: 'https://user:password@example.com/', title: 'bad' },
    { ...citation, title: '![attack](javascript:evil)\n<script>', url: 'https://example.com/(docs)?x=<script>' },
  ];
  const fixture = await completed([evil]);
  const saved = JSON.stringify(fixture.state.response.nativeSearch);
  const trace = fixture.message.content.at(-1).text;
  assert.ok(!saved.includes('"url":"javascript:') && !saved.includes('base64') && !saved.includes('password'));
  assert.ok(!trace.includes('<script>'));
  assert.match(trace, /\\!\\\[attack\\\]/);
  assert.equal(fixture.state.response.nativeSearch.replayable, false);
});

test('source and metadata bounds force safe text-only fallback without huge persisted payloads', async () => {
  const huge = structuredClone(search);
  huge.action.sources = Array.from({ length: 30 }, (_, i) => ({ type: 'url', url: `https://example.com/${i}/${'x'.repeat(200)}` }));
  huge.unknown_secret = 'never-save-this';
  const fixture = await completed([huge, answer], { enabled: true, maxSources: 2, maxMetadataBytes: 1024 });
  const native = fixture.state.response.nativeSearch;
  assert.ok(native.sources.length <= 2);
  assert.ok(Buffer.byteLength(JSON.stringify(native)) <= 1024);
  assert.equal(native.replayable, false);
  assert.equal(native.sequence, undefined);
  assert.ok(!JSON.stringify(native).includes('never-save-this'));
});

test('returned native images always fail explicitly without keeping image bytes', async () => {
  for (const event of [
    { type: 'response.image_generation_call.partial_image', partial_image_b64: 'PRIVATE_IMAGE' },
    { type: 'response.output_item.added', item: { type: 'image_generation_call', result: 'PRIVATE_IMAGE' } },
    { type: 'response.completed', response: { output: [{ type: 'image_generation_call', result: 'PRIVATE_IMAGE' }] } },
  ]) {
    const hooks = prepareNativeSearch(options(), policy);
    assert.throws(() => hooks.onProviderStreamEvent(event, model), (e) => e instanceof NativeSearchError && e.code === 'NATIVE_IMAGE_UNSUPPORTED' && !JSON.stringify(e).includes('PRIVATE_IMAGE'));
    await assert.rejects(collect(hooks.wrapStream(values([{ type: 'finish', reason: { kind: 'error' } }]))), { code: 'NATIVE_IMAGE_UNSUPPORTED' });
  }
});

test('disabled search, unapproved native tools and undeclared functions fail closed', () => {
  const disabled = prepareNativeSearch(options(), { enabled: false });
  assert.throws(() => disabled.onProviderStreamEvent({ type: 'response.output_item.done', output_index: 0, item: search }, model), { code: 'NATIVE_SEARCH_DISABLED' });
  const cited = prepareNativeSearch(options(initial, { purpose: 'session-title' }), policy);
  assert.throws(() => cited.onProviderStreamEvent({ type: 'response.output_item.done', output_index: 0, item: answer }, model), { code: 'NATIVE_SEARCH_DISABLED' });
  for (const item of [{ type: 'file_search_call' }, { ...functionCall, name: 'unapproved' }]) {
    const hooks = prepareNativeSearch(options(), policy);
    hooks.onPayload(payload(), model);
    assert.throws(() => hooks.onProviderStreamEvent({ type: 'response.output_item.added', item }, model), { code: 'UNAPPROVED_NATIVE_TOOL' });
  }
});

test('invalid policy is typed; independent calls share no mutable capture state', async () => {
  for (const p of [{ maxSources: 0 }, { maxSources: 33 }, { maxMetadataBytes: 100 }, { maxSources: NaN }]) {
    assert.throws(() => prepareNativeSearch(options(), p), { code: 'NATIVE_SEARCH_INVALID_POLICY' });
  }
  assert.equal(NATIVE_SEARCH_LIMITS.maxSources, 12);
  await completed();
  const next = prepareNativeSearch(options(), policy);
  const end = [{ type: 'finish', reason: { kind: 'stop' } }];
  assert.deepEqual(await collect(next.wrapStream(values(end))), end);
});
