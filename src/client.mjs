import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export async function withGatewayClient(url, key, run, signal) {
  const deadline = AbortSignal.any([AbortSignal.timeout(190_000), ...(signal ? [signal] : [])]);
  const client = new Client({ name: 'oh-my-harness-client', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: 'Bearer ' + key }, redirect: 'error' },
    fetch: (input, init) => fetch(input, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])]),
    }),
  });
  try {
    await client.connect(transport);
    return await run(client, deadline);
  } finally {
    await client.close();
  }
}
