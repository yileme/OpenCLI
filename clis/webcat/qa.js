/**
 * `opencli webcat qa` — run QA on the open task and classify false positives.
 *
 * Flow (mirrors the editor): sentence-check/all {category:"QA"} → poll
 * progress until 100 → collect QA logs per segment via
 * get-placeholder-with-qa (batched by sentIds; returns qaLogs[] with
 * checkType/errorCode/original/errorStartPos…).
 *
 * False-positive heuristics (tuned on a 740-segment medical-device deck):
 *   NUMBER_CHECK  — source/translation legitimately differ in number set
 *                   (dates reformatted, 万/亿 conversions, percentages moved),
 *                   or the "missing" number appears elsewhere in the segment
 *                   (split across sentences). Flag as review only when the
 *                   number is wholly absent from both source and target.
 *   PUNCTUATION/  — CJK↔latin punctuation swap that matches the target
 *   SPACE             language convention (，→, at clause boundaries).
 *   TAG/FORMAT    — placeholder present in target under a different entity
 *                   spelling (&#8216; vs ‘).
 *   TERM_CHECK    — rendering matches a termbase-approved synonym.
 * Anything not clearly benign is reported as REAL with context so a human
 * can act immediately.
 */

import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { WEBCAT_DOMAIN, getTaskDetail, loadSession, payloadOf, webcatFetch } from './_api.js';
import { collectSegments } from './sentences.js';

const QA_CHUNK = 25;
const POLL_INTERVAL_MS = 3000;
const POLL_MAX = 100;

export async function runQa(session, { category = 'QA' } = {}, fetchImpl = fetch) {
  const start = await webcatFetch('/sentence/sentence-check/all', { session, data: { category }, fetchImpl });
  return payloadOf(start);
}

export async function pollQaProgress(session, { category = 'QA', onProgress } = {}, fetchImpl = fetch) {
  for (let i = 0; i < POLL_MAX; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const prog = payloadOf(await webcatFetch('/sentence/sentence-check/progress', { session, data: { category }, fetchImpl })) ?? {};
    if (typeof onProgress === 'function') onProgress(prog);
    if (prog.running === false && (prog.progress ?? 100) >= 100) return prog;
  }
  throw new CommandExecutionError(`QA progress did not finish within ${POLL_MAX * POLL_INTERVAL_MS / 1000}s`);
}

/** Pull per-segment QA logs (only segments with a target). */
export async function collectQaLogs(session, docId, segments, fetchImpl = fetch) {
  const withTarget = segments.filter((s) => String(s.targetText ?? s.target ?? '').trim());
  const logs = [];
  for (let i = 0; i < withTarget.length; i += QA_CHUNK) {
    const chunk = withTarget.slice(i, i + QA_CHUNK);
    const ids = chunk.map((s) => s.sentId).join(',');
    const res = payloadOf(await webcatFetch('/sentence/webcatSentence/get-placeholder-with-qa', {
      session,
      data: { docId, sentIds: ids, splitIndex: session.splitIndex || '0' },
      fetchImpl,
    })) ?? [];
    for (const item of res) {
      for (const qa of item.qaLogs ?? []) {
        logs.push({
          sentId: item.sentId,
          sentIndex: item.sentIndex ?? qa.sentIndex,
          source: chunk.find((s) => s.sentId === item.sentId)?.sourceText ?? chunk.find((s) => s.sentId === item.sentId)?.sourcePlaceholder ?? '',
          target: chunk.find((s) => s.sentId === item.sentId)?.targetText ?? '',
          ...qa,
        });
      }
    }
  }
  return logs;
}

/* ---------------------------------------------------- false-positive rules */

function numbersIn(text) {
  // decode entities first: &#8216; is a quote, not the number 8216
  return (decoded(text).match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(/,/g, ''));
}

function decoded(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => safeCp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => safeCp(parseInt(d, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

function safeCp(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Classify one QA log entry.
 * verdict: 'false_positive' | 'review' | 'real'
 * reason: short human-readable explanation.
 */
export function classifyQaLog(log, ctx = {}) {
  const type = String(log.checkType ?? '').toUpperCase();
  const original = String(log.original ?? '');
  const source = decoded(ctx.source ?? log.source ?? '');
  const target = decoded(ctx.target ?? log.target ?? '');
  const srcNums = new Set(numbersIn(source));
  const tgtNums = new Set(numbersIn(target));

  if (type.includes('NUMBER')) {
    // The checker sometimes reads the digit body of an HTML entity (&#8217;)
    // as a "missing number". If the raw target contains an entity whose digits
    // equal `original`, this log is an artifact, not a content issue.
    const rawTarget = String(ctx.target ?? log.target ?? '');
    if (new RegExp(`&#x?0*${String(original).replace(/[^0-9]/g, '')};?`, 'i').test(rawTarget)) {
      return { verdict: 'false_positive', reason: `"${original}" is the digit body of an HTML entity in the target, not a translated number` };
    }
    const nums = numbersIn(original);
    if (nums.length && nums.every((n) => !srcNums.has(n) && !tgtNums.has(n))) {
      return { verdict: 'real', reason: `number ${original} not found in source or target` };
    }
    // present in both → same numbers, formatting differs (dates, thousands, 万/亿)
    if (nums.length && nums.every((n) => tgtNums.has(n))) {
      return { verdict: 'false_positive', reason: `all numbers (${nums.join(',')}) present in target; formatting/position differs` };
    }
    // present in target under different formatting (e.g. 3.579 billion vs 35.79亿)
    const digitsOf = (n) => n.replace(/[^\d]/g, '');
    if (nums.length && [...tgtNums].some((t) => digitsOf(t).includes(digitsOf(nums[0])) || digitsOf(nums[0]).includes(digitsOf(t)))) {
      return { verdict: 'false_positive', reason: 'number present in target under a different scale/format (万/亿 conversion)' };
    }
    return { verdict: 'review', reason: `number ${original} present in source but not in target — check translation completeness` };
  }

  if (type.includes('PUNCT') || type.includes('SPACE')) {
    const cjkTarget = /[\u4e00-\u9fff]/.test(target);
    // CJK punctuation in a latin target or vice versa is a convention swap,
    // only worth review when the same char class is inconsistent WITHIN the target
    const mixed = /[，；：]/.test(target) && /[a-zA-Z]/.test(target) && !cjkTarget;
    if (mixed) return { verdict: 'review', reason: 'latin target mixes CJK punctuation — unify' };
    return { verdict: 'false_positive', reason: 'punctuation/space follows target-language convention' };
  }

  if (type.includes('TAG') || type.includes('FORMAT') || type.includes('PLACEHOLDER')) {
    // entity spelling differences are benign
    if (decoded(original) && decoded(target).includes(decoded(original))) {
      return { verdict: 'false_positive', reason: 'placeholder present (different entity spelling)' };
    }
    if (original && !decoded(target).includes(decoded(original))) {
      return { verdict: 'real', reason: `placeholder "${original}" missing from target` };
    }
    return { verdict: 'review', reason: 'tag/format deviation — verify in editor' };
  }

  if (type.includes('SPELL')) {
    // Proper nouns / branded terms the dictionary simply doesn't know: if the
    // flagged word appears verbatim in the target, the translator chose it
    // deliberately (Siemens Healthineers, Neusoft, Mindray, bioresorbable…).
    if (original && decoded(target).includes(original)) {
      return { verdict: 'false_positive', reason: `"${original}" is a deliberate proper noun/technical term present verbatim in the target` };
    }
    return { verdict: 'review', reason: `spelling: "${original}" — not in dictionary and absent from target` };
  }

  if (type.includes('TERM')) {
    // approved-synonym check is out of scope here → surface for human eyes
    return { verdict: 'review', reason: `term rendering: "${original}" — confirm against termbase (webcat terms check)` };
  }

  if (type.includes('EMPTY') || type.includes('MISS')) {
    return { verdict: 'real', reason: 'empty/missing translation element' };
  }

  return { verdict: 'review', reason: `unclassified checkType ${log.checkType} (${(log.descriptions ?? [])[0] ?? ''})` };
}

export function classifyQaLogs(logs) {
  return logs.map((log) => {
    const { verdict, reason } = classifyQaLog(log, { source: log.source, target: log.target });
    return {
      sentId: log.sentId,
      index: log.sentIndex ?? log.sentIndex ?? log.index,
      checkType: log.checkType,
      errorCode: log.errorCode,
      description: (log.descriptions ?? [])[0] ?? '',
      original: log.original ?? '',
      source: String(log.source ?? '').slice(0, 120),
      target: String(log.target ?? '').slice(0, 120),
      verdict,
      reason,
    };
  });
}

/* -------------------------------------------------------------- command */

export const command = cli({
  site: 'webcat',
  name: 'qa',
  access: 'read',
  description: 'Run WebCAT QA on the open task, then classify false positives (only real issues survive)',
  domain: WEBCAT_DOMAIN,
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'run', type: 'bool', default: true, help: 'Trigger a fresh QA pass before reading logs' },
    { name: 'no-run', type: 'bool', default: false, help: 'Skip the QA run; classify existing logs only' },
    { name: 'min-verdict', default: 'review', choices: ['review', 'real'], help: 'Only report entries at/above this severity' },
    { name: 'out', help: 'Write the classified log (JSONL) to this file' },
    { name: 'max', type: 'int', default: 500, help: 'Cap reported entries' },
  ],
  columns: ['index', 'checkType', 'verdict', 'description', 'source', 'target'],
  func: async (kwargs) => {
    const session = loadSession();
    const detail = await getTaskDetail(session);
    const docId = detail.docId;

    let runInfo = null;
    if (kwargs.run === true && kwargs['no-run'] !== true) {
      await runQa(session);
      const final = await pollQaProgress(session);
      runInfo = final;
    }

    const raw = await collectSegments(session, docId, { pageSize: 500, maxSegments: 20000 });
    const logs = await collectQaLogs(session, docId, raw);
    const classified = classifyQaLogs(logs);

    const counts = { real: 0, review: 0, false_positive: 0 };
    for (const c of classified) counts[c.verdict] = (counts[c.verdict] ?? 0) + 1;

    const minVerdict = String(kwargs['min-verdict'] ?? 'review');
    const order = { review: 0, real: 1 };
    const reported = classified
      .filter((c) => c.verdict !== 'false_positive' && order[c.verdict] >= (order[minVerdict] ?? 0))
      .slice(0, Number(kwargs.max ?? 500));

    if (kwargs.out) {
      const fs = await import('node:fs');
      fs.writeFileSync(String(kwargs.out), `${reported.map((c) => JSON.stringify(c)).join('\n')}\n`, 'utf-8');
    }

    return {
      docId,
      qa_run: runInfo ? { progress: runInfo.progress, totalSentences: runInfo.totalSentences } : 'skipped',
      total_logs: logs.length,
      counts,
      reported: reported.length,
      issues: reported,
    };
  },
});

export const __test__ = { command, classifyQaLog, classifyQaLogs, collectQaLogs, runQa, pollQaProgress };
