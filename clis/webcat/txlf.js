/**
 * TXLF (Wordfast Pro) → WebCAT alignment & tag-injection engine.
 *
 * Productized from the one-off job that backfilled a 740-segment PPTX task
 * from a Wordfast TXLF export. Two representation systems have to meet:
 *
 *   TXLF:    <bx/ex> (paired), <bpt>payload</bpt> … <ept>payload</ept> (paired,
 *            payload carries PPT formatting), <x/> (soft line break)
 *   WebCAT:  sourceHtml text + <img id="rs…"/re… /> tag pairs (rs opens, re
 *            closes, paired by id suffix)
 *
 * Alignment passes (first hit wins):
 *   1 exact        normalized source text identical
 *   2 row-cell     WC row is one ；-separated cell of a longer TXLF row
 *   3 merge        WC row = several consecutive TXLF segments concatenated
 *   4 prefix-cell  WC row = "其中：/例如：" + a TXLF row cell
 * Anything left → manual review list.
 *
 * Tag rules (validated per segment before writing):
 *   - TXLF wrapper ⇄ WC rs/re pair, matched in order with LIFO nesting
 *   - TXLF <x> ⇄ newline (WC convention)
 *   - TXLF formatting payloads (fontFormat/shadow XML) are dropped: they are
 *     transport, not visible text
 *   - WC pair with no TXLF counterpart → kept as an adjacent empty pair so the
 *     source tag set is fully preserved
 *   - postcondition: sorted(<img> set of source) === sorted(<img> set of target)
 */

const TAG_RE = /<[^>]+>/g;
const IMG_RE = /<img\s[^>]*>/g;
const WS_RE = /\s+/g;
const INLINE_TAG_RE = /<(bx|ex|bpt|ept|x)\b[^>]*>|<\/?(?:bpt|ept)>/g;

/* ---------------------------------------------------------------- helpers */

export function stripTags(html) {
  return String(html ?? '').replace(TAG_RE, '');
}

export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function encodeEntities(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Key for source matching: visible text only, all whitespace removed.
 * TXLF wrapper payloads (fontFormat/shadow XML carried between <bpt> and
 * </bpt>) are transport, not content — a naive stripTags keeps them and breaks
 * matching, so run through unitsOf and keep only visible text.
 */
export function normKey(text) {
  const raw = String(text ?? '');
  const looksLikeTxlf = /<(?:bx|ex|bpt|ept|x)\b/.test(raw);
  const visible = looksLikeTxlf
    ? unitsOf(runsOf(raw)).map(([kind, ...rest]) => {
        if (kind === 'text') return decodeEntities(rest[0]);
        if (kind === 'wrap') return visibleText(rest[2]);
        return ''; // <x> line breaks carry no text
      }).join('')
    : decodeEntities(stripTags(raw));
  return visible.replace(/\u00a0|\u200b/g, '').replace(WS_RE, '');
}

/** Single-spaced visible text (for positional matching / display). */
export function spacedText(text) {
  return decodeEntities(stripTags(text)).replace(WS_RE, ' ').trim();
}

/* ------------------------------------------------------------- TXLF model */

/**
 * Parse TXLF XML into segments. Uses regex splitting (the Wordfast export is
 * flat; no nested <trans-unit> shenanigans in practice). Every source/target
 * keeps its raw inner XML so tag structure survives.
 */
export function parseTxlf(xmlText) {
  const text = String(xmlText ?? '');
  if (!text.includes('<xliff')) {
    throw new Error('not a TXLF/XLIFF file: missing <xliff> root');
  }
  const segments = [];
  const unitRe = /<trans-unit\b[^>]*\bid="([^"]*)"[^>]*>([\s\S]*?)<\/trans-unit>/g;
  let unit;
  while ((unit = unitRe.exec(text)) !== null) {
    const [, id, body] = unit;
    const srcMatch = body.match(/<source[^>]*>([\s\S]*?)<\/source>/);
    const tgtMatch = body.match(/<target[^>]*>([\s\S]*?)<\/target>/);
    if (!srcMatch) continue;
    const source = srcMatch[1];
    const target = tgtMatch ? tgtMatch[1] : '';
    segments.push({
      id,
      source,
      target,
      hasTarget: tgtMatch !== null && stripTags(target).trim() !== '',
      hasTags: INLINE_TAG_RE.test(source) || INLINE_TAG_RE.test(target),
    });
    INLINE_TAG_RE.lastIndex = 0;
  }
  return segments;
}

/** Token stream of a TXLF string: [('tag'|'text', payload), …]. */
function runsOf(s) {
  const runs = [];
  let pos = 0;
  let m;
  INLINE_TAG_RE.lastIndex = 0;
  while ((m = INLINE_TAG_RE.exec(s)) !== null) {
    if (m.index > pos) runs.push(['text', s.slice(pos, m.index)]);
    runs.push(['tag', m[0]]);
    pos = m.index + m[0].length;
  }
  if (pos < s.length) runs.push(['text', s.slice(pos)]);
  return runs;
}

/**
 * Group a run stream into units:
 *   ('wrap', openTag, closeTag, innerRaw)   — bx…ex / bpt payload /bpt … ept payload /ept
 *   ('text', raw)
 *   ('x', tag)
 * Nesting is LIFO (stack), matching real tag semantics.
 */
export function unitsOf(runs) {
  const units = [];
  const stack = [];
  let buf = [];
  const flush = () => {
    if (buf.length) {
      units.push(['text', buf.join('')]);
      buf = [];
    }
  };
  for (const [kind, payload] of runs) {
    if (kind !== 'tag') {
      buf.push(payload);
      continue;
    }
    const isOpen = /^<(?:bx|bpt|ept)\b/.test(payload) && !payload.startsWith('</');
    const isClose = payload.startsWith('</') || /^<ex\b/.test(payload);
    if (isOpen) {
      stack.push(payload); // no flush: payload inside a wrapper is not visible text
    } else if (isClose) {
      if (stack.length) {
        units.push(['wrap', stack.pop(), payload, buf.join('')]);
        buf = [];
      } else {
        flush(); // stray close: keep pending text as plain text
      }
    } else if (/^<x\b/.test(payload)) {
      flush();
      units.push(['x', payload]);
    }
  }
  flush();
  // unclosed wrappers: emit their buffered text so nothing is lost
  while (stack.length) {
    units.push(['wrap', stack.pop(), '', buf.join('')]);
    buf = [];
  }
  return units;
}

/** Visible text carried inside a wrapper's inner raw (payload XML stripped). */
function visibleText(innerRaw) {
  return stripTags(decodeEntities(innerRaw));
}

/* ---------------------------------------------------------- WebCAT model */

/** WC <img> tags → (pairs [open, close], singles). Pairing by id suffix. */
export function wcImgPairs(sourceHtml) {
  const pairs = [];
  const stack = [];
  const singles = [];
  for (const tag of String(sourceHtml ?? '').match(IMG_RE) ?? []) {
    const idMatch = tag.match(/id="([^"]+)"/);
    const tid = idMatch ? idMatch[1] : '';
    const base = tid.replace(/^(rs|re)\d*_/, '');
    if (tid.startsWith('rs')) stack.push([tag, base]);
    else if (tid.startsWith('re')) {
      const openIdx = stack.findIndex(([, b]) => b === base);
      if (openIdx >= 0) {
        const [open] = stack.splice(openIdx, 1)[0];
        pairs.push([open, tag]);
      } else singles.push(tag);
    } else singles.push(tag);
  }
  return { pairs, singles };
}

/* ------------------------------------------------- target html generation */

/**
 * Build the WebCAT target HTML for one segment.
 *
 * @param {Array} tUnits unitsOf(runsOf(txlfTarget))
 * @param {string} sourceHtml WebCAT sourceHtml (tag source of truth)
 * @param {object} [opts] { txlfSourceHtml } for position-based injection
 */
export function buildTargetHtml(tUnits, sourceHtml, opts = {}) {
  const { pairs, singles } = wcImgPairs(sourceHtml);
  const hasWrap = tUnits.some(([k]) => k === 'wrap');
  let pairIdx = 0;

  // TXLF kept no wrappers but WC has pairs: inject positionally around the
  // parts of the translation that correspond to the wrapped source text.
  if (!hasWrap && pairs.length) {
    const srcHtml = opts.txlfSourceHtml ?? sourceHtml;
    let plain = tUnits.map(([k, v]) => (k === 'text' ? decodeEntities(v) : '\n')).join('');
    for (const [open, close] of pairs) {
      const inner = textBetween(sourceHtml, open, close);
      const needle = spacedText(inner);
      if (needle) {
        const idx = plain.toLowerCase().indexOf(needle.toLowerCase());
        if (idx >= 0) {
          plain = plain.slice(0, idx) + open + plain.slice(idx, idx + needle.length) + close + plain.slice(idx + needle.length);
          continue;
        }
      }
      // no textual anchor: keep the pair adjacent at the corresponding side
      const srcBefore = sourceHtml.slice(0, sourceHtml.indexOf(open));
      const wrappedStart = normKey(srcBefore).length;
      const total = Math.max(normKey(srcHtml).length, 1);
      if (wrappedStart / total < 0.5) plain = open + close + plain;
      else plain += open + close;
    }
    for (const s of singles) plain += s;
    return plain;
  }

  const out = [];
  for (const [kind, ...rest] of tUnits) {
    if (kind === 'text') {
      out.push(encodeEntities(decodeEntities(decodeEntities(rest[0]))));
    } else if (kind === 'x') {
      out.push('\n');
    } else if (kind === 'wrap') {
      const [, , innerRaw] = rest;
      const vis = visibleText(innerRaw);
      if (vis.trim()) {
        if (pairIdx < pairs.length) {
          const [open, close] = pairs[pairIdx++];
          out.push(open, encodeEntities(vis), close);
        } else {
          out.push(encodeEntities(vis));
        }
      }
      // payload-only wrapper: consumes no pair, emits nothing — pairs are
      // reserved for wrappers that actually carry translated text
    }
  }
  while (pairIdx < pairs.length) {
    const [open, close] = pairs[pairIdx++];
    out.push(open, close);
  }
  for (const s of singles) out.push(s);
  return out.join('');
}

function textBetween(html, open, close) {
  const i = html.indexOf(open);
  if (i < 0) return '';
  const j = html.indexOf(close, i + open.length);
  return j > i ? html.slice(i + open.length, j) : '';
}

/* -------------------------------------------------------------- alignment */

/** TXLF string → visible text (wrapper payloads dropped). */
function txlfVisible(raw) {
  return unitsOf(runsOf(String(raw ?? '')))
    .map(([kind, ...rest]) => {
      if (kind === 'text') return decodeEntities(rest[0]);
      if (kind === 'wrap') return visibleText(rest[2]);
      return '';
    })
    .join('');
}

function splitCells(s) {
  const parts = String(s ?? '').split(/([；;])/);
  const cells = [];
  let buf = [];
  for (const p of parts) {
    buf.push(p);
    if (p === '；' || p === ';') {
      cells.push(buf.join(''));
      buf = [];
    }
  }
  if (buf.join('').trim()) cells.push(buf.join(''));
  return cells;
}

/**
 * Align TXLF segments to WebCAT segments.
 *
 * @param {Array} txlf parseTxlf() output
 * @param {Array} wcSegments WebCAT segment DTOs (need sentId, sourceHtml, locked, target…)
 * @returns {{fills: Array, report: object}}
 */
export function alignTxlfToWebcat(txlf, wcSegments, { skipIdentical = true } = {}) {
  const byKey = new Map();
  txlf.forEach((t, i) => {
    const k = normKey(t.source);
    if (!k) return;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(i);
  });
  const cursor = new Map();

  const fills = [];
  const report = { pass1: 0, pass2Row: 0, pass3Merge: 0, pass4Prefix: 0, pass5Tail: 0, lockedSkipped: 0, identicalSkipped: 0, noMatch: [], filled: 0 };

  // Accept raw WebCAT DTOs (sourcePlaceholder/isLocked) as well as normalized
  // segments (sourceHtml/locked from `webcat sentences`).
  const segments = wcSegments.map((seg) => {
    if (seg.sourceHtml !== undefined || seg.locked !== undefined) return seg;
    return {
      sentId: seg.sentId,
      index: seg.sentIndex ?? seg.index,
      sourceHtml: seg.sourcePlaceholder ?? seg.sourceText ?? '',
      target: seg.targetText ?? '',
      locked: seg.isLocked === true,
    };
  });

  for (const seg of segments) {
    if (seg.locked) {
      report.lockedSkipped++;
      continue;
    }
    const key = normKey(seg.sourceHtml);
    let resolved = null; // { units } | { plain }
    let how = null;

    const cands = byKey.get(key);
    if (cands && cands.length) {
      const cur = cursor.get(key) ?? 0;
      const t = txlf[cands[cur % cands.length]];
      cursor.set(key, cur + 1);
      resolved = { units: unitsOf(runsOf(t.target)) };
      how = 'pass1';
    }

    if (!resolved) {
      outer: for (const t of txlf) {
        const tkey = normKey(t.source);
        if (tkey.length <= key.length || !tkey.includes(key)) continue;
        const srcCells = splitCells(txlfVisible(t.source));
        const tgtCells = splitCells(txlfVisible(t.target));
        if (srcCells.length < 2 || srcCells.length !== tgtCells.length) continue;
        for (let i = 0; i < srcCells.length; i++) {
          if (normKey(srcCells[i]) === key) {
            const plain = i < tgtCells.length ? tgtCells[i] : '';
            resolved = { plain: decodeEntities(plain).trim() };
            how = 'pass2Row';
            break outer;
          }
        }
      }
    }

    if (!resolved) {
      const n = txlf.length;
      outerMerge: for (let i = 0; i < n; i++) {
        let acc = '';
        const texts = [];
        for (let j = i; j < n && acc.length <= key.length + 60; j++) {
          acc += normKey(txlf[j].source);
          texts.push(stripTags(txlf[j].target));
          if (acc === key) {
            resolved = { plain: texts.map((x) => decodeEntities(x).trim()).filter(Boolean).join(' ') };
            how = 'pass3Merge';
            break outerMerge;
          }
        }
      }
    }

    if (!resolved) {
      // pass 5: row tail — WC split a TXLF row so the WC segment is the row's
      // trailing part (after the last ；), e.g. "其中，出口额为…；" rows.
      const key2 = key;
      outerTail: for (const t of txlf) {
        const tkey = normKey(t.source);
        if (tkey.length <= key2.length || !tkey.endsWith(key2)) continue;
        const srcCells = splitCells(txlfVisible(t.source));
        const tgtCells = splitCells(txlfVisible(t.target));
        if (srcCells.length < 2 || srcCells.length !== tgtCells.length) continue;
        // which cell (by key prefix accumulation) does the tail start at?
        let acc = '';
        for (let i = 0; i < srcCells.length; i++) {
          acc += normKey(srcCells[i]);
          if (acc === key2) {
            // cells i..end concatenated form the WC segment
            const plain = tgtCells.slice(i).map((x) => decodeEntities(x).trim()).filter(Boolean).join(' ');
            resolved = { plain };
            how = 'pass5Tail';
            break outerTail;
          }
        }
      }
    }

    if (!resolved) {
      const stripped = spacedText(seg.sourceHtml).replace(/^(其中：?|例如：?)\s*/, '');
      const strippedKey = normKey(stripped);
      const preMap = { 其中: 'including', 例如: 'for example,' };
      outerPrefix: for (const t of txlf) {
        const tkey = normKey(t.source);
        if (tkey.length <= strippedKey.length || !tkey.includes(strippedKey)) continue;
        const srcCells = splitCells(t.source);
        const tgtCells = splitCells(stripTags(t.target));
        if (srcCells.length < 2) continue;
        for (let i = 0; i < srcCells.length; i++) {
          if (normKey(srcCells[i]) === strippedKey) {
            const m = spacedText(t.source).match(/(其中：?|例如：?)\s*$/);
            const pre = m ? `${preMap[m[1].replace(/[：:]/, '')]} ` : '';
            const plain = i < tgtCells.length ? tgtCells[i] : '';
            resolved = { plain: (pre + decodeEntities(plain).trim()).trim() };
            how = 'pass4Prefix';
            break outerPrefix;
          }
        }
      }
    }

    if (!resolved) {
      report.noMatch.push({ sentId: seg.sentId, index: seg.index, source: spacedText(seg.sourceHtml).slice(0, 80) });
      continue;
    }

    const plain = 'units' in resolved
      ? resolved.units.map(([k, v]) => (k === 'text' ? decodeEntities(v) : '')).join('').trim()
      : resolved.plain.trim();

    if (skipIdentical && plain && normKey(plain) === normKey(seg.target ?? '') && String(seg.target ?? '').trim()) {
      report.identicalSkipped++;
      continue;
    }

    const units = 'units' in resolved ? resolved.units : [['text', encodeEntities(resolved.plain)]];
    const html = buildTargetHtml(units, seg.sourceHtml, { txlfSourceHtml: seg.sourceHtml });
    const visibleTarget = decodeEntities(stripTags(html));
    if (!visibleTarget.replace(/\s+/g, '').trim()) {
      // A row-pass picked an empty target cell: writing a blank would erase the
      // segment. Treat as unmatched so it lands on the manual review list.
      report.noMatch.push({ sentId: seg.sentId, index: seg.index, source: spacedText(seg.sourceHtml).slice(0, 80), reason: 'empty target cell' });
      continue;
    }
    fills.push({ sentId: seg.sentId, html, targetText: visibleTarget });
    report.filled++;
    report[how] = (report[how] ?? 0) + 1;
  }
  report.noMatch.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return { fills, report };
}

/* ------------------------------------------------------------- validation */

/** Every source <img> must appear in target (set equality). */
export function tagSetsMatch(sourceHtml, targetHtml) {
  const a = (String(sourceHtml ?? '').match(IMG_RE) ?? []).slice().sort().join('\u0000');
  const b = (String(targetHtml ?? '').match(IMG_RE) ?? []).slice().sort().join('\u0000');
  return a === b;
}

/** Visible text of a WC html string with entities decoded. */
export function visibleOf(html) {
  return decodeEntities(stripTags(html));
}
