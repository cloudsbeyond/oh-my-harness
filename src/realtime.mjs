// Compatibility entry for integrations that previously registered audio tools separately.
import { createProtocolRuntime } from './capabilities/protocol-provider.mjs';
import { createRealtimeExecutor } from './capabilities/realtime.mjs';
import { registerCapabilityTools } from './tools.mjs';
export { createRealtimeExecutor } from './capabilities/realtime.mjs';

export function registerRealtimeTools(server, { upstream, token, registry, requestSignal }) {
  if (!registry.has('audio')) return;
  const capabilities = createProtocolRuntime({ registry,
    gateway: async () => { throw new Error('This compatibility entry only executes audio operations'); },
    realtime: createRealtimeExecutor({ upstream, token, requestSignal }),
  });
  registerCapabilityTools(server, { capabilities, registry, operations: ['speech.synthesize', 'speech.transcribe', 'audio.inspect'] });
}
