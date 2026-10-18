/**
 * Terminology management for WebCAT tasks.
 *
 * `terms extract` — surface translation candidates from the open document
 *   (frequency-ranked, source→target pairs consistent across the doc).
 * `terms add`     — push terms into the WebCAT termbase (entry/create).
 * `terms list`    — read termbase entries (entry/listPageEntryList).
 * `terms check`   — consistency sweep: every segment whose source contains a
 *   known term but whose target deviates from the approved rendering.
 *
 * Termbase payloads (from the editor bundle):
 *   POST /termbase/entry/create          { termDTOList: [...] }
 *   GET  /termbase/entry/listPageEntryList?…
 */

import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { WEBCAT_DOMAIN, getTaskDetail, loadSession, payloadOf, webcatFetch } from './_api.js';
import { collectSegments } from './sentences.js';

/* ------------------------------------------------------------- extraction */

const STOP_ZH = '的了和与及或在是对其为于把被从以按照通过对于根据截至目前我们你们他们这那个些等并将地得有着由向让人们还不非常可以应该需要能够进行实现提高加强推动促进发展建设做好深化推进出台实施成立举办召开举行举行'
  .split('')
  .reduce((set, ch) => set.add(ch), new Set());

export function tokenizeZh(text) {
  // No NLP here: n-gram candidates filtered by CJK ratio and stop-char edges.
  return String(text ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[，。、；：？！“”‘’（）《》\s]/g, ' ')
    .split(' ')
    .filter(Boolean);
}

export function zhTermCandidates(source, { minLen = 2, maxLen = 12 } = {}) {
  const tokens = tokenizeZh(source);
  const out = new Set();
  const add = (token) => {
    if (token.length < minLen || token.length > maxLen) return;
    const cjk = (token.match(/[\u4e00-\u9fff]/g) ?? []).length;
    if (cjk < minLen) return;
    if (STOP_ZH.has(token[0]) || STOP_ZH.has(token[token.length - 1])) return;
    out.add(token);
  };
  for (const token of tokens) {
    add(token);
    // CJK runs are not space-delimited: emit sliding n-grams so terms that sit
    // inside a longer clause (医疗器械行业 inside 医疗器械行业快速发展) surface too.
    const cjkRun = token.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
    for (const run of cjkRun) {
      for (let size = minLen; size <= Math.min(run.length, 8); size++) {
        for (let i = 0; i + size <= run.length; i++) {
          add(run.slice(i, i + size));
        }
      }
    }
  }
  return [...out];
}

/**
 * Terminology signal from a translated document. Two complementary outputs:
 *
 * 1. `terms` — source-side candidates ranked by frequency (CJK n-grams with
 *    stop-char edges removed). The target rendering is NOT guessed; it is
 *    filled in by the translator/agent or the termbase. Guessing it from the
 *    enclosing sentence produces garbage, so we don't.
 * 2. `repeatInconsistencies` — identical SOURCE segments translated
 *    differently. These are genuine consistency defects with no heuristics
 *    involved: same input must map to same output.
 */
export function extractTermPairs(segments, { minCount = 2, minLen = 2, maxLen = 12 } = {}) {
  const termCount = new Map();
  const repeatSources = new Map(); // normalized source -> [{target, sentId, index}]
  const norm = (t) => String(t ?? '').replace(/\s+/g, '');
  for (const seg of segments) {
    const source = String(seg.source ?? '');
    const target = String(seg.target ?? '').trim();
    if (target) {
      for (const term of zhTermCandidates(source, { minLen, maxLen })) {
        termCount.set(term, (termCount.get(term) ?? 0) + 1);
      }
      const key = norm(source);
      if (!repeatSources.has(key)) repeatSources.set(key, []);
      repeatSources.get(key).push({ target, sentId: seg.sentId, index: seg.index });
    }
  }
  const terms = [...termCount.entries()]
    .filter(([, count]) => count >= minCount)
    .map(([source, count]) => ({ source, target: '', count }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));

  const repeatInconsistencies = [];
  for (const [, occurrences] of repeatSources) {
    if (occurrences.length < 2) continue;
    const distinct = new Map(occurrences.map((o) => [o.target, []]));
    for (const o of occurrences) distinct.get(o.target).push(o);
    if (distinct.size < 2) continue;
    repeatInconsistencies.push({
      source: occurrences[0].source ?? '',
      variants: [...distinct.entries()].map(([target, where]) => ({
        target,
        count: where.length,
        sentIds: where.map((w) => w.sentId),
        indexes: where.map((w) => w.index),
      })),
    });
  }
  return { terms, repeatInconsistencies };
}

/* -------------------------------------------------------------- termbase */

/** entry/create accepts termDTOList — shape from bundle: {termName, termTranslation, languagePairId?}. */
export async function createEntries(session, termDTOList, fetchImpl = fetch) {
  if (termDTOList.length === 0) return { created: 0 };
  const envelope = await webcatFetch('/termbase/entry/create', {
    session,
    fetchImpl,
    json: true,
    data: { termDTOList },
  });
  return { created: termDTOList.length, envelope: payloadOf(envelope) ?? null };
}

export async function listEntries(session, { pageSize = 100, pageIndex = 1 } = {}, fetchImpl = fetch) {
  const envelope = await webcatFetch('/termbase/entry/listPageEntryList', {
    session,
    method: 'GET',
    query: { pageSize, pageIndex },
    fetchImpl,
  });
  const payload = payloadOf(envelope);
  const list = Array.isArray(payload) ? payload : payload?.list ?? payload?.data ?? [];
  return { list, total: payload?.total ?? list.length };
}

/* ------------------------------------------------------------- checking */

/**
 * Consistency sweep: for each termbase term, find segments whose source
 * contains it; flag segments whose target does NOT contain the approved
 * rendering (normalized comparison, case-insensitive for latin).
 */
export function checkConsistency(segments, terms, { limitPerTerm = 50 } = {}) {
  const norm = (t) => String(t ?? '').toLowerCase().replace(/\s+/g, ' ');
  const issues = [];
  for (const term of terms) {
    const src = norm(term.source ?? term.termName);
    const tgt = norm(term.target ?? term.termTranslation);
    if (!src || !tgt) continue;
    let checked = 0;
    for (const seg of segments) {
      if (!String(seg.target ?? '').trim()) continue;
      if (!norm(seg.source).includes(src)) continue;
      if (++checked > limitPerTerm) break;
      if (!norm(seg.target).includes(tgt)) {
        issues.push({ sentId: seg.sentId, index: seg.index, termSource: term.source ?? term.termName, expected: term.target ?? term.termTranslation, source: seg.source, target: seg.target });
      }
    }
  }
  return issues;
}

/* -------------------------------------------------------------- command */

export const command = cli({
  site: 'webcat',
  name: 'terms',
  access: 'read',
  description: 'Terminology tools for the open WebCAT task: extract candidates, add to termbase, check consistency',
  domain: WEBCAT_DOMAIN,
  strategy: Strategy.LOCAL,
  browser: false,
  subcommandsNote: 'Use `terms extract | terms add | terms list | terms check` via --action',
  args: [
    { name: 'action', positional: true, required: true, choices: ['extract', 'add', 'list', 'check'], help: 'extract | add | list | check' },
    { name: 'min-count', type: 'int', default: 2, help: 'extract: minimum occurrences of a candidate' },
    { name: 'max', type: 'int', default: 200, help: 'extract: cap number of candidates returned' },
    { name: 'file', help: 'add: JSON file with [{source,target}] terms to push' },
    { name: 'page-size', type: 'int', default: 100, help: 'list: entries per page' },
    { name: 'page-index', type: 'int', default: 1, help: 'list: 1-based page' },
    { name: 'dry-run', type: 'bool', default: false, help: 'add: validate without writing' },
    { name: 'out', help: 'extract/check: also write JSONL to this file' },
  ],
  columns: ['source', 'target', 'count'],
  footerExtra: (kwargs) => `action=${kwargs.action}`,
  func: async (kwargs) => {
    const session = loadSession();
    const detail = await getTaskDetail(session);
    const docId = detail.docId;

    if (kwargs.action === 'list') {
      const { list, total } = await listEntries(session, {
        pageSize: Number(kwargs['page-size'] ?? 100),
        pageIndex: Number(kwargs['page-index'] ?? 1),
      });
      return list.map((e) => ({
        id: e.id ?? e.entryId ?? '',
        source: e.termName ?? e.source ?? '',
        target: e.termTranslation ?? e.target ?? '',
      })).concat([{ note: `total=${total}` }].slice(0, total > 0 ? 0 : 1));
    }

    if (kwargs.action === 'add') {
      if (!kwargs.file) throw new ArgumentError('terms add needs --file <path> with [{source,target},…]');
      const fs = await import('node:fs');
      const parsed = JSON.parse(fs.readFileSync(String(kwargs.file), 'utf-8'));
      const terms = (Array.isArray(parsed) ? parsed : parsed.terms ?? []).map((t) => ({
        termName: String(t.source ?? t.termName ?? '').trim(),
        termTranslation: String(t.target ?? t.termTranslation ?? '').trim(),
      })).filter((t) => t.termName && t.termTranslation);
      if (terms.length === 0) throw new ArgumentError('No usable {source,target} entries in the file');
      if (kwargs['dry-run'] === true) return { action: 'add', dry_run: true, would_add: terms.length, terms: terms.slice(0, 30) };
      const res = await createEntries(session, terms);
      return { action: 'add', ...res };
    }

    // extract & check both need the document
    const raw = await collectSegments(session, docId, { pageSize: 500, maxSegments: 20000 });
    const segments = raw.map((s) => ({
      sentId: s.sentId,
      index: s.sentIndex ?? s.index,
      source: s.sourceText ?? s.sourcePlaceholder ?? '',
      target: s.targetText ?? '',
    }));

    if (kwargs.action === 'extract') {
      const { terms, repeatInconsistencies } = extractTermPairs(segments, {
        minCount: Number(kwargs['min-count'] ?? 2),
      });
      const capped = terms.slice(0, Number(kwargs.max ?? 200));
      if (kwargs.out) {
        const fs = await import('node:fs');
        fs.writeFileSync(String(kwargs.out), `${capped.map((p) => JSON.stringify(p)).join('\n')}\n`, 'utf-8');
      }
      return {
        candidates: capped,
        candidate_total: terms.length,
        repeat_inconsistencies: repeatInconsistencies.slice(0, 50),
        repeat_inconsistency_total: repeatInconsistencies.length,
      };
    }

    if (kwargs.action === 'check') {
      const { list } = await listEntries(session, { pageSize: 500, pageIndex: 1 });
      const terms = list.map((e) => ({ source: e.termName, target: e.termTranslation })).filter((t) => t.source && t.target);
      const issues = checkConsistency(segments, terms);
      if (kwargs.out) {
        const fs = await import('node:fs');
        fs.writeFileSync(String(kwargs.out), `${issues.map((p) => JSON.stringify(p)).join('\n')}\n`, 'utf-8');
      }
      return {
        termbase_terms: terms.length,
        segments: segments.length,
        issues: issues.length,
        inconsistencies: issues.slice(0, 100),
      };
    }

    throw new ArgumentError(`Unknown terms action: ${kwargs.action}`);
  },
});

export const __test__ = { command, extractTermPairs, checkConsistency, zhTermCandidates, tokenizeZh, createEntries, listEntries };
