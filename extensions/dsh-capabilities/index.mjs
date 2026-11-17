import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { CapabilityError, operationCapabilities } from '../../src/capabilities/contracts.mjs';
import { createHostBackend } from './backend.mjs';
import { createNativeTools, nativeOperations } from './tools.mjs';

export const name = 'oh-my-harness-capabilities';
export const inject = ['credentials', 'tools', 'attachments', 'fs', 'workingDirectory', 'sandboxPolicy', 'web'];
const operations = Object.keys(operationCapabilities);
export const Config = z.object({
  providers: z.dict(z.object({
    name: z.string(), enabled: z.boolean().default(true), protocol: z.union(['responses', 'chat', 'messages']).required(),
    baseURL: z.string().required(), credential: z.string().required(), models: z.array(z.string()).required(), operations: z.array(z.union(operations)).required(),
    search: z.union(['responses', 'messages']), imageModel: z.string(), realtimeModel: z.string(), transcriptionModel: z.string(),
    reasoningEffort: z.union(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  })).default({}),
  defaults: z.dict(z.object({ provider: z.string().required(), model: z.string() }), z.union(operations)).default({}),
  maxConcurrentTasks: z.natural().min(1).max(16).default(4),
});

export function apply(ctx, config) {
  const backend = createHostBackend(ctx, config);
  // Register underlying cleanup before consumers; provide the service last so
  // its dependents unload before the backend drains its cooperative operations.
  ctx.effect(() => () => backend.dispose());
  const mapError = (error) => error instanceof CapabilityError ? new HarnessError(error.message, error.code) : error;
  for (const definition of createNativeTools({ ctx, backend, defineTool, mapError })) {
    const operation = nativeOperations[definition.name];
    ctx.tools.register(definition, operation ? { when: () => backend.hasOperation(operation) } : undefined);
  }
  ctx.web.registerSearchProvider({
    id: 'oh-my-harness', title: 'oh-my-harness',
    description: { en: 'Direct capability providers with host-managed credentials. Search evidence is not a raw HTTP fetch.', zh: '使用宿主管理的凭据直连能力供应方；搜索证据不冒充原始 HTTP 抓取。' },
    available: () => backend.hasOperation('web.search'),
    ready: () => backend.ready('web.search'),
    async search(request, signal) {
      try {
        const result = await backend.execute('web.search', { query: request.query, ...(request.maxResults === undefined ? {} : { maxResults: request.maxResults }) }, { signal });
        return { content: result.text, sources: result.sources ?? [], truncated: result.truncated ?? false };
      } catch (error) { throw mapError(error); }
    },
  });
  ctx.provide('omhCapabilities', backend);
}
