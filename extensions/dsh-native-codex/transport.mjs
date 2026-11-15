import { randomUUID } from 'node:crypto';

function transportCode(error) {
  const cause = error?.cause;
  for (const code of [cause?.code, error?.code]) {
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  }
}

function isNativeTool(item) {
  return item?.type === 'web_search_call' || item?.type === 'image_generation_call';
}

// Each prepared stream is one attempt. Capture failures before pi-ai flattens
// the SDK error and keep the session affinity header separate from request IDs.
export function prepareTransport({ nativeImageRequested }) {
  const clientRequestId = randomUUID();
  let requestId = clientRequestId;
  let causeCode;
  let transportFailed = false;
  let retryUnsafe = nativeImageRequested;

  function record(error) {
    transportFailed = true;
    causeCode = transportCode(error);
  }

  return {
    async fetch(input, init = {}) {
      const headers = new Headers(init.headers);
      headers.set('x-client-request-id', clientRequestId);
      let response;
      try {
        response = await globalThis.fetch(input, { ...init, headers });
      } catch (error) {
        if (!init.signal?.aborted) record(error);
        throw error;
      }
      for (const name of ['x-request-id', 'request-id']) {
        const id = response.headers.get(name);
        if (id && /^[\w.:-]{1,128}$/.test(id)) {
          requestId = id;
          break;
        }
      }
      if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        return response;
      }
      const reader = response.body.getReader();
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) controller.close();
            else controller.enqueue(value);
          } catch (error) {
            if (!init.signal?.aborted) record(error);
            controller.error(error);
          }
        },
        cancel: (reason) => reader.cancel(reason),
      }, { highWaterMark: 0 });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
    observe(event) {
      const type = typeof event?.type === 'string' ? event.type : '';
      if (type.startsWith('response.web_search_call.') || type.startsWith('response.image_generation_call.') ||
          isNativeTool(event?.item) || (Array.isArray(event?.response?.output) && event.response.output.some(isNativeTool))) {
        retryUnsafe = true;
      }
    },
    async *wrap(stream) {
      for await (const chunk of stream) {
        if ((chunk.type === 'text-delta' && chunk.text.length > 0) ||
            (chunk.type === 'block-end' && chunk.block.type === 'text' && chunk.block.text.length > 0)) retryUnsafe = true;
        if (chunk.type !== 'finish' || chunk.reason.kind !== 'error') {
          yield chunk;
          continue;
        }
        const failure = chunk.reason.failure;
        const isTransport = failure.code === 'TRANSPORT' || (transportFailed && failure.code === 'PI_AI_ERROR');
        const code = isTransport ? (retryUnsafe ? 'TRANSPORT_INTERRUPTED' : 'TRANSPORT') : failure.code;
        // The DSH failure schema persists requestId and message, with no cause field.
        const diagnostics = [
          ...(causeCode ? [`cause.code=${causeCode}`] : []),
          ...(requestId !== clientRequestId ? [`client_request_id=${clientRequestId}`] : []),
        ];
        const message = diagnostics.length ? `${failure.message} (${diagnostics.join(', ')})` : failure.message;
        yield { ...chunk, reason: { ...chunk.reason, failure: { ...failure, code, message, requestId } } };
      }
    },
  };
}
