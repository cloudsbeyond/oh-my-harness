import { z } from 'zod';
import { operationCapabilities } from '../../src/capabilities/contracts.mjs';

const model = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/).refine((value) => value.split('/').every((part) => part && part !== '.' && part !== '..'));
const providerId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const operation = z.enum(Object.keys(operationCapabilities));
const endpoint = z.string().transform((value, context) => {
  try {
    const url = new URL(value);
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((!local && url.protocol !== 'https:') || !/^\/v1\/?$/.test(url.pathname) || url.username || url.password || url.search || url.hash) throw new Error();
    url.pathname = '/v1/'; return url.href;
  } catch { context.addIssue({ code: 'custom', message: 'Use an HTTPS or loopback HTTP model API /v1 base without embedded credentials' }); return z.NEVER; }
});
const profile = z.strictObject({
  name: z.string().min(1).max(100).optional(), enabled: z.boolean().default(true),
  protocol: z.enum(['responses', 'chat', 'messages']), baseURL: endpoint,
  credential: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
  models: z.array(model).min(1).max(64).refine((values) => new Set(values).size === values.length),
  operations: z.array(operation).min(1).max(9).refine((values) => new Set(values).size === values.length),
  search: z.enum(['responses', 'messages']).optional(), imageModel: model.optional(), realtimeModel: model.optional(), transcriptionModel: model.optional(),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
}).superRefine((value, context) => {
  const invalid = (message) => context.addIssue({ code: 'custom', message });
  if (value.operations.includes('document.inspect') && value.protocol !== 'responses') invalid('Document understanding requires a Responses provider');
  if (value.operations.includes('video.inspect') && value.protocol !== 'chat') invalid('Video understanding requires a Chat provider');
  if (value.operations.includes('web.search') && !value.search) invalid('Declare the native search protocol');
  if (value.operations.some((op) => ['image.generate', 'image.edit'].includes(op)) && !value.imageModel) invalid('Declare the image model');
  if (value.operations.some((op) => operationCapabilities[op] === 'audio') && !value.realtimeModel) invalid('Declare the realtime audio model');
  if (value.operations.includes('speech.transcribe') && !value.transcriptionModel) invalid('Declare the transcription model');
});
const schema = z.strictObject({
  providers: z.record(providerId, profile).default({}).refine((values) => Object.keys(values).length <= 32),
  defaults: z.partialRecord(operation, z.strictObject({ provider: providerId, model: model.optional() })).default({}),
  maxConcurrentTasks: z.number().int().min(1).max(16).default(4),
});

/** Host config contains references and endpoints, never raw credentials or MCP paths. */
export function parseNativeConfig(raw = {}) { return schema.parse(raw); }
