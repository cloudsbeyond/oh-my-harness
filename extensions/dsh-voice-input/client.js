/** Browser half of the optional native voice input bundle.
 * Hand-authored lazy factory: host React/primitives come from the module table,
 * the generated speech Remote contribution is a declared external request.
 * Recording, resampling to canonical 16 kHz WAV, draft insertion and settings
 * ownership mirror the shipped experimental voice input, minus local-model
 * preparation (this provider is cloud-only). */
window.__ModuleLoader__.load({
  id: 'oh-my-harness-voice-input',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } = React;
    const { Button, IconMicrophoneOutlineRegular, IconStopFillRegular, IconCloseOutlineRegular, StateDot, Tooltip } = require('@deepseek-ai/dsh-client-ui-primitives');
    const speechRemote = require('@deepseek-ai/dsh-experimental-api-speech-to-text/remote').default;
    const { RemoteStreamCarrierError } = require('@deepseek-ai/dsh-api-gateway/client');

    const NS = 'omh-voice';
    const en = {
      dictate: 'Dictate', start: 'Start dictation', stop: 'Stop', cancel: 'Cancel', discard: 'Discard',
      requesting: 'Requesting microphone…', recording: 'Recording…', transcribing: 'Transcribing…',
      transcribingShort: 'Transcribing…', empty: 'Nothing was heard.', failed: 'Transcription failed: {{message}}',
      tooLarge: 'The recording is too large.', conflict: 'The draft changed; keep the text to insert it manually.',
      insert: 'Insert', retryRecording: 'Record again', setupPrompt: 'Voice input',
      settingsTitle: 'Native voice input', settingsDescription: 'Cloud transcription through the oh-my-harness capability provider. Recordings are sent to the configured provider.',
      openSettings: 'Open capability settings',
    };
    const zh = {
      dictate: '语音输入', start: '开始语音输入', stop: '停止', cancel: '取消', discard: '放弃',
      requesting: '正在请求麦克风…', recording: '正在录音…', transcribing: '正在转写…',
      transcribingShort: '正在转写…', empty: '没有听到内容。', failed: '转写失败：{{message}}',
      tooLarge: '录音过大。', conflict: '草稿已变化；请手动插入保留的文本。',
      insert: '插入', retryRecording: '重新录音', setupPrompt: '语音输入',
      settingsTitle: '原生语音输入', settingsDescription: '通过 oh-my-harness 能力供应方进行云端转写。录音会上传到所配置的供应方。',
      openSettings: '打开能力设置',
    };

    class RecordingError extends Error {
      constructor(kind) { super(kind); this.name = 'RecordingError'; this.kind = kind; }
    }

    function encodeWave(samples) {
      const bytes = new Uint8Array(44 + samples.length * 2);
      const view = new DataView(bytes.buffer);
      const text = (at, value) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i); };
      text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
      view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data');
      view.setUint32(40, samples.length * 2, true);
      for (let i = 0; i < samples.length; i++) {
        const value = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
      }
      return bytes;
    }

    function audioBase64(bytes) {
      let text = '';
      for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return btoa(text);
    }

    class Recording {
      constructor(onDispose) {
        this.onDispose = onDispose; this.chunks = []; this.lifetime = new AbortController(); this.disposal = undefined;
      }
      async start(onError) {
        if (typeof MediaRecorder === 'undefined') throw new RecordingError('unavailable');
        const devices = navigator.mediaDevices;
        if (!devices) throw new RecordingError('unavailable');
        let stream;
        try {
          stream = await devices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
        } catch (error) {
          if (error instanceof DOMException) {
            if (error.name === 'NotAllowedError') throw new RecordingError('permission');
            if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') throw new RecordingError('deviceMissing');
          }
          throw error;
        }
        if (this.lifetime.signal.aborted) { stream.getTracks().forEach((track) => { track.stop(); }); throw new RecordingError('cancelled'); }
        this.stream = stream;
        try {
          this.context = new AudioContext();
          for (const track of stream.getTracks()) track.addEventListener('ended', () => { this.interrupted(onError); }, { signal: this.lifetime.signal });
          this.recorder = new MediaRecorder(stream);
          this.recorder.ondataavailable = (event) => { if (!this.lifetime.signal.aborted && event.data.size > 0) this.chunks.push(event.data); };
          this.recorder.onerror = () => { this.interrupted(onError); };
          this.recorder.start();
        } catch (error) { await this.dispose(); throw error; }
      }
      interrupted(onError) {
        if (this.lifetime.signal.aborted) return;
        void this.dispose().catch(() => undefined);
        try { onError?.(new RecordingError('interrupted')); } catch (error) { console.error('Speech recording error handler failed', error); }
      }
      async stop(maxDurationSeconds) {
        const recorder = this.recorder, context = this.context;
        if (!recorder || !context || recorder.state !== 'recording') { await this.dispose(); throw new RecordingError('empty'); }
        try {
          await new Promise((resolve, reject) => {
            recorder.onstop = () => { resolve(); };
            recorder.onerror = () => { reject(new RecordingError('empty')); };
            recorder.stop();
          });
          this.stream?.getTracks().forEach((track) => { track.stop(); });
          this.lifetime.signal.throwIfAborted();
          const blob = new Blob(this.chunks, { type: recorder.mimeType });
          if (blob.size === 0) throw new RecordingError('empty');
          const decoded = await context.decodeAudioData(await blob.arrayBuffer());
          this.lifetime.signal.throwIfAborted();
          const offline = new OfflineAudioContext(1, Math.max(1, Math.floor(Math.min(decoded.duration, maxDurationSeconds) * 16000)), 16000);
          const source = offline.createBufferSource();
          source.buffer = decoded; source.connect(offline.destination); source.start();
          const resampled = await offline.startRendering();
          this.lifetime.signal.throwIfAborted();
          return encodeWave(resampled.getChannelData(0));
        } finally { await this.dispose(); }
      }
      dispose() {
        if (!this.disposal) {
          const closing = Promise.withResolvers();
          this.disposal = closing.promise;
          void this.release().then(closing.resolve, closing.reject);
        }
        return this.disposal;
      }
      async release() {
        this.lifetime.abort(new RecordingError('cancelled'));
        if (this.recorder?.state === 'recording') this.recorder.stop();
        this.stream?.getTracks().forEach((track) => { track.stop(); });
        this.stream = undefined;
        const context = this.context;
        this.context = undefined; this.chunks = [];
        try { if (context && context.state !== 'closed') await context.close(); }
        finally { this.onDispose?.(); }
      }
    }

    const failureText = (failure, t) => failure instanceof RecordingError
      ? t(failure.kind === 'permission' ? 'failed' : 'failed', { message: failure.kind }) : t('failed', { message: failure?.message ?? String(failure) });

    function VoiceInput({ sessionId, inputActions, locked, onActiveChange, createRecording, transcribe, openSettings, readiness, t }) {
      const { catalog, connected } = useSyncExternalStore(readiness.subscribe, readiness.getSnapshot);
      const [phase, setPhase] = useState('idle');
      const [message, setMessage] = useState('');
      const [pending, setPending] = useState('');
      const current = useRef(undefined); const generation = useRef(0);
      const provider = catalog?.providers.find((item) => item.id === catalog.selection.providerId);
      // This add-on controls only its own adapter, not another recognizer's preparation.
      const usable = connected && provider?.id === 'oh-my-harness' &&
        provider.languages.includes(catalog.selection.language) && ['ready', 'standby', 'waking'].includes(provider.preparation.phase) && !locked;
      const expanded = phase !== 'idle';
      useLayoutEffect(() => { onActiveChange?.(expanded); return () => { onActiveChange?.(false); }; }, [expanded, onActiveChange]);
      const cancel = () => {
        generation.current++;
        const active = current.current; current.current = undefined;
        if (active) { clearTimeout(active.timer); active.abort.abort(); void active.capture.dispose().catch(() => undefined); }
        setPending(''); setMessage(''); setPhase('idle');
      };
      useEffect(() => {
        const blur = () => { if (current.current?.phase === 'recording') cancel(); };
        const visibility = () => { if (document.hidden && current.current && current.current.phase !== 'transcribing') cancel(); };
        const escape = (event) => { if (event.key === 'Escape' && current.current) { event.preventDefault(); cancel(); } };
        window.addEventListener('blur', blur); document.addEventListener('visibilitychange', visibility); document.addEventListener('keydown', escape);
        return () => {
          window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility); document.removeEventListener('keydown', escape);
          cancel();
        };
      }, [sessionId]);
      const feedback = (text) => { setMessage(text); setPhase('feedback'); };
      const finish = async () => {
        const active = current.current;
        if (!active || active.phase !== 'recording') return;
        active.phase = 'transcribing';
        const run = generation.current;
        clearTimeout(active.timer); setPhase('transcribing');
        try {
          const audio = await active.capture.stop(active.maxDurationSeconds);
          if (run !== generation.current) return;
          if (audio.byteLength > active.maxAudioBytes) { feedback(t('tooLarge')); return; }
          const result = await transcribe.transcribe({ audioBase64: audioBase64(audio), ...active.selection }, active.abort.signal);
          if (run !== generation.current) return;
          if (!result.ok) { feedback(t('failed', { message: result.error.message })); return; }
          if (result.value.text === '') { feedback(t('empty')); return; }
          if (!inputActions.insertText(result.value.text, active.span)) { setPending(result.value.text); feedback(t('conflict')); return; }
          setPhase('idle');
        } catch (failure) {
          await active.capture.dispose().catch(() => undefined);
          if (run === generation.current) feedback(failureText(failure, t));
        } finally { if (run === generation.current) current.current = undefined; }
      };
      const start = async () => {
        if (!usable || current.current) return;
        const run = ++generation.current;
        const active = { capture: createRecording(), abort: new AbortController(), span: inputActions.captureInsertion(),
          selection: catalog.selection, maxDurationSeconds: catalog.maxDurationSeconds, maxAudioBytes: catalog.maxAudioBytes, phase: 'requesting' };
        current.current = active;
        setMessage(''); setPending(''); setPhase('requesting');
        try {
          await active.capture.start((failure) => {
            if (run !== generation.current || current.current !== active || active.phase === 'transcribing') return;
            current.current = undefined; clearTimeout(active.timer); active.abort.abort();
            feedback(failureText(failure, t));
          });
          if (run !== generation.current || current.current !== active) return;
          active.phase = 'recording'; setPhase('recording');
          active.timer = setTimeout(() => { void finish(); }, active.maxDurationSeconds * 1000);
        } catch (failure) {
          await active.capture.dispose().catch(() => undefined);
          if (run === generation.current) { current.current = undefined; feedback(failureText(failure, t)); }
        }
      };
      if (!expanded) {
        return h(Tooltip, { label: t('dictate'), side: 'top', portal: true },
          h(Button, { size: 'sm', disabled: locked, 'aria-label': t(usable ? 'start' : 'setupPrompt'),
            onMouseDown: (event) => { event.preventDefault(); },
            onClick: () => { if (usable) void start(); else openSettings(); } }, h(IconMicrophoneOutlineRegular, { size: 18 })));
      }
      return h('div', { 'data-omh-voice-activity': phase, style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h(Button, { type: 'button', size: 'sm', 'aria-label': t(pending ? 'discard' : 'cancel'), onClick: cancel }, h(IconCloseOutlineRegular, { size: 14 })),
        phase === 'recording' ? h('span', { role: 'status' }, t('recording'))
          : h('span', { role: 'status', title: pending || message },
              (phase === 'requesting' || phase === 'transcribing') && h(StateDot, { state: 'ongoing' }),
              phase === 'feedback' ? message : t(phase === 'requesting' ? 'requesting' : 'transcribingShort')),
        phase === 'recording' && h(Button, { type: 'button', size: 'sm', 'aria-label': t('stop'), onClick: () => { void finish(); } }, h(IconStopFillRegular, { size: 14 })),
        phase === 'feedback' && (pending
          ? h(Button, { size: 'sm', type: 'button', onClick: () => { if (inputActions.insertText(pending, inputActions.captureInsertion())) { setPending(''); setPhase('idle'); } } }, t('insert'))
          : h(Button, { size: 'sm', type: 'button', 'aria-label': t('retryRecording'), disabled: !usable, onClick: () => { void start(); } }, h(IconMicrophoneOutlineRegular, { size: 18 }))));
    }

    function VoiceSettings({ openSettings, t }) {
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('strong', null, t('settingsTitle')),
        h('span', null, t('settingsDescription')),
        h(Button, { size: 'sm', type: 'button', onClick: openSettings }, t('openSettings')));
    }

    // One reconnecting observation per UI scope, shared by all composer occurrences.
    function observeReadiness(ctx) {
      let snapshot = { catalog: null, connected: false };
      let disposed = false;
      const listeners = new Set();
      const publish = (value) => { snapshot = value; for (const listener of listeners) listener(); };
      const fail = () => { if (!disposed) publish({ ...snapshot, connected: false }); };
      const stream = ctx.remote.$stream({
        name: 'oh-my-harness speech readiness', open: (signal) => ctx.remote.speech.follow(signal),
        ended: () => new RemoteStreamCarrierError('Speech readiness stream ended'), carrierFailed: fail,
      });
      const observing = (async () => {
        try {
          for await (const item of stream) {
            if (disposed) break;
            publish({ catalog: item.value, connected: true });
            item.accept();
          }
        } catch { fail(); }
      })();
      ctx.effect(() => async () => { disposed = true; await stream.dispose(); await observing; listeners.clear(); });
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      };
    }

    function registerUi(ctx, recordings) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }));
      ctx.effect(() => async () => { await Promise.all([...recordings].map((recording) => recording.dispose().catch(() => undefined))); });
      const actions = {
        readiness: observeReadiness(ctx),
        openSettings: () => { ctx.get('pluginNavigation')?.openBundle('oh-my-harness'); },
        createRecording: () => {
          const recording = new Recording(() => { recordings.delete(recording); });
          recordings.add(recording);
          return recording;
        },
        transcribe: {
          transcribe: (request, signal) => ctx.remote.speech.transcribe(request, signal),
          catalog: () => ctx.remote.speech.catalog(),
          configure: (patch) => ctx.remote.speech.configure(patch),
        },
      };
      ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({
        name: 'conversation.input.activity', locale: NS, inject: () => actions,
      }, VoiceInput));
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config', key: 'oh-my-harness-voice-input', locale: NS, inject: () => actions,
      }, VoiceSettings));
      ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({
        name: 'plugins.bundle.activation', key: 'oh-my-harness-voice-input', locale: NS, inject: () => actions,
      }, VoiceSettings));
    }

    return {
      inject: ['remote', 'slots', 'locale'],
      apply(ctx) {
        // Cordis owns both async startup and its eventual disposer, including an
        // unload during $mount. A Fiber is awaitable, but is not a Promise.
        return ctx.effect(async () => {
          const recordings = new Set();
          const disposeRemote = ctx.get('remote.speech') === undefined
            ? await ctx.remote.$mount(speechRemote) : async () => {};
          let uiScope;
          try {
            uiScope = ctx.inject(['remote.speech', 'slots', 'locale'], (scope) => { registerUi(scope, recordings); });
            await uiScope;
          } catch (error) {
            try { await uiScope?.dispose(); } finally { await disposeRemote(); }
            throw error;
          }
          return async () => {
            try { await uiScope.dispose(); } finally { await disposeRemote(); }
          };
        });
      },
    };
  },
});
