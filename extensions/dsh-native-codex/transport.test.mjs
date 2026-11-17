import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareTransport } from './transport.mjs';

const failure = (code = 'PI_AI_ERROR') => ({ type: 'finish', reason: { kind: 'error', failure: { code, message: 'Upstream interrupted' } } });
async function collect(transport, ...chunks) {
  const output = [];
  for await (const chunk of transport.wrap((async function* () { yield* chunks; })())) output.push(chunk);
  return output;
}
const reset = () => Object.assign(new Error('do not expose private upstream text'), { cause: { code: 'ECONNRESET' } });

test('client request identity preserves session affinity and uses a safe server request id', async () => {
  let sent;
  const transport = prepareTransport({ nativeImageRequested: false, fetchImpl: async (_url, init) => {
    sent = new Headers(init.headers);
    return new Response('fixture', { headers: { 'x-request-id': 'req_fixture-1' } });
  } });
  await transport.fetch('https://gateway.example.com/v1/responses', { headers: { session_id: 'session-fixture', Authorization: 'Bearer fixture' } });
  assert.equal(sent.get('session_id'), 'session-fixture');
  assert.equal(sent.get('authorization'), 'Bearer fixture');
  assert.match(sent.get('x-client-request-id'), /^[0-9a-f-]{36}$/);
  const [result] = await collect(transport, failure('HTTP_ERROR'));
  assert.equal(result.reason.failure.requestId, 'req_fixture-1');
  assert.match(result.reason.failure.message, /client_request_id=/);
});

test('pre-output connection failure is retryable transport without raw private error text', async () => {
  const transport = prepareTransport({ nativeImageRequested: false, fetchImpl: async () => { throw reset(); } });
  await assert.rejects(transport.fetch('https://gateway.example.com/v1/responses'));
  const [result] = await collect(transport, failure());
  assert.equal(result.reason.failure.code, 'TRANSPORT');
  assert.match(result.reason.failure.message, /cause.code=ECONNRESET/);
  assert.ok(!result.reason.failure.message.includes('private upstream'));
});

test('text already emitted makes a later transport interruption non-retryable', async () => {
  const transport = prepareTransport({ nativeImageRequested: false });
  const text = { type: 'text-delta', text: 'Visible answer' };
  const output = await collect(transport, text, failure('TRANSPORT'));
  assert.deepEqual(output[0], text);
  assert.equal(output[1].reason.failure.code, 'TRANSPORT_INTERRUPTED');
});

test('native search or image events make interruptions non-retryable before text', async () => {
  for (const event of [
    { type: 'response.web_search_call.in_progress' },
    { type: 'response.image_generation_call.in_progress' },
    { type: 'response.output_item.added', item: { type: 'web_search_call' } },
    { type: 'response.completed', response: { output: [{ type: 'image_generation_call' }] } },
  ]) {
    const transport = prepareTransport({ nativeImageRequested: false });
    transport.observe(event);
    assert.equal((await collect(transport, failure('TRANSPORT')))[0].reason.failure.code, 'TRANSPORT_INTERRUPTED');
  }
});

test('all host-default retryable failures become terminal after native work or visible output', async () => {
  for (const code of ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']) {
    const transport = prepareTransport({ nativeImageRequested: false });
    transport.observe({ type: 'response.output_item.done', item: { type: 'web_search_call' } });
    const [result] = await collect(transport, failure(code));
    assert.equal(result.reason.failure.code, 'TRANSPORT_INTERRUPTED', code);
    if (code !== 'TRANSPORT') assert.match(result.reason.failure.message, new RegExp('origin.code=' + code));
    const safe = prepareTransport({ nativeImageRequested: false });
    assert.equal((await collect(safe, failure(code)))[0].reason.failure.code, code);
  }
});

test('configured provider retry codes are honored without masking unrelated terminal errors', async () => {
  const transport = prepareTransport({ nativeImageRequested: true, retryableCodes: ['VENDOR_RETRY'] });
  assert.equal((await collect(transport, failure('VENDOR_RETRY')))[0].reason.failure.code, 'TRANSPORT_INTERRUPTED');
  assert.equal((await collect(transport, failure('MISSING_CREDENTIAL')))[0].reason.failure.code, 'MISSING_CREDENTIAL');
});

test('requesting paid native image work is conservative even before the first event', async () => {
  const transport = prepareTransport({ nativeImageRequested: true });
  assert.equal((await collect(transport, failure('TRANSPORT')))[0].reason.failure.code, 'TRANSPORT_INTERRUPTED');
});

test('SSE read failures retain a stable transport cause and request identity', async () => {
  const transport = prepareTransport({ nativeImageRequested: false, fetchImpl: async () => new Response(new ReadableStream({
    pull() { throw reset(); },
  }), { headers: { 'content-type': 'text/event-stream', 'request-id': 'stream_request' } }) });
  const response = await transport.fetch('https://gateway.example.com/v1/responses');
  await assert.rejects(response.text());
  const [result] = await collect(transport, failure());
  assert.equal(result.reason.failure.code, 'TRANSPORT');
  assert.equal(result.reason.failure.requestId, 'stream_request');
});

test('explicit cancellation is not recategorized as a retryable network error', async () => {
  const controller = new AbortController();
  const transport = prepareTransport({ nativeImageRequested: false, fetchImpl: async () => { controller.abort(); throw reset(); } });
  await assert.rejects(transport.fetch('https://gateway.example.com/v1/responses', { signal: controller.signal }));
  assert.equal((await collect(transport, failure()))[0].reason.failure.code, 'PI_AI_ERROR');
});

test('unsafe response ids and cause strings are not copied into diagnostics', async () => {
  const transport = prepareTransport({ nativeImageRequested: false, fetchImpl: async () => new Response('fixture', { headers: { 'x-request-id': 'bad id with spaces' } }) });
  await transport.fetch('https://gateway.example.com/v1/responses');
  const [result] = await collect(transport, failure('HTTP_ERROR'));
  assert.match(result.reason.failure.requestId, /^[0-9a-f-]{36}$/);
  assert.ok(!JSON.stringify(result).includes('bad id'));
});

test('SSE consumer cancellation reaches the original reader', async () => {
  let cancelled = false;
  const transport = prepareTransport({ nativeImageRequested: false, fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode('data: fixture\n\n')); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } }) });
  const response = await transport.fetch('https://gateway.example.com/v1/responses');
  await response.body.cancel();
  assert.equal(cancelled, true);
});
