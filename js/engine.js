/* ============================================================
   engine.js — two speech engines behind one interface.
     • NativeEngine  — the OS voices, instant, always available
     • KokoroEngine  — neural TTS (English + 中文), downloaded once
   The app asks an engine for one sentence at a time, so it can
   prefetch ahead and keep playback smooth.
   ============================================================ */

export const KOKORO_MODEL  = 'onnx-community/Kokoro-82M-v1.1-zh-ONNX';
export const KOKORO_VOICES = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.1-zh-ONNX/resolve/main/voices';
const KOKORO_CDN           = 'https://cdn.jsdelivr.net/npm/@uzen/kokoro-js@1.2.4/+esm';

/* ---------------------------------------------------------- */
/* helpers                                                     */
/* ---------------------------------------------------------- */

let sharedCtx = null;
export function audioCtx() {
  if (!sharedCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    sharedCtx = new AC({ latencyHint: 'interactive' });
  }
  return sharedCtx;
}
/**
 * Nudge the AudioContext awake. Deliberately NOT awaited: under the browser
 * autoplay policy resume() does not settle until a user gesture arrives, and
 * awaiting it would freeze playback before the first word. Native speech does
 * not need the context at all, and a neural buffer starts as soon as it runs.
 */
export function unlockAudio() {
  const ctx = audioCtx();
  if (ctx.state === 'suspended') {
    Promise.race([ctx.resume(), sleep(1200)]).catch(() => {});
  }
  return ctx;
}

/** Race a promise against an abort signal. */
function withSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v); },
      e => { signal.removeEventListener('abort', onAbort); reject(e); }
    );
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------------------------------------------------- */
/* Native engine (Web Speech API)                              */
/* ---------------------------------------------------------- */

const FEMALE_HINTS = /\b(zira|huihui|yaoyao|samantha|victoria|karen|susan|allison|ava|serena|moira|tessa|fiona|amelie|anna|ellen|marie|female|woman|女)\b/i;
const MALE_HINTS   = /\b(david|mark|kangkang|alex|daniel|fred|tom|lee|oliver|thomas|jorge|diego|male|man|男)\b/i;

function prettyNativeName(raw) {
  let n = raw
    .replace(/^Microsoft\s+/i, '')
    .replace(/\s*-\s*(Chinese|English|Japanese|Korean|French|German|Spanish)[^)]*$/i, '')
    .replace(/\s*\((?:United States|United Kingdom|PRC|Simplified|Traditional)[^)]*\)$/i, '')
    .trim();
  return n || raw;
}

function nativeGender(name) {
  if (FEMALE_HINTS.test(name)) return 'female';
  if (MALE_HINTS.test(name)) return 'male';
  return 'unknown';
}

export class NativeEngine {
  constructor() {
    this.id = 'native';
    this.label = 'System voices';
    this.voices = [];
    this.current = null;
    this._paused = false;
    this.available = typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  async init() {
    if (!this.available) throw new Error('This browser has no speech-synthesis support.');
    this.voices = await this._loadVoices();
    return this;
  }

  _loadVoices() {
    return new Promise(resolve => {
      const grab = () => {
        const raw = speechSynthesis.getVoices() || [];
        if (raw.length) {
          const seen = new Set();
          const list = [];
          for (const v of raw) {
            const key = v.name + '|' + v.lang;
            if (seen.has(key)) continue;
            seen.add(key);
            const lang = (v.lang || '').replace('_', '-');
            const base = lang.split('-')[0].toLowerCase();
            list.push({
              id: v.name,
              name: prettyNativeName(v.name),
              raw: v.name,
              lang,
              base,
              gender: nativeGender(v.name),
              local: !!v.localService,
              engine: 'native',
              _voice: v,
            });
          }
          resolve(list);
          return true;
        }
        return false;
      };
      if (grab()) return;
      let tries = 0;
      const tick = () => {
        if (grab()) return;
        if (++tries > 40) { resolve([]); return; }
        setTimeout(tick, 60);
      };
      speechSynthesis.addEventListener('voiceschanged', () => { grab(); }, { once: true });
      setTimeout(tick, 60);
    });
  }

  /** Speak one sentence; resolves when it finishes. */
  play(text, { voiceId, rate = 1, pitch = 1, volume = 1 } = {}, hooks = {}) {
    if (!this.available) return Promise.reject(new Error('no speech synthesis'));
    const voice = this.voices.find(v => v.id === voiceId) || this.voices.find(v => v._voice.name === voiceId);
    return new Promise((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(text);
      if (voice) { u.voice = voice._voice; u.lang = voice.lang; }
      // Web Speech rate is perceptually non-linear; damp it so 2× is not a chipmunk.
      u.rate = Math.max(0.1, Math.min(3, 1 + (rate - 1) * 0.72));
      u.pitch = pitch;
      u.volume = volume;

      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        this.current = null;
        clearInterval(keep);
        err ? reject(err) : resolve();
      };

      u.onstart = () => hooks.onStart && hooks.onStart();
      u.onend = () => finish();
      u.onerror = e => {
        const t = e && e.error;
        if (t === 'interrupted' || t === 'canceled') finish();
        else finish(new Error('Speech failed: ' + (t || 'unknown')));
      };
      if (u.onboundary !== undefined) {
        u.onboundary = ev => {
          if (hooks.onBoundary) hooks.onBoundary(ev.charIndex || 0, ev.charLength || 0, ev.name);
        };
      }

      this.current = { utterance: u, finish, hooks };
      try { speechSynthesis.speak(u); }
      catch (e) { finish(e); return; }

      // Chrome drops long utterances and can stall; nudge it with resume().
      const keep = setInterval(() => {
        if (settled) { clearInterval(keep); return; }
        if (speechSynthesis.paused) return;
        if (speechSynthesis.speaking) { try { speechSynthesis.resume(); } catch {} }
      }, 5000);
    });
  }

  pause() {
    if (!this.available) return;
    try { speechSynthesis.pause(); } catch {}
  }
  resume() {
    if (!this.available) return;
    try { speechSynthesis.resume(); } catch {}
  }
  stop() {
    if (!this.available) return;
    try { speechSynthesis.cancel(); } catch {}
    if (this.current) { const c = this.current; this.current = null; c.finish(); }
  }
  prefetch() { /* native speech needs no prefetch */ }
  flush() {}
  dispose() { this.stop(); }
}

/* ---------------------------------------------------------- */
/* Kokoro engine (neural, on-device)                           */
/* ---------------------------------------------------------- */

const ZH_GIVEN = ['一号','二号','三号','四号','五号','六号','七号','八号','九号','十号'];

export class KokoroEngine {
  constructor() {
    this.id = 'kokoro';
    this.label = 'Neural voices';
    this.ready = false;
    this.loading = null;
    this.tts = null;
    this.voices = [];
    this.device = null;
    this.dtype = null;
    this._cache = new Map();   // sentence text+voice+speed -> {audio, rate}
    this._inflight = new Map();
    this._node = null;
    this._gain = null;
    this._startedAt = 0;
    this._offset = 0;
    this._duration = 0;
    this._playing = false;
    this._paused = false;
  }

  get status() {
    if (this.ready) return 'ready';
    if (this.loading) return 'loading';
    return 'idle';
  }

  /** Download + initialize the model. Safe to call repeatedly. */
  async init(onProgress) {
    if (this.ready) return this;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const mod = await import(/* @vite-ignore */ KOKORO_CDN);
      const { KokoroTTS, env } = mod;
      env.allowLocalModels = false;

      const wantGpu = typeof navigator !== 'undefined' && !!navigator.gpu;
      const attempts = wantGpu
        ? [['webgpu', 'fp32'], ['webgpu', 'q8'], ['wasm', 'q8']]
        : [['wasm', 'q8']];

      let lastErr = null;
      for (const [device, dtype] of attempts) {
        try {
          if (onProgress) onProgress({ phase: 'model', device, dtype, pct: 0, note: 'Starting download…' });
          const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, {
            dtype, device, voicePath: KOKORO_VOICES,
            progress_callback: p => {
              if (!onProgress || !p) return;
              const pct = typeof p.progress === 'number' ? p.progress : 0;
              onProgress({
                phase: p.status === 'ready' ? 'done' : 'model',
                device, dtype, pct,
                note: p.status === 'progress'
                  ? (p.file || 'model')
                  : (p.status === 'ready' ? 'Ready' : p.status || ''),
              });
            },
          });
          this.tts = tts;
          this.device = device;
          this.dtype = dtype;
          break;
        } catch (e) {
          lastErr = e;
          console.warn('[kokoro] init failed on', device, dtype, e);
        }
      }
      if (!this.tts) throw lastErr || new Error('Could not start the neural voice engine.');

      this.voices = this._readVoices(this.tts);
      this.ready = true;
      // How fast is this backend? WASM spends ~3s of compute per second of
      // audio (too slow to stream); WebGPU stays well under realtime.
      // `this.device` was set inside the loop above — the loop variable is
      // block-scoped and not visible here.
      this.fast = this.device === 'webgpu';
      this.rtf = this.fast ? 0.4 : 3.1;
      return this;
    })();

    try { await this.loading; }
    finally { this.loading = null; }
    return this;
  }

  _readVoices(tts) {
    const meta = (tts.voices && typeof tts.voices === 'object') ? tts.voices : {};
    const out = [];
    for (const [id, m] of Object.entries(meta)) {
      const base = id.slice(0, 2);
      const lang = id[0] === 'z' ? 'zh' : 'en';
      const gender = id[1] === 'f' ? 'female' : 'male';
      let name;
      if (/^z[fm]_\d+$/.test(id)) {
        const n = parseInt(id.slice(3), 10);
        name = (lang === 'zh' ? '中文' : 'English') + (gender === 'female' ? '女声' : '男声') + ' ' +
               (n <= 10 ? ZH_GIVEN[n - 1] : String(n).padStart(3, '0'));
      } else {
        const raw = (m && m.name) || id.slice(3);
        name = raw.charAt(0).toUpperCase() + raw.slice(1);
      }
      out.push({
        id, name, lang, base: lang, gender, engine: 'kokoro',
        accent: base[0] === 'b' ? 'British' : '',
        quality: (m && m.overallGrade) || '',
      });
    }
    // Sort: Chinese first (this app's focus), then English; female before male; by number.
    const rank = v => (v.lang === 'zh' ? 0 : 1) * 1000 + (v.gender === 'female' ? 0 : 100) +
                     (parseInt(v.id.slice(3), 10) || 0);
    return out.sort((a, b) => rank(a) - rank(b));
  }

  _key(text, voiceId, speed) { return voiceId + '|' + speed + '|' + text; }

  /** Generate one sentence (cached). */
  async synthesize(text, voiceId, speed, signal) {
    const key = this._key(text, voiceId, speed);
    if (this._cache.has(key)) return this._cache.get(key);
    if (this._inflight.has(key)) return withSignal(this._inflight.get(key), signal);

    const job = (async () => {
      const t0 = performance.now();
      const res = await this.tts.generate(text, { voice: voiceId, speed });
      const raw = res.audio;
      const audio = raw instanceof Float32Array ? raw : new Float32Array(raw);
      const out = { audio, rate: res.sampling_rate || 24000, ms: performance.now() - t0 };
      this._cache.set(key, out);
      if (this._cache.size > 48) {
        // Drop the oldest entries; the queue only ever needs the next few.
        const first = this._cache.keys().next().value;
        this._cache.delete(first);
      }
      return out;
    })();

    this._inflight.set(key, job);
    try { return await withSignal(job, signal); }
    finally { this._inflight.delete(key); }
  }

  /** Warm the cache for an upcoming sentence without blocking. */
  prefetch(text, voiceId, speed, signal) {
    if (!this.ready) return;
    const key = this._key(text, voiceId, speed);
    if (this._cache.has(key) || this._inflight.has(key)) return;
    this.synthesize(text, voiceId, speed, signal).catch(() => {});
  }

  flush() {
    this._cache.clear();
  }

  /** Play one sentence through the shared AudioContext. */
  async play(text, { voiceId, speed = 1, volume = 1 } = {}, hooks = {}) {
    if (!this.ready) throw new Error('The neural engine is not loaded yet.');
    const ctx = unlockAudio();
    const { audio, rate } = await this.synthesize(text, voiceId, speed, hooks.signal);

    if (hooks.signal && hooks.signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const buf = ctx.createBuffer(1, audio.length, rate);
    buf.copyToChannel(audio, 0);

    const node = ctx.createBufferSource();
    node.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    node.connect(gain).connect(ctx.destination);

    this._node = node;
    this._gain = gain;
    this._duration = buf.duration;
    this._startedAt = ctx.currentTime;
    this._offset = 0;
    this._playing = true;
    this._paused = false;

    if (hooks.onStart) hooks.onStart();

    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        this._playing = false;
        this._paused = false;
        this._finish = null;
        if (this._node === node) this._node = null;
        err ? reject(err) : resolve();
      };
      // Kept on the instance so resume() can re-attach it to the new source.
      this._finish = finish;
      this._attachEnd(node);

      if (hooks.signal) {
        hooks.signal.addEventListener('abort', () => {
          try { node.stop(); } catch {}
          finish();
        }, { once: true });
      }
      try { node.start(0); }
      catch (e) { finish(e); }
    });
  }

  /** Wire a buffer source's end to the active completion handler. */
  _attachEnd(node) {
    node.onended = () => {
      if (this._paused) return;      // a pause stops the node on purpose
      if (this._node !== node) return;
      if (this._finish) this._finish();
    };
  }

  /** Progress within the current sentence, 0..1. */
  progress() {
    if (!this._playing || !this._duration) return 0;
    const ctx = audioCtx();
    const el = (this._paused ? this._offset : ctx.currentTime - this._startedAt);
    return Math.max(0, Math.min(1, el / this._duration));
  }

  pause() {
    if (!this._playing || this._paused) return;
    const ctx = audioCtx();
    this._offset = ctx.currentTime - this._startedAt;
    try { this._node.stop(); } catch {}
    this._paused = true;
  }

  resume() {
    if (!this._paused || !this._node) { this._paused = false; return; }
    const ctx = audioCtx();
    const node = ctx.createBufferSource();
    node.buffer = this._node.buffer;
    node.connect(this._gain);
    this._node = node;
    this._startedAt = ctx.currentTime - this._offset;
    this._paused = false;
    this._attachEnd(node);
    try { node.start(0, Math.min(this._offset, node.buffer.duration)); }
    catch { this._finish && this._finish(); }
  }

  stop() {
    if (this._node) {
      try { this._node.onended = null; this._node.stop(); } catch {}
      this._node = null;
    }
    this._playing = false;
    this._paused = false;
    this._offset = 0;
  }

  dispose() {
    this.stop();
    this._cache.clear();
    this.tts = null;
    this.ready = false;
  }
}

/* ---------------------------------------------------------- */
/* catalog helpers                                             */
/* ---------------------------------------------------------- */

export const LANG_LABEL = { zh: '中文', en: 'English' };

export function groupVoices(voices) {
  const g = { zh: { female: [], male: [], other: [] }, en: { female: [], male: [], other: [] }, other: [] };
  for (const v of voices) {
    const key = v.base || v.lang;
    const bucket = g[key] || (g[key] = { female: [], male: [], other: [] });
    (bucket[v.gender] || bucket.other).push(v);
  }
  return g;
}

/**
 * Pick the best voice for a language.
 * Voices are matched on their base language ("zh", "en") — a native voice
 * reports a full tag such as "en-US", and comparing that to "en" never matches.
 */
export function pickVoice(voices, lang, prefs) {
  const want = prefs && prefs[lang];
  if (want) {
    const hit = voices.find(v => v.id === want);
    if (hit) return hit;
  }
  const pool = voices.filter(v => (v.base || v.lang) === lang);
  return pool.find(v => v.gender === 'female') || pool[0] || null;
}
