import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export function setting(name) {
  return process.env[`OH_MY_HARNESS_${name}`] ?? process.env[`OH_MY_DSH_${name}`];
}

export const root = fileURLToPath(new URL('../', import.meta.url));
export const stateDir = path.resolve(setting('STATE_DIR') ?? path.join(root, '.state'));
export const defaultConfigPath = path.join(root, 'config/default.json');
const localConfigPath = path.join(stateDir, 'config.json');
export const gatewayKeyFile = () => path.resolve(setting('KEY_FILE') ?? path.join(stateDir, 'gateway.key'));
export const modelKeyFile = () => path.resolve(setting('MODEL_KEY_FILE') ?? path.join(stateDir, 'model.key'));
export const upstreamKeyFile = () => path.resolve(setting('UPSTREAM_KEY_FILE') ?? modelKeyFile());

export const modelId = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/)
  .refine((id) => id.split('/').every((part) => part && part !== '.' && part !== '..'), 'Use a valid model ID');
const providerId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const toolCapabilities = ['vision', 'documents', 'video', 'search', 'images', 'audio'];
const capability = z.enum(['text', ...toolCapabilities]);
const storedCapability = z.enum([...capability.options, 'structured', 'tokens']);
const model = z.strictObject({
  id: modelId,
  name: z.string().min(1).max(100).optional(),
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
}).refine((value) => value.maxTokens < value.contextWindow, 'maxTokens must be smaller than contextWindow');
const provider = z.strictObject({
  name: z.string().min(1).max(100),
  protocol: z.enum(['responses', 'chat', 'messages']),
  models: z.array(model).min(1),
  capabilities: z.array(storedCapability).min(1)
    .transform((items) => items.filter((item) => capability.options.includes(item))),
  search: z.enum(['responses', 'messages']).optional(),
  imageModel: modelId.optional(),
  realtimeModel: modelId.optional(),
  transcriptionModel: modelId.optional(),
  tokenSource: z.enum(['proxy_estimate', 'provider_count']).optional(),
  modelToolAliases: z.array(modelId).optional(),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
});

const listener = z.strictObject({
  port: z.number().int().min(1024).max(65535),
  publicOrigin: z.string().optional(),
  maxConcurrentRequests: z.number().int().min(1).max(100).default(16),
});

const configSchema = z.strictObject({
  listen: listener,
  upstream: z.string(),
  modelTools: z.boolean().optional(),
  providers: z.record(providerId, provider),
  defaults: z.partialRecord(storedCapability, providerId)
    .transform(({ structured, tokens, ...defaults }) => defaults),
}).transform((config) => {
  if (config.modelTools) return config;
  const providers = Object.fromEntries(Object.entries(config.providers)
    .map(([id, { tokenSource, modelToolAliases, ...item }]) => [id, item]));
  return { ...config, providers };
});

export function endpoint(value, kind) {
  const url = new URL(value);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost';
  const tls = url.protocol === 'https:';
  const pathname = kind === 'api' ? /^\/v1\/?$/ : kind === 'mcp' ? /^\/mcp$/ : /^\/$/;
  if ((!tls && !(kind !== 'public' && loopback && url.protocol === 'http:')) ||
      !pathname.test(url.pathname) || url.username || url.password || url.search || url.hash) {
    if (kind === 'public') throw new Error('Use a valid HTTPS origin');
    throw new Error('Use an HTTPS or loopback HTTP URL ending in ' + (kind === 'mcp' ? '/mcp' : '/v1'));
  }
  if (kind === 'api') url.pathname = '/v1/';
  return url;
}

export function gatewayEndpoint(defaultURL) {
  const mcpURL = setting('MCP_URL');
  if (mcpURL) return endpoint(mcpURL, 'mcp');
  if (process.env.OH_MY_DSH_URL) return new URL('/mcp', endpoint(process.env.OH_MY_DSH_URL, 'api'));
  return endpoint(defaultURL, 'mcp');
}

export function readConfig(file = setting('CONFIG') ?? (existsSync(localConfigPath) ? localConfigPath : defaultConfigPath)) {
  const parsed = configSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    throw new Error('Invalid Gateway configuration: ' + parsed.error.issues.map((issue) => issue.path.join('.')).join(', '));
  }
  const config = parsed.data;
  endpoint(config.upstream, 'api');
  if (config.listen.publicOrigin) endpoint(config.listen.publicOrigin, 'public');
  createRegistry(config);
  return config;
}

export function readKey(file = gatewayKeyFile()) {
  const key = readFileSync(file, 'utf8').trim();
  if (!/^[\x21-\x2b\x2d-\x7e]{16,512}$/.test(key)) throw new Error('Supply a key of 16–512 printable ASCII characters without commas or whitespace');
  return key;
}

export function createRegistry(config) {
  const providers = new Map(Object.entries(config.providers).map(([id, item]) => [id, { ...item, id }]));
  const models = new Map();
  const modelToolAliases = new Map();
  if (!providers.size) throw new Error('Configure at least one provider');
  for (const [id, item] of providers) {
    const has = (name) => item.capabilities.includes(name);
    if (has('search') !== Boolean(item.search) || has('images') !== Boolean(item.imageModel) ||
        has('audio') !== Boolean(item.realtimeModel) || has('audio') !== Boolean(item.transcriptionModel) ||
        (has('documents') && item.protocol !== 'responses') || (has('video') && item.protocol !== 'chat')) {
      throw new Error('Inconsistent capabilities for provider ' + id);
    }
    for (const entry of item.models) {
      if (models.has(entry.id)) throw new Error('Model IDs must be unique across providers; set CLIProxyAPI aliases where needed');
      models.set(entry.id, item);
    }
  }
  if (config.modelTools) {
    for (const item of providers.values()) {
      for (const alias of item.modelToolAliases ?? []) {
        if (!item.capabilities.includes('text') || models.has(alias) || modelToolAliases.has(alias)) {
          throw new Error('Model tool aliases must be unique and belong to a text provider');
        }
        modelToolAliases.set(alias, item);
      }
    }
  }
  for (const name of capability.options) {
    const available = [...providers.values()].filter((item) => item.capabilities.includes(name));
    const preferred = config.defaults[name];
    if ((available.length && !preferred) || (preferred && !available.some((item) => item.id === preferred))) {
      throw new Error('Configure a valid default for capability ' + name);
    }
  }
  return {
    has: (name) => Boolean(config.defaults[name]),
    list: () => [...providers.values()],
    selectModelTool(model) {
      const item = models.get(model) ?? modelToolAliases.get(model);
      if (!item?.capabilities.includes('text')) throw new Error('Select a configured text model');
      return item;
    },
    select(name, id, model) {
      const owner = model === undefined ? undefined : models.get(model);
      const item = providers.get(id ?? owner?.id ?? config.defaults[name]);
      if (!item?.capabilities.includes(name) || (model !== undefined && owner !== item)) {
        throw new Error('Select a configured provider and model that support ' + name);
      }
      return { ...item, model: model ?? item.models[0].id };
    },
  };
}
