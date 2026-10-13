/* ============================================================
   text.js — turn any text file into speakable sentences
   CJK-aware: works for 中文, English, and mixed text.
   ============================================================ */

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;
const CJK_ANY = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const LATIN = /[A-Za-z]/;

/* --- language sniffing ------------------------------------- */
export function detectLang(s) {
  let cjk = 0, latin = 0;
  for (const ch of s) {
    if (CJK_ANY.test(ch)) cjk++;
    else if (LATIN.test(ch)) latin++;
  }
  if (cjk === 0 && latin === 0) return 'neutral';
  if (cjk === 0) return 'en';
  if (latin === 0) return 'zh';
  // mixed: whichever dominates decides the primary voice
  return cjk >= latin * 0.6 ? 'zh' : 'en';
}

export function isCJK(s) { return CJK.test(s); }

/* --- sentence segmentation --------------------------------- */
let seg = null;
try {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    seg = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  }
} catch { seg = null; }

const HARD_END = /[.!?。！？…；;:：]/;
const CLOSERS = /[”’"』」）)\]】》]/;

/** Split one paragraph into sentences. Never returns empty strings. */
export function splitSentences(par) {
  const t = par.trim();
  if (!t) return [];

  let out = [];
  if (seg) {
    // ICU applies UAX #29, which deliberately does NOT break after a period
    // followed by a lowercase word (it assumes an abbreviation). Real text —
    // poetry, informal writing, CJK-adjacent Latin — does that constantly, so
    // refine each ICU segment with the punctuation splitter.
    for (const { segment } of seg.segment(t)) {
      for (const piece of fallbackSplit(segment.trim())) {
        if (piece) out.push(piece);
      }
    }
  } else {
    out = fallbackSplit(t);
  }

  // Merge fragments that are too short to speak well (< 12 chars)
  // and split any sentence that is too long (> 260 chars) — both hurt TTS.
  out = mergeShort(out);
  out = out.flatMap(breakLong);
  return out.filter(s => s && /[\p{L}\p{N}]/u.test(s));
}

// Words whose trailing period is part of the word, not a sentence end.
const ABBREV = new Set(['mr','mrs','ms','dr','prof','sr','jr','st','mt','vs','etc',
  'eg','ie','no','vol','fig','al','inc','ltd','co','dept','est','approx','ca','cf']);

/** Does the text ending at `i` look like an abbreviation or an initial? */
function isAbbrev(t, i) {
  const m = /([A-Za-z]+)\.$/.exec(t.slice(0, i + 1));
  if (!m) return false;
  const w = m[1];
  if (w.length === 1) return true;                 // "J." or "A."
  return ABBREV.has(w.toLowerCase());
}

/** True when position i starts something that cannot begin a sentence. */
function isMidToken(t, i) {
  const prev = t[i - 1], next = t[i + 1];
  if (prev != null && /\d/.test(prev) && next != null && /\d/.test(next)) return true; // 3.14
  return false;
}

function fallbackSplit(t) {
  const res = [];
  let buf = '';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    buf += ch;
    if (HARD_END.test(ch)) {
      // A period inside a number ("3.14") or after an abbreviation ("Dr.")
      // does not end a sentence.
      if (ch === '.' && (isMidToken(t, i) || isAbbrev(t, i))) continue;
      // absorb trailing quotes/brackets
      while (i + 1 < t.length && CLOSERS.test(t[i + 1])) buf += t[++i];
      const piece = buf.trim();
      if (piece) res.push(piece);
      buf = '';
    }
  }
  if (buf.trim()) res.push(buf.trim());
  return res;
}

const TERMINAL = /[.!?。！？…]["'\u201d\u2019)\]]*$/;

/**
 * Glue only the fragments a speaker would not pause after — a heading tail,
 * a stray abbreviation, a line break mid-thought. A fragment that already
 * ends in terminal punctuation is a whole sentence; keep it intact so the
 * highlight lands where the reader expects.
 */
function mergeShort(list) {
  const out = [];
  let acc = '';
  for (const s of list) {
    acc = acc ? acc + ' ' + s : s;
    if (TERMINAL.test(acc) && acc.length >= 4) { out.push(acc); acc = ''; continue; }
    if (acc.length >= 12) { out.push(acc); acc = ''; }
  }
  if (acc) {
    if (out.length) out[out.length - 1] += ' ' + acc;
    else out.push(acc);
  }
  return out;
}

function breakLong(s) {
  const MAX = 260;
  if (s.length <= MAX) return [s];
  const parts = [];
  let rest = s;
  while (rest.length > MAX) {
    // Prefer a break at a comma / 顿号, else at a space, else hard cut.
    let cut = -1;
    for (const re of [/[，,、]\s*/g, /\s+/g]) {
      let m, last = -1;
      re.lastIndex = 0;
      while ((m = re.exec(rest)) !== null) {
        if (m.index > MAX * 0.55 && m.index <= MAX) last = m.index + m[0].length;
        if (m.index > MAX) break;
      }
      if (last > 0) { cut = last; break; }
    }
    if (cut < 0) cut = MAX;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts;
}

/* --- structure detection ----------------------------------- */
export function classifyBlock(line) {
  const t = line.trim();
  if (!t) return null;
  let m;
  if ((m = t.match(/^(#{1,6})\s+(.*)$/))) return { type: 'h', level: m[1].length, text: m[2].trim() };
  if (/^([-*_]\s*){3,}$/.test(t)) return { type: 'hr' };
  if ((m = t.match(/^>\s?(.*)$/))) return { type: 'quote', text: m[1] };
  if ((m = t.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/))) return { type: 'li', marker: m[1], text: m[2] };
  return null;
}

/* --- file cleaning by kind --------------------------------- */
export function cleanByExt(text, ext) {
  const e = (ext || '').toLowerCase();
  if (e === 'srt' || e === 'vtt') {
    return text
      .replace(/^\uFEFF/, '')
      .replace(/^WEBVTT.*$/gim, '')
      .replace(/^\d+$/gm, '')
      .replace(/^\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->.*$/gm, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/\n{3,}/g, '\n\n');
  }
  if (e === 'html' || e === 'htm' || e === 'xml') {
    return text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&/g, '&')
      .replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"')
      .replace(/'/g, "'").replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
      .replace(/\n{3,}/g, '\n\n');
  }
  if (e === 'csv' || e === 'tsv') {
    const d = e === 'csv' ? ',' : '\t';
    return text.split(/\r?\n/).map(row =>
      row.split(d).map(c => c.replace(/^"|"$/g, '').trim()).filter(Boolean).join(' — ')
    ).filter(Boolean).join('\n');
  }
  return text.replace(/^\uFEFF/, '');
}

/** Markdown → display blocks (keeps headings, drops syntax noise). */
export function parseMarkdown(text) {
  return text.split(/\r?\n/);
}

/* --- build the reading model -------------------------------- */
/**
 * Returns { blocks:[{type,level,text,sentences:[{text,lang,start,end}]}], stats }
 */
export function buildModel(rawText, opts = {}) {
  const text = rawText.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
  const isMd = !!opts.markdown;
  const lines = text.split('\n');

  const blocks = [];
  let buf = [];
  let inFence = false;

  const flush = () => {
    const p = buf.join(' ').replace(/\s+/g, ' ').trim();
    buf = [];
    if (!p) return;
    const sentences = splitSentences(p).map(s => ({
      text: s,
      lang: detectLang(s),
    }));
    if (sentences.length) blocks.push({ type: 'p', text: p, sentences });
  };

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '    ');
    const t = line.trim();

    if (isMd && /^```/.test(t)) { flush(); inFence = !inFence; continue; }
    if (inFence) continue;

    if (!t) { flush(); continue; }

    if (isMd) {
      const b = classifyBlock(line);
      if (b && b.type === 'hr') { flush(); blocks.push({ type: 'hr' }); continue; }
      if (b && b.type === 'h') {
        flush();
        const sentences = splitSentences(b.text).map(s => ({ text: s, lang: detectLang(s) }));
        blocks.push({ type: 'h', level: b.level, text: b.text, sentences });
        continue;
      }
      if (b && b.type === 'li') {
        flush();
        const sentences = splitSentences(b.text).map(s => ({ text: s, lang: detectLang(s) }));
        if (sentences.length) blocks.push({ type: 'li', text: b.text, sentences });
        continue;
      }
      if (b && b.type === 'quote') { buf.push(b.text); flush(); continue; }
    }

    buf.push(t);
  }
  flush();

  // Mark the last sentence of each block so the reader can rest longer there.
  for (const b of blocks) {
    if (b.sentences && b.sentences.length) b.sentences[b.sentences.length - 1].isParaEnd = true;
  }

  // stats
  const all = blocks.flatMap(b => b.sentences || []);
  const chars = all.reduce((n, s) => n + s.text.length, 0);
  const cjk = all.reduce((n, s) => n + (s.text.match(/[\u3400-\u9FFF]/g) || []).length, 0);
  const words = all.reduce((n, s) => n + (s.text.match(/[A-Za-z0-9'’\-]+/g) || []).length, 0);
  const zhSent = all.filter(s => s.lang === 'zh').length;
  const enSent = all.filter(s => s.lang === 'en').length;

  return {
    blocks,
    sentences: all,
    stats: {
      blocks: blocks.length,
      sentences: all.length,
      chars, words, cjk,
      zhSent, enSent,
      langs: zhSent && enSent ? 'mixed' : zhSent ? 'zh' : enSent ? 'en' : 'unknown',
    },
  };
}
