import { createHash } from 'node:crypto';

const maxBytes = 8 * 1024 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const imageIntent = /生图|文生图|(?:画|绘制|生成|制作|编辑|修改|重绘|画出)[^,，。.!?！？;；\n]{0,18}?(?:图片|插画|海报|图像|图标|示意图|架构图|流程图|漫画|图)|(?:这|上|刚才)[^,，。.!?！？;；\n]{0,10}?(?:张图|图片|图像)[^,，。.!?！？;；\n]{0,16}?(?:改|换|编辑)|\b(?:generate|draw|create|edit|render|modify|illustrate|make)\b[^,，。.!?！？;；\n]{0,30}?\b(?:images?|pictures?|illustrations?|posters?|diagrams?|logos?|artwork)\b/giu;
const technicalImage = /\b(?:docker|oci|container|vm|virtual machine|disk|system|base|boot)\s+images?\b/iu;
const negatedPrefix = /(?:\bdo not\b|\bdon['’]t\b|不要|无需|不用|禁止)\s*$/iu;
const requestedMcp = /mcp__gateway__(?:generate|edit)_image|(?:use|via|with|调用|使用|通过)\s*(?:the\s+)?(?:gateway\s+)?mcp\b/iu;

const isUserMessage = (message) => message.role === 'user' && (!message.source || message.source.kind === 'user');

function wantsImage(message) {
  const text = message?.content?.filter((part) => part.type === 'text').map((part) => part.text).join(' ') ?? '';
  const matches = [...text.matchAll(imageIntent)].filter((match) => !technicalImage.test(match[0]));
  return matches.length > 0 && !matches.some((match) => negatedPrefix.test(text.slice(0, match.index))) &&
    !requestedMcp.test(text);
}

function latestImage(messages, start) {
  for (let i = start; i >= 0 && !isUserMessage(messages[i]); i--) {
    const message = messages[i];
    const state = message.source?.replayState?.response?.nativeImages;
    if (message.role !== 'assistant' || state?.version !== 1) continue;
    const ref = state.image;
    if (['image/png', 'image/jpeg', 'image/webp'].includes(ref?.mediaType) && /^sha256:[0-9a-f]{64}$/.test(ref.attachmentId) &&
        Number.isSafeInteger(ref.bytes) && ref.bytes > 0 && ref.bytes <= maxBytes) return ref;
  }
}

export function prepareNativeImages(options, attachments, enabled) {
  const messages = options.messages ?? [];
  const userIndex = messages.findLastIndex(isUserMessage);
  const user = messages[userIndex];
  const allowed = enabled && options.purpose == null && user !== undefined;
  const authorized = allowed && wantsImage(user) && !latestImage(messages, messages.length - 1);
  const previous = allowed && !user.content?.some((part) => part.type === 'image')
    ? latestImage(messages, userIndex - 1) : undefined;
  const tool = authorized ? { type: 'image_generation', model: 'gpt-image-2', output_format: 'png' } : undefined;
  let image;
  return {
    tool,
    capture(item) {
      if (!item.result) return;
      if (item.status !== 'completed' || item.output_format !== 'png' || typeof item.id !== 'string' ||
          typeof item.result !== 'string' || item.result.length > Math.ceil(maxBytes / 3) * 4) {
        throw new Error('Native image result is invalid or exceeds the configured PNG size limit');
      }
      if (image?.id === item.id && image.result === item.result) return;
      if (image) throw new Error('The adapter accepts one native image per response');
      const bytes = Buffer.from(item.result, 'base64');
      if (bytes.length > maxBytes || bytes.toString('base64') !== item.result ||
          !bytes.subarray(0, 8).equals(pngSignature)) throw new Error('Invalid native PNG encoding');
      image = { id: item.id, result: item.result, bytes };
    },
    async project(payload) {
      if (tool) {
        delete payload.reasoning;
        const instruction = 'Use the built-in image_generation tool to produce the requested image. Use other tools for any prerequisite work.';
        payload.instructions = [payload.instructions, instruction].filter(Boolean).join('\n\n');
      }
      if (!previous || !Array.isArray(payload.input)) return payload;
      const target = payload.input.findLast((item) => item.role === 'user');
      if (!target) return payload;
      options.signal?.throwIfAborted();
      let stored;
      try {
        stored = await attachments.readImage(previous, options.signal);
      } catch (error) {
        options.signal?.throwIfAborted();
        if (tool) throw error;
        return payload;
      }
      options.signal?.throwIfAborted();
      if (stored.data.byteLength > maxBytes) throw new Error('Previous native image exceeds the request limit');
      const data = Buffer.from(stored.data).toString('base64');
      const content = typeof target.content === 'string' ? [{ type: 'input_text', text: target.content }] : target.content;
      if (Array.isArray(content)) {
        target.content = [...content, { type: 'input_image', image_url: `data:${stored.ref.mediaType};base64,${data}`, detail: 'auto' }];
      }
      return payload;
    },
    async *wrap(stream) {
      let index = -1;
      const usage = [];
      for await (let chunk of stream) {
        if (Number.isInteger(chunk.index)) index = Math.max(index, chunk.index);
        if (chunk.type === 'usage') {
          usage.push(chunk);
          continue;
        }
        if (chunk.type !== 'finish') {
          yield chunk;
          continue;
        }
        if (image && !['error', 'aborted'].includes(chunk.reason?.kind)) {
          if (!attachments) throw new Error('Native image output requires the DSH attachment store');
          options.signal?.throwIfAborted();
          const name = `codex-image-${createHash('sha256').update(image.bytes).digest('hex').slice(0, 12)}.png`;
          const preview = await attachments.saveImage({ data: image.bytes, mediaType: 'image/png', name });
          options.signal?.throwIfAborted();
          const original = await attachments.saveFile({ data: image.bytes, name });
          options.signal?.throwIfAborted();
          const path = attachments.fileHostPath(original);
          if (!path) throw new Error('Native image original cannot be opened on this host');
          const url = encodeURI(path).replace(/[<>()#?]/g, (char) => '%' + char.charCodeAt(0).toString(16));
          const text = `\n\n![Codex image](<${url}>)\n\n[原图 PNG](<${url}>)`;
          const replayState = structuredClone(chunk.replayState ?? { response: {} });
          replayState.response.nativeImages = { version: 1, image: preview, original };
          if (replayState.response.nativeSearch) {
            replayState.response.nativeSearch.replayable = false;
            delete replayState.response.nativeSearch.sequence;
          }
          if (Array.isArray(replayState.blocks)) replayState.blocks.push({ type: 'text' });
          index += 1;
          yield { type: 'block-start', index, blockType: 'text' };
          yield { type: 'text-delta', index, text };
          yield { type: 'block-end', index, block: { type: 'text', text } };
          chunk = { ...chunk, replayState };
        }
        for (const item of usage) yield item;
        yield chunk;
        return;
      }
      for (const item of usage) yield item;
    },
  };
}
