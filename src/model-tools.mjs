import Ajv from 'ajv';
import { z } from 'zod';
import { modelId } from './config.mjs';
import { chatText, messagesText, prompt, responseText, textResult } from './tools.mjs';

const instructionsInput = z.string().trim().min(1).max(1600).optional();
const ajv = new Ajv({ strict: true, strictRequired: true, ownProperties: true, addUsedSchema: false });
const schemaType = z.enum(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);
const schemaNode = z.strictObject({
  type: z.union([schemaType, z.tuple([schemaType, z.literal('null')])]).optional(),
  description: z.string().max(2000).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).max(100).optional(),
  additionalProperties: z.literal(false).optional(),
  items: z.unknown().optional(),
  enum: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).min(1).max(64).optional(),
  anyOf: z.array(z.unknown()).min(1).max(8).optional(),
});

function compileOutputSchema(schema) {
  const error = () => new Error('Invalid structured output schema. Use a closed object with every property required and supported nested types.');
  if (schema.type !== 'object' || schema.anyOf !== undefined) throw error();
  try {
    if (Buffer.byteLength(JSON.stringify(schema)) > 16 * 1024) throw error();
  } catch {
    throw error();
  }
  const pending = [{ node: schema, depth: 1 }];
  let nodes = 0;
  while (pending.length) {
    const { node, depth } = pending.pop();
    if (++nodes > 100 || depth > 8) throw error();
    if (node?.properties && Object.hasOwn(node.properties, '__proto__')) throw error();
    const checked = schemaNode.safeParse(node);
    if (!checked.success) throw error();
    const { type, properties, required, additionalProperties, items, anyOf } = checked.data;
    if (!type && !anyOf) throw error();
    const baseType = Array.isArray(type) ? type[0] : type;
    if (baseType === 'object' && (!properties || !required || additionalProperties !== false ||
      required.length !== Object.keys(properties).length)) throw error();
    if (baseType === 'array' && items === undefined) throw error();
    for (const child of [...Object.values(properties ?? {}), ...(items === undefined ? [] : [items]), ...(anyOf ?? [])]) {
      pending.push({ node: child, depth: depth + 1 });
    }
  }
  try {
    return ajv.compile(schema);
  } catch {
    throw error();
  } finally {
    ajv.removeSchema(schema);
  }
}

function structuredText(response, chat) {
  if (chat) {
    const choice = response.choices?.[0];
    if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') {
      throw new Error('The model refused the structured request');
    }
    if (choice?.finish_reason !== 'stop') throw new Error('The model returned an incomplete structured answer');
    return choice.message?.content;
  }
  if (response.output?.some((item) => item.type === 'message' && item.content?.some((part) => part.type === 'refusal'))) {
    throw new Error('The model refused the structured request');
  }
  if (response.status !== 'completed') throw new Error('The model returned an incomplete structured answer');
  return responseText(response).text;
}

function chatMessages(prompt, instructions) {
  return [...(instructions ? [{ role: 'system', content: instructions }] : []), { role: 'user', content: prompt }];
}

const inputSchema = z.object({ model: modelId, prompt, instructions: instructionsInput });
const annotations = { readOnlyHint: true };

export function registerModelTools(server, { registry, gateway }) {
  server.registerTool('list_models', {
    description: 'List model IDs available through the model API.',
    inputSchema: z.object({}), annotations,
  }, async (_args, { signal }) => {
    const { data } = await gateway('models', undefined, 15_000, signal);
    if (!Array.isArray(data)) throw new Error('The model API did not return a model list');
    return textResult({ models: data.map(({ id, owned_by }) => ({ id, owned_by })) });
  });

  server.registerTool('get_model', {
    description: 'Read model API metadata for one discovered model ID.',
    inputSchema: z.object({ model: modelId }), annotations,
  }, async ({ model }, { signal }) => textResult(await gateway(
    'models/' + encodeURIComponent(model), undefined, 15_000, signal,
  )));

  server.registerTool('generate_text', {
    description: 'Run one stateless text request with a configured model. Returns text, model and usage.',
    inputSchema, annotations,
  }, async ({ model, prompt, instructions }, { signal }) => {
    const { protocol } = registry.selectModelTool(model);
    let response;
    let answer;
    if (protocol === 'chat') {
      response = await gateway('chat/completions', { model, messages: chatMessages(prompt, instructions), stream: false }, 85_000, signal);
      answer = chatText(response);
    } else if (protocol === 'messages') {
      response = await gateway('messages', {
        model, system: instructions, messages: [{ role: 'user', content: prompt }], max_tokens: 4096, stream: false,
      }, 85_000, signal);
      answer = messagesText(response);
    } else {
      response = await gateway('responses', { model, input: prompt, instructions, stream: false, store: false }, 85_000, signal);
      answer = responseText(response).text;
    }
    return textResult({ answer, model: response.model ?? model, usage: response.usage });
  });

  server.registerTool('generate_structured', {
    description: 'Generate a validated JSON object with a configured Responses or Chat model that supports strict JSON Schema.',
    inputSchema: inputSchema.extend({ schema: z.looseObject({ type: z.literal('object') }) }), annotations,
  }, async ({ model, prompt, instructions, schema }, { signal }) => {
    const { protocol, reasoningEffort } = registry.selectModelTool(model);
    if (protocol === 'messages') throw new Error('Select a configured Responses or Chat model for structured output');
    const validate = compileOutputSchema(schema);
    const format = { name: 'gateway_output', schema, strict: true };
    const chat = protocol === 'chat';
    const response = chat
      ? await gateway('chat/completions', {
        model, messages: chatMessages(prompt, instructions), response_format: { type: 'json_schema', json_schema: format },
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}), max_tokens: 4096, stream: false,
      }, 85_000, signal)
      : await gateway('responses', {
        model, input: prompt, instructions, text: { format: { type: 'json_schema', ...format } },
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}), max_output_tokens: 4096, stream: false, store: false,
      }, 85_000, signal);
    const text = structuredText(response, chat);
    let data;
    try {
      if (typeof text !== 'string' || Buffer.byteLength(text) > 64 * 1024) throw new Error();
      data = JSON.parse(text);
    } catch {
      throw new Error('The model did not return a bounded JSON answer');
    }
    if (!validate(data)) throw new Error('The model answer does not match the requested JSON Schema');
    return textResult({ data, model: response.model ?? model, usage: response.usage });
  });

  server.registerTool('count_input_tokens', {
    description: 'Count text input tokens for a configured model. Returns the count and its configured source.',
    inputSchema: z.object({
      model: modelId, prompt: z.string().min(1).max(128_000), instructions: z.string().min(1).max(1600).optional(),
    }), annotations,
  }, async ({ model, prompt, instructions }, { signal }) => {
    const { tokenSource: source } = registry.selectModelTool(model);
    if (!source) throw new Error('Token counting is not configured for this model');
    const { input_tokens } = await gateway('messages/count_tokens', {
      model, system: instructions, messages: [{ role: 'user', content: prompt }],
    }, 30_000, signal);
    if (!Number.isSafeInteger(input_tokens) || input_tokens < 0) throw new Error('The model API did not return an input token count');
    return textResult({ model, input_tokens, source });
  });
}
