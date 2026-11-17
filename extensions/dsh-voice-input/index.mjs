import { resampleRecording } from './resample.mjs';

export const name = 'oh-my-harness-voice-input';
export const inject = ['speechToText', 'omhCapabilities'];

/** Provider-neutral STT contribution: the speech.transcribe operation default
 * (any registered provider, including a future local model) owns paid routing.
 * inferenceSeconds is measured end-to-end and includes transport time. */
export function createSpeechProvider(backend) {
  return {
    info: { id: 'oh-my-harness', name: 'oh-my-harness', location: 'cloud', languages: ['auto'] },
    async transcribe({ audio, language }, signal) {
      signal?.throwIfAborted();
      if (language !== 'auto') throw Object.assign(new Error('This speech provider supports automatic language detection only'), { code: 'INPUT_INVALID' });
      const converted = resampleRecording(audio);
      signal?.throwIfAborted();
      const started = performance.now();
      const result = await backend.execute('speech.transcribe', { audio: { data: converted.data, mimeType: 'audio/wav' } }, { signal });
      signal?.throwIfAborted();
      return { text: result.text, audioSeconds: converted.audioSeconds, inferenceSeconds: (performance.now() - started) / 1000 };
    },
  };
}

export function apply(ctx) {
  ctx.effect(() => ctx.speechToText.register(createSpeechProvider(ctx.omhCapabilities)));
}
