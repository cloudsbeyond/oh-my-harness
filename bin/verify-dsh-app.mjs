#!/usr/bin/env node
/** Opt-in acceptance against an EXISTING authenticated DSH browser.
 * No browser/server launch, token/profile lookup, or model request by default.
 * --record explicitly permits microphone capture/cloud transcription; requires
 * DSH_E2E_EXPECT_TEXT and an empty draft. This is not a fixture or DOM emulator. */
import { spawnSync } from 'node:child_process';

const checks = [];
let stage = 'preconditions';
let recordingStarted = false;
const flags = new Set(process.argv.slice(2));
const play = flags.has('--play'), record = flags.has('--record');
const expected = process.env.DSH_E2E_EXPECT_TEXT;
const seconds = Number(process.env.DSH_E2E_RECORD_SECONDS ?? 3);
const cli = process.env.DSH_E2E_BROWSER_BIN ?? 'agent-browser';
const prefix = ['--session', `omh-app-acceptance-${process.pid}`, ...(process.env.DSH_E2E_CDP ? ['--cdp', process.env.DSH_E2E_CDP] : ['--auto-connect']), '--json'];

function fail(code, blocked = false) { throw Object.assign(new Error(code), { code, blocked }); }
function command(args, input) {
  const result = spawnSync(cli, [...prefix, ...args], { input, encoding: 'utf8', timeout: 210_000, maxBuffer: 512 * 1024,
    env: { ...process.env, AGENT_BROWSER_DEFAULT_TIMEOUT: '190000' } });
  // Do not print captured URLs, page text, CLI diagnostics or auth material.
  if (result.error?.code === 'ENOENT') fail('BROWSER_CLI_UNAVAILABLE', true);
  if (result.error || result.status !== 0) fail(stage === 'connect' ? 'EXISTING_BROWSER_UNAVAILABLE' : 'BROWSER_COMMAND_FAILED', stage === 'connect');
  let envelope;
  try { envelope = JSON.parse(result.stdout); } catch { fail('BROWSER_RESULT_INVALID'); }
  if (envelope.success !== true) fail(stage === 'connect' ? 'EXISTING_BROWSER_UNAVAILABLE' : 'BROWSER_COMMAND_FAILED', stage === 'connect');
  return envelope.data;
}
function evaluate(source) {
  let value = command(['eval', '--stdin'], source)?.result;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { fail('BROWSER_EVAL_RESULT_INVALID'); } }
  return value;
}
const draftSelector = '[role="textbox"][contenteditable="true"], [contenteditable="true"], textarea';
const probe = `(() => {
  const labels = ['Start dictation', '开始语音输入', 'Voice input', '语音输入'];
  const mic = [...document.querySelectorAll('button')].find(b => labels.includes(b.getAttribute('aria-label')));
  const audio = document.querySelector('audio[controls]');
  const draft = document.querySelector(${JSON.stringify(draftSelector)});
  return { boot: typeof window.__DSH_BOOT__ === 'object', mic: Boolean(mic), micLabel: mic?.getAttribute('aria-label'),
    idle: !document.querySelector('[data-omh-voice-activity]'),
    draft: Boolean(draft), draftEmpty: Boolean(draft && !(draft.value ?? draft.textContent ?? '').trim()),
    audio: Boolean(audio), audioReady: Boolean(audio && audio.readyState > 0),
    audioBlob: Boolean(audio && audio.src.startsWith('blob:')) };
})()`;

try {
  if ([...flags].some(f => !['--play', '--record'].includes(f))) fail('UNKNOWN_ARGUMENT');
  if (!process.env.DSH_E2E_APP_URL) fail('APP_URL_REQUIRED', true);
  const target = new URL(process.env.DSH_E2E_APP_URL);
  if (!['http:', 'https:', 'dsh-app:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) fail('APP_URL_MUST_NOT_CONTAIN_AUTH');
  if (record && (!expected || expected.length > 600 || !Number.isInteger(seconds) || seconds < 1 || seconds > 40)) fail('RECORDING_REQUIRES_EXPECT_TEXT_AND_1_TO_40_SECONDS');
  stage = 'connect';
  const current = command(['get', 'url'])?.url;
  if (typeof current !== 'string') fail('EXISTING_BROWSER_NOT_ON_TARGET_APP', true);
  const connected = new URL(current);
  if (connected.protocol !== target.protocol || connected.host !== target.host) fail('EXISTING_BROWSER_NOT_ON_TARGET_APP', true);
  stage = 'native-ui';
  const initial = evaluate(probe);
  if (!initial?.boot) fail('AUTHENTICATED_APP_CONTEXT_REQUIRED', true);
  if (!initial.mic || !initial.draft) fail('OPEN_SESSION_COMPOSER_REQUIRED', true);
  checks.push({ check: 'composer-microphone-present', passed: true });

  if (play) {
    stage = 'playback';
    if (!initial.audio || !initial.audioBlob) fail('OPEN_WAV_DOCUMENT_PREVIEW_REQUIRED', true);
    command(['wait', '--fn', 'Boolean(document.querySelector("audio[controls]")?.readyState > 0)']);
    const playback = evaluate(`(async () => {
      const audio = document.querySelector('audio[controls]');
      if (!audio || audio.error) return { played: false };
      try {
        await audio.play();
        await new Promise(resolve => setTimeout(resolve, 250));
        return { played: !audio.error && audio.currentTime > 0 };
      } catch { return { played: false }; }
      finally { audio.pause(); }
    })()`);
    if (!playback?.played) fail('AUDIO_PLAYBACK_OR_BROWSER_GESTURE_FAILED');
    checks.push({ check: 'actual-document-preview-decoding-playback', passed: true });
  }

  if (record) {
    stage = 'dictation';
    if (!initial.idle || !initial.draftEmpty) fail('EMPTY_IDLE_DRAFT_REQUIRED', true);
    if (!['Start dictation', '开始语音输入'].includes(initial.micLabel)) fail('SPEECH_PROVIDER_NOT_READY', true);
    command(['find', 'role', 'button', 'click', '--name', initial.micLabel]);
    recordingStarted = true;
    command(['wait', '--fn', 'Boolean(document.querySelector("[data-omh-voice-activity=recording]"))']);
    command(['wait', String(seconds * 1000)]);
    const stopped = evaluate(`(() => {
      const root = document.querySelector('[data-omh-voice-activity=recording]');
      const stop = root && [...root.querySelectorAll('button')].find(b => ['Stop','停止'].includes(b.getAttribute('aria-label')));
      if (!stop) return { stopped: false }; stop.click(); return { stopped: true };
    })()`);
    if (!stopped?.stopped) fail('RECORDING_STOP_NOT_AVAILABLE');
    command(['wait', '--fn', `!document.querySelector('[data-omh-voice-activity=requesting], [data-omh-voice-activity=recording], [data-omh-voice-activity=transcribing]')`]);
    const result = evaluate(`(() => {
      const editor = document.querySelector(${JSON.stringify(draftSelector)});
      const text = (editor?.value ?? editor?.textContent ?? '').trim().toLocaleLowerCase();
      const expected = ${JSON.stringify(expected)}.toLocaleLowerCase();
      return { insertedOnce: text.includes(expected) && text.indexOf(expected) === text.lastIndexOf(expected),
        idle: !document.querySelector('[data-omh-voice-activity]') };
    })()`);
    if (!result?.insertedOnce || !result.idle) fail('TRANSCRIPT_NOT_INSERTED_ONCE_IN_DRAFT');
    recordingStarted = false;
    checks.push({ check: 'real-microphone-cloud-transcription-to-draft', passed: true });
  }
  console.log(JSON.stringify({ status: 'passed', checks, scope: record ? 'explicit-dictation' : play ? 'ui-and-local-playback' : 'ui-presence-only',
    unverified: [...(record ? [] : ['real-microphone-cloud-transcription']), ...(play ? [] : ['audio-playback']), 'physical-speaker-audibility'] }, null, 2));
} catch (error) {
  if (recordingStarted) {
    try { evaluate(`(() => {
      const root = document.querySelector('[data-omh-voice-activity]');
      const cancel = root && [...root.querySelectorAll('button')].find(b => ['Cancel','取消'].includes(b.getAttribute('aria-label')));
      cancel?.click(); return { cancelled: Boolean(cancel) };
    })()`); } catch { /* No success claim when browser cancellation cannot be confirmed. */ }
  }
  console.log(JSON.stringify({ status: error.blocked ? 'blocked' : 'failed', stage, code: error.code ?? 'ACCEPTANCE_FAILED', checks }, null, 2));
  process.exitCode = error.blocked ? 2 : 1;
}
// The connected browser belongs to the user: do not close it, its tabs or its
// profile, and never navigate it to a replacement server to make tests pass.
