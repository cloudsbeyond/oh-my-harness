/** Host-side adaptation between the speech Remote's canonical 16 kHz WAV and
 * the capability core's 24 kHz PCM16 WAV. Self-contained: this package must not
 * import the repository core, because it is installed as an independent bundle. */

export const maxRecordingSeconds = 40;
export const maxRecordingBytes = 44 + maxRecordingSeconds * 16_000 * 2;

export class SpeechInputError extends Error {
  constructor(message, code = 'INPUT_INVALID') { super(message); this.name = 'SpeechInputError'; this.code = code; }
}

const invalid = () => { throw new SpeechInputError('Expected canonical mono 16 kHz PCM16 WAV between 100 ms and 40 seconds'); };

/** Validate the strict 44-byte-header recording and convert it to real 24 kHz PCM. */
export function resampleRecording(audio) {
  if (!(audio instanceof Uint8Array) || audio.byteLength < 3244 || audio.byteLength > maxRecordingBytes) invalid();
  const input = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  if (input.toString('ascii', 0, 4) !== 'RIFF' || input.readUInt32LE(4) !== input.length - 8 ||
      input.toString('ascii', 8, 16) !== 'WAVEfmt ' || input.readUInt32LE(16) !== 16 ||
      input.readUInt16LE(20) !== 1 || input.readUInt16LE(22) !== 1 || input.readUInt32LE(24) !== 16000 ||
      input.readUInt32LE(28) !== 32000 || input.readUInt16LE(32) !== 2 || input.readUInt16LE(34) !== 16 ||
      input.toString('ascii', 36, 40) !== 'data' || input.readUInt32LE(40) !== input.length - 44 || (input.length - 44) % 2) invalid();
  const frames = (input.length - 44) / 2;
  const outputFrames = Math.round(frames * 1.5);
  const output = Buffer.alloc(44 + outputFrames * 2);
  input.copy(output, 0, 0, 44);
  output.writeUInt32LE(output.length - 8, 4); output.writeUInt32LE(24000, 24);
  output.writeUInt32LE(48000, 28); output.writeUInt32LE(outputFrames * 2, 40);
  for (let i = 0; i < outputFrames; i++) {
    const position = i * 2 / 3;
    const left = Math.min(Math.floor(position), frames - 1), right = Math.min(left + 1, frames - 1);
    const a = input.readInt16LE(44 + left * 2), b = input.readInt16LE(44 + right * 2);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * (position - left)))), 44 + i * 2);
  }
  return { data: output, audioSeconds: frames / 16000 };
}
