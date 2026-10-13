/* ============================================================
   engine.js — two speech engines behind one interface.
     • NativeEngine  — the OS voices, instant, always available
     • KokoroEngine  — neural TTS (English + 中文), downloaded once
   The app asks an engine for one sentence at a time, so it can
   prefetch ahead and keep playback smooth.
   ============================================================ */

// Pinned to an immutable revision so a model update cannot change
// the voice set or phonemizer behaviour under a published site.
export const KOKORO_REV    = '6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3';
export const KOKORO_MODEL  = 'onnx-community/Kokoro-82M-v1.1-zh-ONNX';
export const KOKORO_VOICES = `https://huggingface.co/onnx-community/Kokoro-82M-v1.1-zh-ONNX/resolve/${KOKORO_REV}/voices`;
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
/* pacing — what makes synthesized speech sound human          */
/* ---------------------------------------------------------- */

/**
 * How long a speaker rests after this piece of text. Flat, gapless delivery
 * is the single biggest robotic tell; real speech breathes at every mark.
 */
export function pauseAfter(text, isParaEnd) {
  const t = (text || '').trim();
  if (isParaEnd) return 0.52;
  if (/[。！？!?…]$/.test(t)) return 0.33;
  if (/[；;：:]$/.test(t)) return 0.24;
  if (/[，,、]$/.test(t)) return 0.15;
  if (/[."'”’)\]]$/.test(t)) return 0.29;
  return 0.21;
}

/** Append silence — used to bake a breath into the buffer. */
function padSilence(audio, rate, seconds) {
  const pad = Math.max(0, Math.floor(seconds * rate));
  if (!pad) return audio;
  const out = new Float32Array(audio.length + pad);
  out.set(audio, 0);
  return out;
}

function concatAudio(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * A short ramp at each edge. A buffer that starts or stops at full amplitude
 * clicks; the click is what reads as "computer".
 */
function fadeEdges(audio, rate, fadeIn = 0.006, fadeOut = 0.010) {
  const n = audio.length;
  const fi = Math.min(Math.floor(fadeIn * rate), Math.floor(n / 3));
  const fo = Math.min(Math.floor(fadeOut * rate), Math.floor(n / 3));
  for (let i = 0; i < fi; i++) audio[i] *= i / fi;
  for (let i = 0; i < fo; i++) audio[n - 1 - i] *= i / fo;
  return audio;
}

/**
 * Roughly how long this text takes to say, in seconds.
 * CJK glyphs are far denser than Latin letters — 30 汉字 is about as long as
 * 90 characters of English — so a plain character count would give Chinese
 * sentences a breath twice as often as English ones.
 */
function spokenSeconds(text) {
  let cjk = 0, other = 0;
  for (const ch of text) {
    if (/[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(ch)) cjk++;
    else if (/\S/.test(ch)) other++;
  }
  return cjk / 4.6 + other / 13;
}

/**
 * Split a long sentence at its commas so each clause gets a breath. Applied
 * only past a threshold — short sentences already flow, and cutting them
 * would sound choppier than leaving them whole.
 */
export function clauseSplit(text, maxSeconds = 6.5) {
  const t = (text || '').trim();
  if (spokenSeconds(t) <= maxSeconds) return [t];
  const raw = [];
  let buf = '';
  for (const ch of t) {
    buf += ch;
    if ('，,、;；'.includes(ch) && buf.trim().length >= 12) { raw.push(buf.trim()); buf = ''; }
  }
  if (buf.trim()) raw.push(buf.trim());
  if (raw.length < 2) return [t];
  // Fold a runt fragment into its neighbour rather than leaving a 2-word gap.
  const out = [];
  for (const piece of raw) {
    const prev = out[out.length - 1];
    if (prev && (prev.length < 15 || piece.length < 8)) out[out.length - 1] = prev + ' ' + piece;
    else out.push(piece);
  }
  return out;
}

/* ---------------------------------------------------------- */
/* Kokoro engine — two voice packs behind one interface        */
/*                                                             */
/* English and Mandarin need different front ends: the English */
/* model phonemizes with espeak, while Mandarin needs the v1.1 */
/* model's pinyin front end. Keeping one pack per language     */
/* also gives English the 28 studio voices (af_heart, grade A) */
/* instead of the three ungraded ones bundled with the Chinese */
/* model. Each pack downloads only when a sentence needs it.   */
/* ---------------------------------------------------------- */

const PACKS = {
  zh: {
    lang: 'zh',
    label: '中文',
    cdn: 'https://cdn.jsdelivr.net/npm/@uzen/kokoro-js@1.2.4/+esm',
    model: 'onnx-community/Kokoro-82M-v1.1-zh-ONNX',
    rev: '6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3',
    voiceDir: 'voices',
    default: 'zf_001',
  },
  en: {
    lang: 'en',
    label: 'English',
    cdn: 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm',
    model: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    rev: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
    voiceDir: 'voices',
    default: 'af_heart',
  },
};

/** Grade the English voices so the UI can lead with the best ones. */
const GRADES = {
  af_heart: 'A', af_bella: 'A-', af_nicole: 'B-', af_aoede: 'C+', af_kore: 'C+',
  af_sarah: 'C+', af_alloy: 'C', af_nova: 'C', af_sky: 'C-', am_fenrir: 'C+',
  am_michael: 'C+', am_puck: 'C+', am_onyx: 'C', bf_emma: 'B-', bf_isabella: 'C',
  bm_george: 'C', bm_fable: 'C', am_echo: 'D', am_eric: 'D', am_liam: 'D',
  af_jessica: 'D', af_river: 'D', am_adam: 'F+',
};

/** English voices worth defaulting to, best first. */
export const EN_PREFERRED = ['af_heart', 'af_bella', 'bf_emma', 'am_fenrir', 'am_michael', 'am_puck'];

const ZH_GIVEN = ['一','二','三','四','五','六','七','八','九','十'];

export class KokoroEngine {
  constructor() {
    this.id = 'kokoro';
    this.label = 'Neural voices';
    this.packs = {};          // lang -> pack record
    this.voices = [];         // flattened, from every loaded pack
    this._cache = new Map();
    this._inflight = new Map();
    this._node = null;
    this._gain = null;
    this._startedAt = 0;
    this._offset = 0;
    this._duration = 0;
    this._playing = false;
    this._paused = false;
    this._finish = null;
    this._loading = null;
  }

  get ready() { return Object.values(this.packs).some(p => p.ready); }
  get loading() { return this._loading; }
  get status() { return this.ready ? 'ready' : (this._loading ? 'loading' : 'idle'); }

  /** Best loaded pack's backend, for the engine note. */
  get device() {
    const p = Object.values(this.packs).find(x => x.ready);
    return p ? p.device : null;
  }
  get fast() {
    const p = Object.values(this.packs).find(x => x.ready);
    return p ? p.fast : true;
  }
  /** True once every pack the UI knows about has arrived. */
  get complete() { return ['zh', 'en'].every(l => this.packs[l] && this.packs[l].ready); }

  /**
   * Load the pack for `lang`. Safe to call repeatedly; concurrent calls share
   * one in-flight promise.
   */
  async init(lang = 'zh', onProgress) {
    const want = PACKS[lang] ? lang : 'zh';
    const existing = this.packs[want];
    if (existing && existing.ready) return existing;
    if (existing && existing.loading) return existing.loading;

    const rec = this.packs[want] = existing || { ...PACKS[want], ready: false, voices: [], device: null, fast: true, tts: null };
    rec.voiceDir = rec.voiceDir || PACKS[want].voiceDir;
    rec.loading = (async () => {
      const mod = await import(/* @vite-ignore */ rec.cdn);
      const { KokoroTTS, env } = mod;
      env.allowLocalModels = false;

      // NOTE: this is the directory the library appends `/<voice>.bin` to.
      // It lives on `voiceDir`, not `voices` — `voices` holds the loaded list.
      const voicePath = `https://huggingface.co/${rec.model}/resolve/${rec.rev}/${rec.voiceDir}`;
      const wantGpu = typeof navigator !== 'undefined' && !!navigator.gpu;
      const attempts = wantGpu
        ? [['webgpu', 'fp32'], ['webgpu', 'q8'], ['wasm', 'q8']]
        : [['wasm', 'q8']];

      let lastErr = null;
      for (const [device, dtype] of attempts) {
        try {
          if (onProgress) onProgress({ lang: want, phase: 'model', device, dtype, pct: 0, note: 'Starting download…' });
          const tts = await KokoroTTS.from_pretrained(rec.model, {
            dtype, device, revision: rec.rev, voicePath,
            progress_callback: x => {
              if (!onProgress || !x) return;
              const pct = typeof x.progress === 'number' ? x.progress : 0;
              onProgress({
                lang: want,
                phase: x.status === 'ready' ? 'done' : 'model',
                device, dtype, pct,
                note: x.status === 'progress' ? (x.file || 'model')
                    : x.status === 'ready' ? 'Ready' : (x.status || ''),
              });
            },
          });
          rec.tts = tts;
          rec.device = device;
          rec.fast = device === 'webgpu';
          rec.rtf = rec.fast ? 0.4 : 3.1;
          break;
        } catch (e) {
          lastErr = e;
          console.warn('[kokoro] init failed on', want, device, dtype, e);
        }
      }
      if (!rec.tts) throw lastErr || new Error('Could not start the ' + rec.label + ' voices.');

      rec.voices = this._readVoices(rec.tts, want);
      rec.ready = true;
      this._reindex();
      return rec;
    })();

    try { await rec.loading; }
    finally { rec.loading = null; }
    return rec;
  }

  /** Load whichever pack owns a voice id, on demand. */
  async ensureVoice(voiceId, onProgress) {
    const lang = String(voiceId).split(':')[0];
    const rec = this.packs[lang];
    if (rec && rec.ready) return rec;
    return this.init(lang, onProgress);
  }

  _reindex() {
    this.voices = [];
    for (const lang of ['zh', 'en']) {
      const rec = this.packs[lang];
      if (rec && rec.ready) this.voices.push(...rec.voices);
    }
    // Chinese first, then English; inside each, female then male, best grade first.
    const rank = v =>
      (v.lang === 'zh' ? 0 : 1) * 1e6 +
      (v.gender === 'female' ? 0 : 1) * 1e5 +
      (10 - (v.gradeNum ?? 5)) * 1e3 +
      (parseInt(String(v.raw).slice(3), 10) || 0);
    this.voices.sort((a, b) => rank(a) - rank(b));
  }

  _readVoices(tts, lang) {
    const meta = (tts.voices && typeof tts.voices === 'object') ? tts.voices : {};
    const out = [];
    for (const [raw, m] of Object.entries(meta)) {
      const base = raw.slice(0, 2);
      // Only accept voices that belong to this pack's language.
      const vLang = raw[0] === 'z' ? 'zh' : 'en';
      if (vLang !== lang) continue;

      const gender = raw[1] === 'f' ? 'female' : 'male';
      let name;
      if (/^z[fm]_\d+$/.test(raw)) {
        const n = parseInt(raw.slice(3), 10);
        name = '中文' + (gender === 'female' ? '女声' : '男声') + ' ' +
               (n <= 10 ? ZH_GIVEN[n - 1] : String(n).padStart(3, '0'));
      } else {
        const r = (m && m.name) || raw.slice(3);
        name = r.charAt(0).toUpperCase() + r.slice(1);
      }
      const grade = GRADES[raw];
      out.push({
        id: lang + ':' + raw,
        raw,
        name,
        lang,
        base: lang,
        gender,
        engine: 'kokoro',
        pack: lang,
        grade: grade || '',
        gradeNum: grade ? ({ A: 9, 'A-': 8, 'B+': 7, 'B': 6, 'B-': 5, 'C+': 4, 'C': 3, 'C-': 2, 'D': 1, 'F+': 0 }[grade] ?? 5) : 5,
        accent: base[0] === 'b' ? 'British' : '',
      });
    }
    return out;
  }

  _packFor(voiceId) {
    const lang = String(voiceId).split(':')[0];
    const rec = this.packs[lang];
    if (!rec || !rec.ready) throw new Error('The ' + lang + ' voices are not loaded yet.');
    return rec;
  }

  _key(text, voiceId, speed) { return voiceId + '|' + speed + '|' + text; }

  /** Generate one piece of text with the pack that owns the voice. */
  async synthesize(text, voiceId, speed, signal) {
    const key = this._key(text, voiceId, speed);
    if (this._cache.has(key)) return this._cache.get(key);
    if (this._inflight.has(key)) return withSignal(this._inflight.get(key), signal);

    const rec = this._packFor(voiceId);
    const raw = String(voiceId).split(':')[1] || voiceId;

    const job = (async () => {
      const t0 = performance.now();
      const res = await rec.tts.generate(text, { voice: raw, speed });
      const a = res.audio;
      const audio = a instanceof Float32Array ? a : new Float32Array(a);
      const out = { audio, rate: res.sampling_rate || 24000, ms: performance.now() - t0 };
      this._cache.set(key, out);
      if (this._cache.size > 64) this._cache.delete(this._cache.keys().next().value);
      return out;
    })();

    this._inflight.set(key, job);
    try { return await withSignal(job, signal); }
    finally { this._inflight.delete(key); }
  }

  prefetch(text, voiceId, speed, signal) {
    const rec = this.packs[String(voiceId).split(':')[0]];
    if (!rec || !rec.ready) return;
    const key = this._key(text, voiceId, speed);
    if (this._cache.has(key) || this._inflight.has(key)) return;
    this.synthesize(text, voiceId, speed, signal).catch(() => {});
  }

  flush() { this._cache.clear(); }

  async play(text, { voiceId, speed = 1, volume = 1, pauseAfter: rest = 0.2 } = {}, hooks = {}) {
    const ctx = unlockAudio();

    // Render clause by clause so a long sentence breathes at its commas, then
    // fade the edges and rest at the end. It stays one buffer, so the
    // highlight still tracks a single sentence.
    const clauses = clauseSplit(text);
    let audio = null, rate = 24000;
    for (let i = 0; i < clauses.length; i++) {
      const r = await this.synthesize(clauses[i], voiceId, speed, hooks.signal);
      rate = r.rate || rate;
      let piece = r.audio;
      if (i < clauses.length - 1) piece = padSilence(piece, rate, 0.13);
      audio = audio ? concatAudio(audio, piece) : piece;
    }
    if (hooks.signal && hooks.signal.aborted) throw new DOMException('Aborted', 'AbortError');

    audio = fadeEdges(Float32Array.from(audio), rate);
    if (rest > 0) audio = padSilence(audio, rate, rest);

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
      const finish = err => {
        if (done) return;
        done = true;
        this._playing = false;
        this._paused = false;
        this._finish = null;
        if (this._node === node) this._node = null;
        err ? reject(err) : resolve();
      };
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

  _attachEnd(node) {
    node.onended = () => {
      if (this._paused) return;
      if (this._node !== node) return;
      if (this._finish) this._finish();
    };
  }

  progress() {
    if (!this._playing || !this._duration) return 0;
    const ctx = audioCtx();
    const el = this._paused ? this._offset : ctx.currentTime - this._startedAt;
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
    for (const rec of Object.values(this.packs)) { rec.tts = null; rec.ready = false; }
    this.packs = {};
    this.voices = [];
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
