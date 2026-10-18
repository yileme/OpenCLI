/**
 * `opencli webcat fill` — bulk write translations into the open WebCAT document.
 *
 * Mirrors the editor's own "batch save target" call:
 *   POST /api/sentence/webcatSentence/batch-save-target
 *   body: data=<json string {docId, data:[{sentId,indexId,targetPlaceholder,targetText,...}]}>
 *
 * Input: a JSON array, JSON Lines file, or `{sentId: text}` map with
 * `{sentId, text}` / `{sentId, html}` entries — exactly what an agent produces
 * after reading `opencli webcat sentences`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  WEBCAT_DOMAIN,
  buildTargetItem,
  flowGetSentence,
  getTaskDetail,
  htmlToPlain,
  loadSession,
  normalizeSegment,
  webcatFetch,
} from './_api.js';
import { readTranslationsFile } from './sentences.js';

const ID_CHUNK = 100;

export function normalizeForCompare(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => codePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function codePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

export async function fetchSegmentsByIds(session, docId, ids, fetchImpl = fetch) {
  const map = new Map();
  const wanted = new Set(ids.map(String));
  for (let index = 0; index < ids.length; index += ID_CHUNK) {
    const chunk = ids.slice(index, index + ID_CHUNK);
    // The server caps how many ids `sentIds` honors per call; request fewer per
    // call and also ask for a page size that can hold the whole chunk.
    for (let sub = 0; sub < chunk.length; sub += 25) {
      const subChunk = chunk.slice(sub, sub + 25);
      const page = await flowGetSentence(session, {
        docId,
        sentIds: subChunk.join(','),
        pageSize: subChunk.length,
        splitIndex: session.splitIndex || '0',
      }, fetchImpl);
      for (const dto of page.list) {
        const sentId = String(dto?.sentId ?? '');
        if (sentId && wanted.has(sentId)) map.set(sentId, dto);
      }
    }
  }
  return map;
}

export async function pushTargets(session, docId, items, { chunkSize = 50, saveSnapshot = false, fetchImpl = fetch } = {}) {
  const results = [];
  chunkSizeGuard(chunkSize);
  for (let index = 0; index < items.length; index += chunkSize) {
    const chunk = items.slice(index, index + chunkSize);
    const envelope = await webcatFetch('/sentence/webcatSentence/batch-save-target', {
      session,
      fetchImpl,
      data: {
        data: JSON.stringify({ docId, data: chunk }),
        saveSnapshot,
      },
    });
    results.push({ chunk: chunk.length, envelope });
  }
  return results;
}

function chunkSizeGuard(chunkSize) {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 500) {
    throw new ArgumentError('--chunk must be between 1 and 500');
  }
  return chunkSize;
}

/**
 * Chunk-level retry: a failed chunk is retried with backoff; chunks that keep
 * failing are reported so the caller can re-run (fill is diff-only, so a
 * re-run skips everything already written — that is the resume mechanism).
 */
export async function pushTargetsResilient(session, docId, items, { chunkSize = 50, saveSnapshot = false, retries = 2, fetchImpl = fetch } = {}) {
  const failed = [];
  chunkSizeGuard(chunkSize);
  for (let index = 0; index < items.length; index += chunkSize) {
    const chunk = items.slice(index, index + chunkSize);
    let done = false;
    let lastError = null;
    for (let attempt = 0; attempt <= retries && !done; attempt++) {
      try {
        await webcatFetch('/sentence/webcatSentence/batch-save-target', {
          session,
          fetchImpl,
          data: { data: JSON.stringify({ docId, data: chunk }), saveSnapshot },
        });
        done = true;
      } catch (error) {
        lastError = error;
        if (error instanceof AuthRequiredError) throw error; // no point retrying auth
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    if (!done) failed.push({ from: index, count: chunk.length, error: String(lastError?.message ?? lastError) });
  }
  if (failed.length) {
    throw new CommandExecutionError(
      `${failed.length} chunk(s) failed after ${retries + 1} attempt(s); re-run the same command to resume (already-written segments are skipped).`,
      failed.map((f) => f.error).slice(0, 3).join(' | '),
    );
  }
  return { chunks: Math.ceil(items.length / chunkSize) };
}

export function getBackupDir() {
  return process.env.WEBCAT_BACKUP_DIR || path.join(os.homedir(), '.opencli', 'webcat-backups');
}

/** Snapshot {sentId: {targetPlaceholder,targetText}} before a write. */
export function writeBackup(docId, segmentMap) {
  const dir = getBackupDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${String(docId).replace(/[^a-zA-Z0-9_-]/g, '_')}-${stamp}.json`);
  const payload = {};
  for (const [sentId, dto] of segmentMap.entries()) {
    payload[sentId] = {
      targetPlaceholder: dto?.targetPlaceholder ?? '',
      targetText: dto?.targetText ?? '',
    };
  }
  fs.writeFileSync(file, JSON.stringify({ docId, savedAt: new Date().toISOString(), segments: payload }, null, 1), 'utf-8');
  return file;
}

export const command = cli({
  site: 'webcat',
  name: 'fill',
  access: 'write',
  description: 'Write translations into the open WebCAT document (batch save target)',
  domain: WEBCAT_DOMAIN,
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'file', help: 'JSON / JSONL / {sentId: text} file with the translations to write' },
    { name: 'sent-id', help: 'Single segment sentId (use together with --text)' },
    { name: 'text', help: 'Plain-text translation for --sent-id' },
    { name: 'chunk', type: 'int', default: 50, help: 'Segments per batch-save-target request' },
    { name: 'keep-locked', type: 'bool', default: false, help: 'Also write segments the task has locked (default: skip them)' },
    { name: 'snapshot', type: 'bool', default: false, help: 'Ask WebCAT to store a snapshot before writing' },
    { name: 'verify', type: 'bool', default: true, help: 'Re-read the written segments and report mismatches' },
    { name: 'dry-run', type: 'bool', default: false, help: 'Validate the payload and stop before writing' },
    { name: 'force', type: 'bool', default: false, help: 'Rewrite segments even when the target already matches (default: skip, making fill idempotent)' },
    { name: 'backup', type: 'bool', default: true, help: 'Snapshot current targets to ~/.opencli/webcat-backups/ before writing' },
    { name: 'no-backup', type: 'bool', default: false, help: 'Skip the pre-write backup snapshot' },
  ],
  columns: ['docId', 'requested', 'updated', 'skipped_identical', 'skipped_locked', 'verified', 'mismatch_count'],
  func: async (kwargs) => {
    const session = loadSession();
    const detail = await getTaskDetail(session);
    const docId = detail.docId;
    if (!docId) throw new CommandExecutionError('WebCAT task detail has no docId');

    let translations;
    if (kwargs.file) {
      translations = readTranslationsFile(kwargs.file);
    } else if (kwargs['sent-id'] || kwargs.text) {
      if (!kwargs['sent-id'] || kwargs.text === undefined) {
        throw new ArgumentError('--sent-id and --text must be used together');
      }
      translations = [{ sentId: kwargs['sent-id'], text: kwargs.text }];
    } else {
      throw new ArgumentError('Nothing to write', 'Pass --file <path> (JSON/JSONL) or --sent-id with --text.');
    }

    const normalised = translations.map((entry) => {
      if (typeof entry === 'string') throw new ArgumentError('Each translation needs a sentId and text/html field');
      const sentId = String(entry?.sentId ?? entry?.id ?? '').trim();
      if (!sentId) throw new ArgumentError('Each translation needs a sentId');
      const plain = entry.text ?? entry.target ?? entry.translation;
      const html = entry.html ?? entry.targetHtml;
      if (plain === undefined && html === undefined) throw new ArgumentError(`Translation for ${sentId} needs "text" or "html"`);
      return { ...entry, sentId };
    });

    const chunkSize = Number(kwargs.chunk ?? 50);
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 500) {
      throw new ArgumentError('--chunk must be between 1 and 500');
    }

    const ids = [...new Set(normalised.map((entry) => entry.sentId))];
    const segmentMap = await fetchSegmentsByIds(session, docId, ids);
    const missing = ids.filter((sentId) => !segmentMap.has(sentId));

    const items = [];
    const skippedLocked = [];
    const skippedIdentical = [];
    for (const entry of normalised) {
      const dto = segmentMap.get(entry.sentId);
      const segment = dto ? normalizeSegment(dto) : null;
      if (segment?.locked && kwargs['keep-locked'] !== true) {
        skippedLocked.push(entry.sentId);
        continue;
      }
      const item = buildTargetItem(entry, segment ?? { sentId: entry.sentId });
      if (kwargs.force !== true && segment && normalizeForCompare(item.targetText) === normalizeForCompare(segment.target)) {
        skippedIdentical.push(entry.sentId);
        continue;
      }
      items.push(item);
    }

    const expected = new Map(items.map((item) => [item.sentId, normalizeForCompare(item.targetText)]));

    if (kwargs['dry-run'] === true) {
      return {
        docId,
        dry_run: true,
        requested: normalised.length,
        updated: 0,
        missing_sent_ids: missing,
        skipped_identical: skippedIdentical,
        skipped_locked: skippedLocked,
        preview: items.slice(0, 20),
      };
    }

    let backupFile = null;
    if (items.length > 0 && kwargs.backup === true && kwargs['no-backup'] !== true) {
      backupFile = writeBackup(docId, segmentMap);
    }

    if (items.length > 0) {
      await pushTargetsResilient(session, docId, items, { chunkSize, saveSnapshot: kwargs.snapshot === true });
    }

    let verify = null;
    if (kwargs.verify !== false && items.length > 0) {
      const reread = await fetchSegmentsByIds(session, docId, items.map((item) => item.sentId));
      const mismatches = [];
      let verified = 0;
      for (const item of items) {
        const dto = reread.get(item.sentId);
        if (!dto) {
          mismatches.push({ sentId: item.sentId, expected: expected.get(item.sentId), actual: null, reason: 'segment missing after write' });
          continue;
        }
        const actual = normalizeForCompare(htmlToPlain(dto.targetPlaceholder ?? dto.targetText));
        if (actual === expected.get(item.sentId)) verified += 1;
        else mismatches.push({ sentId: item.sentId, expected: expected.get(item.sentId), actual });
      }
      verify = { verified, mismatches };
    }

    return {
      docId,
      requested: normalised.length,
      updated: items.length,
      missing_sent_ids: missing,
      skipped_identical: skippedIdentical,
      skipped_locked: skippedLocked,
      backup_file: backupFile,
      verified: verify ? verify.verified : null,
      mismatch_count: verify ? verify.mismatches.length : null,
      mismatches: verify ? verify.mismatches.slice(0, 50) : [],
    };
  },
});

export const __test__ = { command, fetchSegmentsByIds, normalizeForCompare, pushTargets, pushTargetsResilient, writeBackup, getBackupDir };
