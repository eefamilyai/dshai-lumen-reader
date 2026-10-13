/* ============================================================
   Lumen Reader — application
   ============================================================ */
import {
  buildModel, cleanByExt, detectLang,
} from './text.js';
import {
  NativeEngine, KokoroEngine, audioCtx, unlockAudio, pickVoice, groupVoices,
} from './engine.js';

/* ---------------------------------------------------------- */
/* tiny dom helpers                                            */
/* ---------------------------------------------------------- */
const $  = (id) => document.getElementById(id);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

/* ---------------------------------------------------------- */
/* persistent settings                                         */
/* ---------------------------------------------------------- */
const DEFAULTS = {
  theme: 'dark',
  engine: 'native',        // 'native' | 'kokoro'
  speed: 1,
  pitch: 1,
  volume: 1,
  voice_zh: '',            // engine-scoped voice ids
  voice_en: '',
  voiceNative_zh: '',
  voiceNative_en: '',
  voiceKokoro_zh: '',
  voiceKokoro_en: '',
  font: 'serif',           // serif | sans | mono
  fontSize: 20,
  lineHeight: 1.85,
  paraGap: 1.05,
  autoScroll: true,
  dimDone: true,
  highlight: 'block',      // block | underline
  skipCode: true,
};

const KEY = 'lumen-reader-v1';
let S = loadSettings();

function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {}
}

/* ---------------------------------------------------------- */
/* app state                                                   */
/* ---------------------------------------------------------- */
const state = {
  doc: null,          // { name, size, text, model }
  sentences: [],      // flattened speakable units
  spans: [],          // DOM span per sentence index
  idx: 0,
  playing: false,
  paused: false,
  engine: null,
  engineId: null,
  abort: null,        // AbortController for the current sentence
  run: 0,             // generation counter: invalidates stale loops
  hits: [],
  hitIdx: -1,
  estSec: 0,
  elapsed: 0,
};

const engines = {
  native: new NativeEngine(),
  kokoro: new KokoroEngine(),
};

/* ---------------------------------------------------------- */
/* boot                                                        */
/* ---------------------------------------------------------- */
applyTheme();
bindChrome();

state.engine = engines.native;
state.engineId = 'native';

await bootNative();
restoreEngine();

/** Bring up the OS voices and start on the one that always works. */
async function bootNative() {
  try {
    await engines.native.init();
  } catch (e) {
    console.warn('native engine unavailable', e);
  }
  autoPickVoices();
}

/** If the user previously chose neural voices, warm them silently. */
async function restoreEngine() {
  if (S.engine !== 'kokoro') return;
  const eng = engines.kokoro;
  try {
    await eng.init(() => {});
    state.engine = eng;
    state.engineId = 'kokoro';
    autoPickVoices();
    updateEnginePill();
    renderSettings();
    if (!eng.fast) warnSlowBackend();
  } catch (e) {
    console.warn('neural restore failed', e);
    S.engine = 'native'; saveSettings();
  }
}

function warnSlowBackend() {
  const eng = engines.kokoro;
  if (eng.fast || !eng.ready) return;
  const n = el('div', 'note warn');
  n.innerHTML = '<strong>This browser has no WebGPU.</strong> Neural voices are ' +
    'running on the CPU, which is several times slower than real time — long ' +
    'sentences will pause between them. System voices stay instant.';
  const body = $('drawer-body');
  if (body && !body.querySelector('.note.warn')) body.prepend(n);
}

/* ---------------------------------------------------------- */
/* theme                                                       */
/* ---------------------------------------------------------- */
function applyTheme() {
  document.documentElement.dataset.theme = S.theme;
  const ico = $('theme-ico');
  if (ico) ico.innerHTML = `<use href="#i-${S.theme === 'dark' ? 'moon' : 'sun'}"/>`;
}

function toggleTheme() {
  S.theme = S.theme === 'dark' ? 'light' : 'dark';
  applyTheme(); saveSettings(); renderSettings();
}

/* ---------------------------------------------------------- */
/* toasts                                                      */
/* ---------------------------------------------------------- */
function toast(msg, kind = '') {
  const box = $('toasts');
  const t = el('div', 'toast ' + kind);
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .3s, transform .3s';
    t.style.opacity = '0';
    t.style.transform = 'translateY(8px)';
    setTimeout(() => t.remove(), 320);
  }, kind === 'err' ? 5200 : 3200);
}

/* ---------------------------------------------------------- */
/* file loading                                                */
/* ---------------------------------------------------------- */
function bindChrome() {
  $('btn-open').onclick = () => $('file-input').click();
  $('btn-open-2').onclick = () => $('file-input').click();
  $('file-input').onchange = e => {
    const f = e.target.files && e.target.files[0];
    if (f) readFile(f);
    e.target.value = '';
  };

  const drop = $('drop');
  const stop = e => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover'].forEach(ev =>
    document.addEventListener(ev, e => {
      stop(e);
      if (drop) drop.classList.add('hot');
    }));
  ['dragleave', 'drop'].forEach(ev =>
    document.addEventListener(ev, e => {
      stop(e);
      if (ev === 'drop' || e.relatedTarget === null) drop && drop.classList.remove('hot');
    }));
  document.addEventListener('drop', e => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readFile(f);
  });

  $('btn-paste').onclick = () => openPasteDialog();
  $('btn-theme').onclick = toggleTheme;
  $('btn-settings').onclick = openDrawer;
  $('btn-drawer-close').onclick = closeDrawer;
  $('scrim').onclick = closeDrawer;
  $('btn-restart').onclick = () => { seek(0); play(); };

  // transport
  $('btn-play').onclick = togglePlay;
  $('btn-stop').onclick = stopAll;
  $('btn-prev-s').onclick = () => step(-1);
  $('btn-next-s').onclick = () => step(1);
  $('btn-prev-p').onclick = () => stepPara(-1);
  $('btn-next-p').onclick = () => stepPara(1);
  $('track').onclick = e => {
    const r = e.currentTarget.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    seek(Math.round(p * Math.max(0, state.sentences.length - 1)));
  };

  // speed
  $('speed-down').onclick = () => setSpeed(roundSpeed(S.speed - 0.05));
  $('speed-up').onclick = () => setSpeed(roundSpeed(S.speed + 0.05));
  $('speed-val').onclick = () => setSpeed(1);

  // search
  $('btn-search').onclick = toggleSearch;
  $('search-close').onclick = () => { $('searchbar').hidden = true; clearHits(); };
  $('search-input').oninput = debounce(runSearch, 180);
  $('search-input').onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); gotoHit(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { $('searchbar').hidden = true; clearHits(); }
  };
  $('search-next').onclick = () => gotoHit(1);
  $('search-prev').onclick = () => gotoHit(-1);

  // samples
  document.querySelectorAll('[data-sample]').forEach(b =>
    b.onclick = () => loadSample(b.dataset.sample));

  // engine pill opens settings
  $('engine-pill').onclick = openDrawer;

  // shortcuts
  document.addEventListener('keydown', onKey);
  // keep media keys sane
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.playing && !state.paused) { /* let it run */ }
  });
}

const roundSpeed = v => Math.round(Math.max(0.5, Math.min(3, v)) * 100) / 100;

async function readFile(file) {
  const name = file.name || 'untitled.txt';
  if (file.size > 24 * 1024 * 1024) {
    toast('That file is very large — loading the first part.', '');
  }
  try {
    const text = await file.text();
    openText(text, name, file.size);
  } catch (e) {
    toast('Could not read that file: ' + e.message, 'err');
  }
}

function openText(text, name, size) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const cleaned = cleanByExt(text, ext);
  const markdown = ['md', 'markdown', 'rst'].includes(ext);

  const model = buildModel(cleaned, { markdown });
  if (!model.sentences.length) {
    toast('No readable text found in that file.', 'err');
    return;
  }

  stopAll();
  state.doc = { name, size: size || text.length, ext, markdown };
  state.sentences = model.sentences;
  state.idx = 0;
  state.elapsed = 0;
  state.estSec = estimate(model.sentences, S.speed);

  render(model);
  showDoc();
  autoPickVoices(model.stats.langs);
  updateTransport();
  updateClock();

  const s = model.stats;
  $('doc-stat').textContent =
    `${s.sentences} sentences · ${fmtNum(s.chars)} chars · ~${fmtTime(state.estSec)}`;

  toast(`Loaded ${name} — ${s.langs === 'mixed' ? '中英 mixed' : s.langs === 'zh' ? '中文' : 'English'}`, 'ok');
}

function showDoc() {
  $('welcome').hidden = true;
  $('reader').hidden = false;
  $('reader-end').hidden = false;
  $('doc-meta').hidden = false;
  $('transport').hidden = false;
  $('doc-name').textContent = state.doc.name;
}

/* ---------------------------------------------------------- */
/* rendering                                                   */
/* ---------------------------------------------------------- */
function render(model) {
  const root = $('reader');
  root.innerHTML = '';
  root.className = 'reader font-' + S.font;
  applyTypo();

  state.spans = [];
  let si = 0;

  for (const b of model.blocks) {
    if (b.type === 'hr') { root.appendChild(el('hr')); continue; }
    if (!b.sentences || !b.sentences.length) continue;

    let node;
    if (b.type === 'h') node = el('h' + Math.min(6, b.level || 2));
    else if (b.type === 'li') node = el('li');
    else node = el('p');

    if (b.type === 'li') {
      // wrap list items in a real <ul> so markers render
      let ul = root.lastElementChild;
      if (!ul || ul.tagName !== 'UL') { ul = el('ul'); root.appendChild(ul); }
      ul.appendChild(node);
    } else {
      root.appendChild(node);
    }

    // Predominantly Chinese prose is set with a two-character first-line
    // indent, the convention readers expect.
    const cjkN = (b.text.match(/[\u3400-\u9FFF]/g) || []).length;
    const latN = (b.text.match(/[A-Za-z]/g) || []).length;
    if (cjkN > latN && b.type !== 'h' && b.type !== 'li') node.classList.add('cjk-para');

    for (const s of b.sentences) {
      const span = el('span', 's' + (s.lang === 'zh' ? ' zh' : ''), s.text + ' ');
      span.dataset.i = String(si);
      span.onclick = () => { seek(si); if (!state.playing) play(); };
      node.appendChild(span);
      state.spans[si] = span;
      si++;
    }
  }

  buildMarks();
}

function applyTypo() {
  const r = $('reader');
  if (!r) return;
  r.style.setProperty('--read-size', S.fontSize + 'px');
  r.style.setProperty('--read-lh', S.lineHeight);
  r.style.setProperty('--para-gap', S.paraGap + 'em');
}

function buildMarks() {
  const box = $('track-marks');
  box.innerHTML = '';
  const n = state.sentences.length;
  if (n < 3) return;
  const step = Math.max(1, Math.floor(n / 60));
  for (let i = 0; i < n; i += step) {
    const m = el('i');
    m.style.left = (i / (n - 1) * 100) + '%';
    box.appendChild(m);
  }
}

/* ---------------------------------------------------------- */
/* voices                                                      */
/* ---------------------------------------------------------- */
function activeEngine() {
  return engines[state.engineId || S.engine] || engines.native;
}

function voiceKey(engineId, lang) { return `voice${engineId === 'native' ? 'Native' : 'Kokoro'}_${lang}`; }

function currentVoiceFor(lang) {
  const eng = activeEngine();
  const id = S[voiceKey(eng.id, lang)];
  return eng.voices.find(v => v.id === id) || pickVoice(eng.voices, lang, null);
}

function autoPickVoices(langs) {
  const eng = activeEngine();
  if (!eng.voices.length) return;
  // Prefer a local, natural voice per language; remember only if unset.
  for (const lang of ['zh', 'en']) {
    const k = voiceKey(eng.id, lang);
    if (!S[k] || !eng.voices.some(v => v.id === S[k])) {
      const best = pickVoice(eng.voices, lang, null);
      if (best) S[k] = best.id;
    }
  }
  saveSettings();
  renderVoiceMini();
}

function renderVoiceMini() {
  const box = $('voices-mini');
  box.innerHTML = '';
  const eng = activeEngine();
  if (!eng.voices.length) return;

  for (const lang of ['zh', 'en']) {
    const pool = eng.voices.filter(v => (v.base || v.lang) === lang);
    if (!pool.length) continue;
    const sel = el('select');
    sel.title = lang === 'zh' ? '中文 voice' : 'English voice';
    for (const v of pool) {
      const o = el('option');
      o.value = v.id;
      o.textContent = (lang === 'zh' ? '中 · ' : 'EN · ') + v.name;
      sel.appendChild(o);
    }
    const cur = currentVoiceFor(lang);
    sel.value = cur ? cur.id : pool[0].id;
    sel.onchange = () => {
      S[voiceKey(eng.id, lang)] = sel.value;
      saveSettings();
      if (state.playing) { restartSentence(); }
    };
    box.appendChild(sel);
  }
  updateEnginePill();
}

function updateEnginePill() {
  const eng = activeEngine();
  $('engine-name').textContent = eng.label || eng.id;
  const dot = $('engine-dot');
  dot.className = 'dot';
  if (eng.id === 'kokoro') {
    if (eng.status === 'loading') dot.classList.add('busy');
    else if (!eng.ready) dot.classList.add('off');
  }
}

/* ---------------------------------------------------------- */
/* playback                                                    */
/* ---------------------------------------------------------- */
function estimate(sentences, speed) {
  let sec = 0;
  for (const s of sentences) {
    const zh = (s.text.match(/[\u3400-\u9FFF]/g) || []).length;
    const en = (s.text.match(/[A-Za-z0-9'’\-]+/g) || []).length;
    sec += zh / 4.6 + en / 2.7 + 0.25;   // chars/sec, words/sec, breath
  }
  return Math.max(1, sec / Math.max(0.25, speed));
}

async function togglePlay() {
  if (!state.doc) return;
  if (state.playing && !state.paused) { pause(); return; }
  if (state.playing && state.paused) { resume(); return; }
  play();
}

async function play() {
  if (!state.doc || !state.sentences.length) return;
  if (state.idx >= state.sentences.length) state.idx = 0;

  const eng = activeEngine();
  if (eng.id === 'kokoro' && !eng.ready) {
    const ok = await ensureKokoro();
    if (!ok) return;
  }

  unlockAudio();
  state.playing = true;
  state.paused = false;
  setPlayIcon();
  pump();
}

/** The playback loop: speak → highlight → prefetch → repeat. */
async function pump() {
  const myRun = ++state.run;

  while (state.playing && !state.paused && state.idx < state.sentences.length) {
    if (myRun !== state.run) return;

    const i = state.idx;
    const s = state.sentences[i];
    const eng = activeEngine();
    const voice = currentVoiceFor(s.lang === 'neutral' ? (detectLang(s.text) === 'zh' ? 'zh' : 'en') : s.lang)
                  || currentVoiceFor('en');
    if (!voice) { toast('No voice available for this language.', 'err'); stopAll(); return; }

    highlight(i);
    scrollTo(i);
    updateClock(i);

    // Prefetch the next two sentences while this one plays.
    for (let k = 1; k <= 2; k++) {
      const nxt = state.sentences[i + k];
      if (!nxt) break;
      const nv = currentVoiceFor(nxt.lang) || voice;
      if (eng.prefetch) eng.prefetch(nxt.text, nv.id, S.speed, null);
    }

    const ac = new AbortController();
    state.abort = ac;
    state._sentStart = performance.now();

    try {
      if (eng.id === 'kokoro') startProgressTicker();

      await eng.play(s.text, {
        voiceId: voice.id,
        rate: S.speed,
        speed: S.speed,
        pitch: S.pitch,
        volume: S.volume,
        signal: ac.signal,
      }, {
        signal: ac.signal,
        onStart: () => {},
      });

      stopProgressTicker();
    } catch (e) {
      stopProgressTicker();
      if (myRun !== state.run) return;
      if (e && e.name === 'AbortError') return;
      // A single bad sentence should not kill the run.
      console.warn('speech error', e);
      toast('Voice error: ' + (e.message || e) , 'err');
      // fall through to the next sentence
    }

    if (myRun !== state.run || state.paused || !state.playing) return;
    state.idx++;
  }

  if (myRun === state.run && state.idx >= state.sentences.length) {
    finish();
  }
}

function finish() {
  state.playing = false;
  state.paused = false;
  setPlayIcon();
  updateClock();
  $('btn-restart').hidden = false;
}

function pause() {
  if (!state.playing || state.paused) return;
  state.paused = true;
  state.enginePause = true;
  activeEngine().pause();
  setPlayIcon();
}

function resume() {
  if (!state.playing || !state.paused) return;
  state.paused = false;
  const eng = activeEngine();
  if (eng.id === 'kokoro') {
    eng.resume();
    // The audio node finishes after resume; keep the loop alive.
    if (!eng._playing) { setPlayIcon(); pump(); }
  } else {
    eng.resume();
  }
  setPlayIcon();
}

function stopAll() {
  state.playing = false;
  state.paused = false;
  state.run++;
  if (state.abort) { try { state.abort.abort(); } catch {} state.abort = null; }
  engines.native.stop();
  engines.kokoro.stop();
  stopProgressTicker();
  setPlayIcon();
  updateClock();
}

function restartSentence() {
  if (!state.playing) return;
  stopAll();
  play();
}

function step(dir) {
  if (!state.doc) return;
  const wasPlaying = state.playing;
  seek(state.idx + dir);
  if (wasPlaying) { stopAll(); play(); }
}

function stepPara(dir) {
  if (!state.doc) return;
  const wasPlaying = state.playing;
  const spans = state.spans;
  const cur = spans[state.idx];
  if (!cur) return;
  let node = cur.parentElement;
  let target = node;
  while (node) {
    node = dir > 0 ? node.nextElementSibling : node.previousElementSibling;
    if (node && node.querySelector && node.querySelector('.s')) { target = node; break; }
  }
  const first = target && target.querySelector ? target.querySelector('.s') : null;
  if (first) seek(parseInt(first.dataset.i, 10));
  if (wasPlaying) { stopAll(); play(); }
}

function seek(i) {
  if (!state.sentences.length) return;
  state.idx = Math.max(0, Math.min(state.sentences.length - 1, i));
  highlight(state.idx);
  scrollTo(state.idx);
  updateClock(state.idx);
  $('btn-restart').hidden = true;
}

function highlight(i) {
  const prev = document.querySelector('.s.now');
  if (prev) {
    prev.classList.remove('now');
    if (S.dimDone) prev.classList.add('done');
  }
  const cur = state.spans[i];
  if (!cur) return;
  cur.classList.remove('done');
  cur.classList.add('now');
  cur.classList.toggle('zh', state.sentences[i].lang === 'zh');
}

function scrollTo(i) {
  if (!S.autoScroll) return;
  const s = state.spans[i];
  if (!s) return;
  const stage = $('stage');
  const r = s.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  const margin = sr.height * 0.28;
  if (r.top < sr.top + margin || r.bottom > sr.bottom - margin * 0.6) {
    const y = s.offsetTop - stage.clientHeight * 0.34;
    stage.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  }
}

/* ---------------------------------------------------------- */
/* progress ticker (kokoro reports real audio position)        */
/* ---------------------------------------------------------- */
let ticker = null;
function startProgressTicker() {
  stopProgressTicker();
  ticker = setInterval(() => {
    const eng = engines.kokoro;
    const p = eng.progress ? eng.progress() : 0;
    const n = state.sentences.length;
    const frac = (state.idx + Math.max(0, Math.min(1, p))) / Math.max(1, n);
    setTrack(frac);
    updateClock(state.idx, p);
  }, 120);
}
function stopProgressTicker() {
  if (ticker) { clearInterval(ticker); ticker = null; }
}

/* ---------------------------------------------------------- */
/* transport UI                                                */
/* ---------------------------------------------------------- */
function setPlayIcon() {
  const playing = state.playing && !state.paused;
  $('play-ico').innerHTML = `<use href="#i-${playing ? 'pause' : 'play'}"/>`;
  $('btn-play').title = playing ? 'Pause (Space)' : 'Play (Space)';
}

function setTrack(frac) {
  const pct = Math.max(0, Math.min(1, frac)) * 100;
  $('track-fill').style.width = pct + '%';
  $('track-knob').style.left = pct + '%';
}

function updateTransport() {
  const n = state.sentences.length;
  setTrack(n > 1 ? state.idx / (n - 1) : 0);
  $('speed-val').textContent = S.speed.toFixed(2).replace(/0$/, '') + '×';
  renderVoiceMini();
}

function updateClock(i, within = 0) {
  const n = state.sentences.length;
  if (!n) { $('pos-label').textContent = '0 / 0'; $('time-label').textContent = '— left'; return; }
  const at = (i == null ? state.idx : i);
  $('pos-label').textContent = `${Math.min(at + 1, n)} / ${n}`;

  const remaining = state.sentences.slice(at).reduce((sec, s) => {
    const zh = (s.text.match(/[\u3400-\u9FFF]/g) || []).length;
    const en = (s.text.match(/[A-Za-z0-9'’\-]+/g) || []).length;
    return sec + zh / 4.6 + en / 2.7 + 0.25;
  }, 0);
  const left = Math.max(0, remaining / Math.max(0.25, S.speed) - within * 2);
  $('time-label').textContent = '~' + fmtTime(left) + ' left';
}

function setSpeed(v) {
  S.speed = roundSpeed(v);
  saveSettings();
  updateClock();
  $('speed-val').textContent = S.speed.toFixed(2).replace(/0$/, '') + '×';
  renderSettings();
  if (state.playing && !state.paused) {
    // Restart the current sentence at the new rate.
    state.run++;
    if (state.abort) { try { state.abort.abort(); } catch {} }
    engines.native.stop();
    engines.kokoro.stop();
    state.playing = false;
    play();
  }
}

/* ---------------------------------------------------------- */
/* Kokoro loading                                              */
/* ---------------------------------------------------------- */
async function ensureKokoro() {
  const eng = engines.kokoro;
  if (eng.ready) return true;

  $('buffer').hidden = false;
  $('buf-text').textContent = 'Preparing neural voices…';
  updateEnginePill();

  try {
    // The loader reports every chunk; repainting on each one would thrash
    // the DOM. Repaint only when the percentage actually moves.
    let lastPct = -1, lastNote = '';
    await eng.init(p => {
      const pct = Math.round(p.pct || 0);
      const note = p.phase === 'done' ? 'Ready' : String(p.note || '').slice(0, 40);
      if (pct === lastPct && note === lastNote) return;
      lastPct = pct; lastNote = note;
      const sizeNote = p.device === 'webgpu' ? 'GPU' : 'CPU';
      $('buf-text').textContent =
        p.phase === 'done' ? 'Ready'
        : `Downloading neural voice · ${sizeNote} · ${pct}% · ${note}`;
      $('buf-fill').style.width = pct + '%';
    });
    $('buffer').hidden = true;
    updateEnginePill();
    autoPickVoices();
    renderSettings();
    if (!eng.fast) warnSlowBackend();
    toast('Neural voices ready — ' + eng.voices.length +
          ' available on ' + (eng.fast ? 'GPU' : 'CPU'), 'ok');
    return true;
  } catch (e) {
    $('buffer').hidden = true;
    updateEnginePill();
    console.error(e);
    toast('Could not load neural voices. Staying on system voices.', 'err');
    S.engine = 'native';
    state.engineId = 'native';
    saveSettings();
    renderSettings();
    return false;
  }
}

async function switchEngine(id) {
  if (id === state.engineId) return;
  const wasPlaying = state.playing;
  if (wasPlaying) stopAll();

  S.engine = id;
  state.engineId = id;
  saveSettings();

  if (id === 'kokoro') {
    const ok = await ensureKokoro();
    if (!ok) { renderSettings(); return; }
  }
  state.engine = engines[id];
  autoPickVoices();
  updateEnginePill();
  renderSettings();
  if (wasPlaying) play();
}

/* ---------------------------------------------------------- */
/* clock helpers                                               */
/* ---------------------------------------------------------- */
function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
function fmtNum(n) {
  return n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}
function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ---------------------------------------------------------- */
/* search                                                      */
/* ---------------------------------------------------------- */
function toggleSearch() {
  const bar = $('searchbar');
  bar.hidden = !bar.hidden;
  if (!bar.hidden) $('search-input').focus();
  else clearHits();
}

function runSearch() {
  const q = $('search-input').value.trim();
  clearHits();
  if (!q || !state.doc) { $('search-count').textContent = '0/0'; return; }
  const nq = q.toLowerCase();
  state.hits = [];
  state.sentences.forEach((s, i) => {
    if (s.text.toLowerCase().includes(nq)) state.hits.push(i);
  });
  for (const i of state.hits) state.spans[i] && state.spans[i].classList.add('hit');
  state.hitIdx = state.hits.length ? 0 : -1;
  $('search-count').textContent = `${state.hits.length ? 1 : 0}/${state.hits.length}`;
  if (state.hitIdx >= 0) {
    highlightHit();
    seek(state.hits[0]);
  }
}

function gotoHit(dir) {
  if (!state.hits.length) return;
  state.hitIdx = (state.hitIdx + dir + state.hits.length) % state.hits.length;
  $('search-count').textContent = `${state.hitIdx + 1}/${state.hits.length}`;
  highlightHit();
  seek(state.hits[state.hitIdx]);
}

function highlightHit() {
  document.querySelectorAll('.s.cur').forEach(n => n.classList.remove('cur'));
  const s = state.spans[state.hits[state.hitIdx]];
  if (s) s.classList.add('cur');
}

function clearHits() {
  document.querySelectorAll('.s.hit,.s.cur').forEach(n => n.classList.remove('hit', 'cur'));
  state.hits = [];
  state.hitIdx = -1;
}

/* ---------------------------------------------------------- */
/* settings drawer                                             */
/* ---------------------------------------------------------- */
function openDrawer() {
  renderSettings();
  $('drawer').hidden = false;
  $('scrim').hidden = false;
}
function closeDrawer() {
  $('drawer').hidden = true;
  $('scrim').hidden = true;
}

function section(title, note, ...rows) {
  const s = el('div', 'set');
  const head = el('div', 'set-head');
  head.appendChild(el('div', 'set-title', title));
  s.appendChild(head);
  if (note) s.appendChild(el('p', 'set-note', note));
  const box = el('div', 'set-row');
  rows.forEach(r => r && box.appendChild(r));
  s.appendChild(box);
  return s;
}

function segmented(options, current, onPick) {
  const seg = el('div', 'seg');
  for (const [val, label] of options) {
    const b = el('button', null, label);
    b.setAttribute('aria-pressed', String(val === current));
    b.onclick = () => onPick(val);
    seg.appendChild(b);
  }
  return seg;
}

function slider(min, max, step, val, onInput, fmt) {
  const wrap = el('div');
  wrap.style.flex = '1 1 150px';
  const r = el('input');
  r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = val;
  const out = el('span', null, fmt ? fmt(val) : val);
  out.style.cssText = 'font-size:11.5px;color:var(--ink-3);min-width:44px;text-align:right';
  r.oninput = () => { const v = parseFloat(r.value); out.textContent = fmt ? fmt(v) : v; onInput(v); };
  const row = el('div');
  row.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%';
  row.append(r, out);
  wrap.appendChild(row);
  return wrap;
}

function sw(on, onChange) {
  const b = el('button', 'switch');
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', String(!!on));
  b.onclick = () => {
    const v = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(v));
    onChange(v);
  };
  return b;
}

function renderSettings() {
  const body = $('drawer-body');
  if (!body) return;
  body.innerHTML = '';

  /* --- engine --- */
  const engRow = segmented(
    [['native', 'System voices'], ['kokoro', 'Neural (中/EN)']],
    state.engineId || S.engine,
    v => switchEngine(v)
  );
  body.appendChild(section(
    'Voice engine',
    state.engineId === 'kokoro'
      ? `Neural voices on ${(engines.kokoro.device || 'cpu').toUpperCase()} — ` +
        `${engines.kokoro.voices.length} voices, downloaded once and cached. ` +
        (engines.kokoro.fast ? 'Fast enough to stream continuously.'
                             : 'Slower than real time on this device; system voices stay instant.')
      : 'Your device voices start instantly. Switch to neural for more natural, expressive reading.',
    engRow
  ));

  /* --- voice pickers --- */
  const eng = activeEngine();
  if (eng.voices.length) {
    const grid = el('div', 'voice-grid');
    const curZh = currentVoiceFor('zh');
    const curEn = currentVoiceFor('en');
    const list = [...eng.voices].sort((a, b) => {
      const rank = v => ((v.base || v.lang) === 'zh' ? 0 : 1) * 10000 + (v.gender === 'female' ? 0 : 1000) +
                        (parseInt(v.id.slice(3), 10) || 0);
      return rank(a) - rank(b);
    });

    for (const v of list) {
      const row = el('button', 'vrow');
      row.setAttribute('aria-checked', String(v.id === ((v.base || v.lang) === 'zh' ? curZh : curEn)?.id));
      row.appendChild(el('span', 'v-flag', (v.base || v.lang) === 'zh' ? '中' : 'EN'));
      const meta = el('div', 'v-meta');
      meta.appendChild(el('div', 'v-name', v.name));
      const tags = [(v.base || v.lang) === 'zh' ? '中文' : 'English', v.gender === 'female' ? '女声' : v.gender === 'male' ? '男声' : '']
        .filter(Boolean).join(' · ');
      meta.appendChild(el('div', 'v-tag', tags));
      row.appendChild(meta);

      const playBtn = el('button', 'v-play');
      playBtn.innerHTML = '<svg><use href="#i-play"/></svg>';
      playBtn.title = 'Preview';
      playBtn.onclick = async (e) => {
        e.stopPropagation();
        playBtn.classList.add('spin');
        try {
          if (eng.id === 'kokoro') {
            const prev = state.playing;
            if (prev) stopAll();
            const sample = (v.base || v.lang) === 'zh' ? '你好，这是语音试听。' : 'Hello, this is a preview.';
            const ac = new AbortController();
            await eng.play(sample, { voiceId: v.id, speed: 1, volume: 1, signal: ac.signal }, { signal: ac.signal });
          } else {
            const u = new SpeechSynthesisUtterance((v.base || v.lang) === 'zh' ? '你好，这是语音试听。' : 'Hello, this is a preview.');
            u.voice = v._voice; u.lang = v.lang;
            u.rate = 1; speechSynthesis.cancel(); speechSynthesis.speak(u);
          }
        } catch (e2) { console.warn(e2); }
        setTimeout(() => playBtn.classList.remove('spin'), 700);
      };
      row.appendChild(playBtn);

      row.onclick = () => {
        S[voiceKey(eng.id, v.base || v.lang)] = v.id;
        saveSettings();
        renderVoiceMini();
        renderSettings();
        if (state.playing && !state.paused) restartSentence();
      };
      grid.appendChild(row);
    }

    const s = el('div', 'set');
    s.appendChild(el('div', 'set-head')).appendChild(el('div', 'set-title',
      `Voices (${eng.voices.length})`));
    s.appendChild(el('p', 'set-note',
      eng.id === 'kokoro'
        ? 'Tap a voice to use it; ▶ previews it. Chinese and English are chosen separately, so mixed text reads in both.'
        : 'These are your operating system voices. Tap to use, ▶ to preview.'));
    s.appendChild(grid);
    body.appendChild(s);
  }

  /* --- speed --- */
  body.appendChild(section(
    'Speed',
    'Playback rate. Applies immediately — even mid-sentence.',
    segmented([[0.75, '0.75×'], [1, '1×'], [1.25, '1.25×'], [1.5, '1.5×'], [2, '2×']], S.speed, v => setSpeed(v)),
    (() => {
      const w = slider(0.5, 3, 0.05, S.speed, v => setSpeed(v), v => v.toFixed(2) + '×');
      w.style.flexBasis = '100%';
      return w;
    })()
  ));

  /* --- typography --- */
  body.appendChild(section('Typography', 'Comfort settings for the reading pane.',
    segmented([['serif', 'Serif'], ['sans', 'Sans'], ['mono', 'Mono']], S.font, v => {
      S.font = v; saveSettings();
      $('reader').className = 'reader font-' + v;
      renderSettings();
    }),
    slider(15, 30, 1, S.fontSize, v => { S.fontSize = v; applyTypo(); saveSettings(); }, v => v + 'px'),
    slider(1.4, 2.4, 0.05, S.lineHeight, v => { S.lineHeight = v; applyTypo(); saveSettings(); }, v => v.toFixed(2)),
  ));

  /* --- reading --- */
  body.appendChild(section('Reading', null,
    labelSwitch('Auto-scroll to the spoken line', S.autoScroll, v => { S.autoScroll = v; saveSettings(); }),
    labelSwitch('Dim finished sentences', S.dimDone, v => { S.dimDone = v; saveSettings();
      document.querySelectorAll('.s.done').forEach(n => v ? null : n.classList.remove('done')); }),
    labelSwitch('Dark theme', S.theme === 'dark', v => { S.theme = v ? 'dark' : 'light'; applyTheme(); saveSettings(); }),
  ));

  /* --- shortcuts --- */
  const ks = el('div', 'klist');
  const K = [
    ['Play / Pause', ['Space']],
    ['Stop', ['Esc']],
    ['Sentence back / forward', ['←', '→']],
    ['Paragraph back / forward', ['Shift', '←/→']],
    ['Open file', ['Ctrl', 'O']],
    ['Find in text', ['Ctrl', 'F']],
    ['Settings', ['Ctrl', ',']],
    ['Speed up / down', ['Ctrl', '↑/↓']],
    ['Jump to start', ['Home']],
  ];
  for (const [label, keys] of K) {
    const r = el('div', 'krow');
    r.appendChild(el('span', null, label));
    const kk = el('span');
    keys.forEach(k => kk.appendChild(el('span', 'kbd', k)));
    r.appendChild(kk);
    ks.appendChild(r);
  }
  const sc = el('div', 'set');
  sc.appendChild(el('div', 'set-head')).appendChild(el('div', 'set-title', 'Keyboard'));
  sc.appendChild(el('p', 'set-note', 'Lumen is keyboard-first — you can run the whole thing without the mouse.'));
  sc.appendChild(ks);
  body.appendChild(sc);

  /* --- about --- */
  const ab = el('div', 'set');
  ab.appendChild(el('div', 'set-head')).appendChild(el('div', 'set-title', 'About'));
  const note = el('div', 'note');
  note.innerHTML =
    'Everything runs <strong>on your device</strong> — your text is never uploaded. ' +
    'Neural voices use the Kokoro-82M v1.1 Chinese model via WebGPU/WASM and are cached after the first load. ' +
    'System voices come from your operating system.';
  ab.appendChild(note);
  body.appendChild(ab);
}

function labelSwitch(label, on, onChange) {
  const row = el('div');
  row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:3px 0';
  row.appendChild(el('span', null, label));
  row.appendChild(sw(on, onChange));
  return row;
}

/* ---------------------------------------------------------- */
/* keyboard                                                    */
/* ---------------------------------------------------------- */
function onKey(e) {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;

  if (e.key === 'Escape') {
    if (!$('drawer').hidden) { closeDrawer(); return; }
    if (!$('searchbar').hidden) { $('searchbar').hidden = true; clearHits(); return; }
    if (state.playing) { stopAll(); return; }
  }

  if ((e.ctrlKey || e.metaKey)) {
    const k = e.key.toLowerCase();
    if (k === 'o') { e.preventDefault(); $('file-input').click(); return; }
    if (k === 'f') { e.preventDefault(); toggleSearch(); return; }
    if (k === ',') { e.preventDefault(); openDrawer(); return; }
    if (k === 'arrowup') { e.preventDefault(); setSpeed(S.speed + 0.05); return; }
    if (k === 'arrowdown') { e.preventDefault(); setSpeed(S.speed - 0.05); return; }
    return;
  }

  if (typing) return;
  if (!state.doc) return;

  switch (e.key) {
    case ' ':
      e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft':
      e.preventDefault(); if (e.shiftKey) stepPara(-1); else step(-1); break;
    case 'ArrowRight':
      e.preventDefault(); if (e.shiftKey) stepPara(1); else step(1); break;
    case 'ArrowUp':
      e.preventDefault(); $('stage').scrollBy({ top: -120, behavior: 'smooth' }); break;
    case 'ArrowDown':
      e.preventDefault(); $('stage').scrollBy({ top: 120, behavior: 'smooth' }); break;
    case 'Home':
      e.preventDefault(); seek(0); break;
    case 'End':
      e.preventDefault(); seek(state.sentences.length - 1); break;
    case 'PageUp':
      e.preventDefault(); seek(state.idx - 10); break;
    case 'PageDown':
      e.preventDefault(); seek(state.idx + 10); break;
  }
}

/* ---------------------------------------------------------- */
/* paste dialog                                                */
/* ---------------------------------------------------------- */
function openPasteDialog() {
  const text = window.prompt('Paste your text below:', '');
  if (text && text.trim()) openText(text, 'pasted.txt', text.length);
}

/* ---------------------------------------------------------- */
/* samples                                                     */
/* ---------------------------------------------------------- */
const SAMPLES = {
  en: `The Lighthouse at the Edge of the Map

There is a lighthouse on the northern coast that has stood for one hundred and forty years. Its keeper, a woman named Elena, has tended it for the last thirty of them.

Every evening she climbs the one hundred and twelve steps to the lamp room. She checks the oil, wipes the glass, and waits for the dark to arrive. When it does, she lights the lamp and the light begins its slow sweep across the water — three seconds bright, three seconds dark, three seconds bright again.

"People think the light is for ships," she says. "It is. But it's also for anyone who is lost and needs to know that somewhere, someone is still keeping watch."

The storms here are legendary. In winter, waves strike the rocks with enough force to shake the tower to its foundation. Elena has never once missed a night.`,

  zh: `海边的灯塔

在中国东南沿海的一座小岛上，有一座已经矗立了一百四十年的灯塔。守塔人是一位叫林秀兰的女士，她在这里已经工作了三十年。

每天傍晚，她都要爬上那一百一十二级台阶，来到灯室。她检查灯油，擦拭玻璃，等待黑夜降临。当夜色真正到来时，她点亮灯火，光束便开始缓缓扫过海面——亮三秒，暗三秒，再亮三秒。

"人们以为灯塔是为船只点的，"她说，"确实是这样。但它也是为那些迷路的人点的——让他们知道，在某个地方，还有人在为他们守望。"

这里的风暴是出了名的。冬天，海浪拍打在礁石上，力量大得足以让整座塔震动。但林秀兰从来没有缺席过一个夜晚。`,

  mixed: `Reading in two languages 双语阅读

这是一段中英混合的文本。The idea is simple: a reader should not have to choose between languages.

当你在读一篇技术文章时，经常会遇到这样的情况——句子里夹着英文术语，比如 machine learning、gradient descent，或者 API。

Lumen Reader 会为每一句话单独判断语言。中文句子用中文声音读，English sentences use an English voice，而 mixed 的句子则会选择占主导的那一种。

这样，你就可以用同一个播放列表，听完一整篇中英夹杂的文章。No switching, no copying, no fuss.`,

  md: `# Markdown Support

Lumen reads structured documents, not just plain text.

## Headings become pauses

Each heading is read as its own unit, so the reader naturally slows at section breaks.

### Lists work too

- The first point is read as one sentence.
- The second point follows immediately after it.
- And the third arrives without any clicking.

## Quotes

> A reader lives a thousand lives before he dies. The man who never reads lives only one.

## Code is skipped

Fenced blocks are ignored so the reader does not spell out punctuation:

\`\`\`js
const greeting = "hello";
console.log(greeting);
\`\`\`

That is the whole idea — structure you can hear.`,
};

function loadSample(kind) {
  const t = SAMPLES[kind];
  if (!t) return;
  const names = { en: 'the-lighthouse.md', zh: '灯塔.md', mixed: 'bilingual.md', md: 'markdown-demo.md' };
  openText(t, names[kind] || 'sample.md', t.length);
}

/* ---------------------------------------------------------- */
/* deep links — ?sample=zh · ?url=https://… · ?text=…          */
/* ---------------------------------------------------------- */
async function fromQuery() {
  const q = new URLSearchParams(location.search);
  const sample = q.get('sample');
  if (sample && SAMPLES[sample]) { loadSample(sample); return; }

  const remote = q.get('url');
  if (remote) {
    try {
      toast('Fetching ' + new URL(remote).host + '…');
      const r = await fetch(remote);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const body = await r.text();
      const name = (new URL(remote).pathname.split('/').pop() || 'download.txt');
      openText(body, name, body.length);
    } catch (e) {
      toast('Could not fetch that URL: ' + e.message, 'err');
    }
    return;
  }

  const inline = q.get('text');
  if (inline) openText(inline, 'shared.txt', inline.length);
}

fromQuery();

/* ---------------------------------------------------------- */
/* expose a tiny debug surface (harmless, useful in the console) */
/* ---------------------------------------------------------- */
window.__lumen = { state, engines, S, openText, play, stopAll };
