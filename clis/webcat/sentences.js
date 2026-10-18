/**
 * `opencli webcat sentences` — read the open document's segments.
 *
 * Returns bilingual segment records (source / target / status / tags) that an
 * agent can translate and hand back to `opencli webcat fill`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  WEBCAT_DEFAULT_PAGE_SIZE,
  WEBCAT_DOMAIN,
  WEBCAT_MAX_PAGE_SIZE,
  flowGetSentence,
  getTaskDetail,
  loadSession,
  normalizeSegment,
  segmentMatchesFilter,
} from './_api.js';

const HARD_SEGMENT_CAP = 20_000;

function parsePositiveInt(value, name, fallback, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new ArgumentError(`--${name} must be a positive integer`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new ArgumentError(`--${name} must be between 1 and ${max}`);
  }
  return parsed;
}

/**
 * Fetch the whole document by paging in both directions from the page the
 * server decides to start at, so the result does not depend on where the
 * browser last left the cursor.
 */
export async function collectSegments(session, docId, { pageSize, maxSegments, fetchImpl = fetch } = {}) {
  const base = {
    docId,
    pageSize,
    splitIndex: session.splitIndex || '0',
    filterEmptySourceAndTarget: true,
  };
  const ordered = [];
  const seen = new Set();
  const push = (list, prepend) => {
    const fresh = [];
    for (const dto of list) {
      const sentId = String(dto?.sentId ?? '');
      if (!sentId || seen.has(sentId)) continue;
      seen.add(sentId);
      fresh.push(dto);
    }
    if (prepend) ordered.unshift(...fresh.reverse());
    else ordered.push(...fresh);
    return fresh.length;
  };

  const initial = await flowGetSentence(session, { ...base }, fetchImpl);
  push(initial.list, false);

  if (!initial.isBottom) {
    let cursor = String(initial.list[initial.list.length - 1]?.sentId ?? '');
    while (cursor && ordered.length < maxSegments) {
      const page = await flowGetSentence(session, { ...base, pullSentId: cursor, pullDirection: 'Down' }, fetchImpl);
      if (page.list.length === 0) break;
      push(page.list, false);
      if (page.isBottom) break;
      const next = String(page.list[page.list.length - 1]?.sentId ?? '');
      if (!next || next === cursor) break;
      cursor = next;
    }
  }

  if (!initial.isTop) {
    let cursor = String(initial.list[0]?.sentId ?? '');
    while (cursor && ordered.length < maxSegments) {
      const page = await flowGetSentence(session, { ...base, pullSentId: cursor, pullDirection: 'Up' }, fetchImpl);
      if (page.list.length === 0) break;
      push(page.list, true);
      if (page.isTop) break;
      const next = String(page.list[0]?.sentId ?? '');
      if (!next || next === cursor) break;
      cursor = next;
    }
  }

  return ordered.slice(0, maxSegments);
}

function readTranslationsFile(file) {
  const resolved = path.resolve(String(file));
  if (!fs.existsSync(resolved)) throw new ArgumentError(`Translation file not found: ${resolved}`);
  const text = fs.readFileSync(resolved, 'utf-8').trim();
  if (!text) throw new ArgumentError(`Translation file is empty: ${resolved}`);
  let parsed;
  const firstNonWs = text.slice(0, 200).replace(/^\s+/, '');
  if (firstNonWs.startsWith('[')) {
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ArgumentError(`Translation file is not valid JSON: ${resolved}`, String(error));
    }
  } else if (firstNonWs.startsWith('{')) {
    // Could be one JSON object or JSON Lines (one object per line). Try whole
    // file first; on failure fall back to per-line parsing.
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = [];
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        try {
          parsed.push(JSON.parse(lines[i]));
        } catch (error) {
          throw new ArgumentError(`Translation file line ${i + 1} is not valid JSON`, String(error));
        }
      }
    }
  } else {
    parsed = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new ArgumentError(`Translation file line ${index + 1} is not valid JSON`, String(error));
        }
      });
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.translations)) return parsed.translations;
    // { "sentId": "text", ... } shorthand
    return Object.entries(parsed).map(([sentId, value]) => (typeof value === 'string' ? { sentId, text: value } : { sentId, ...value }));
  }
  throw new ArgumentError(`Unsupported translation file shape: ${resolved}`);
}

export { readTranslationsFile };

export const command = cli({
  site: 'webcat',
  name: 'sentences',
  access: 'read',
  description: 'Read WebCAT segments (source, target, status, inline tags) for the open document',
  domain: WEBCAT_DOMAIN,
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'filter', default: 'all', help: 'all | untranslated | translated | unconfirmed | confirmed | locked | unlocked' },
    { name: 'limit', type: 'int', help: 'Stop after this many segments (default: whole document)' },
    { name: 'page-size', type: 'int', default: WEBCAT_DEFAULT_PAGE_SIZE, help: `Segments per API page (1-${WEBCAT_MAX_PAGE_SIZE})` },
    { name: 'ids', help: 'Only these sentIds, comma separated' },
    { name: 'out', help: 'Also write the segments as JSON Lines to this file' },
    { name: 'strip-html', type: 'bool', default: false, help: 'Drop sourceHtml/targetHtml to keep the payload small' },
  ],
  columns: ['sentId', 'index', 'status', 'locked', 'source', 'target'],
  footerExtra: (kwargs) => `filter=${kwargs.filter ?? 'all'}`,
  func: async (kwargs) => {
    const session = loadSession();
    const detail = await getTaskDetail(session);
    const docId = detail.docId;
    if (!docId) throw new CommandExecutionError('WebCAT task detail has no docId');

    const pageSize = parsePositiveInt(kwargs['page-size'], 'page-size', WEBCAT_DEFAULT_PAGE_SIZE, WEBCAT_MAX_PAGE_SIZE);
    const requestedLimit = kwargs.limit ? parsePositiveInt(kwargs.limit, 'limit', undefined, 200_000) : 0;
    const maxSegments = requestedLimit > 0 ? requestedLimit : HARD_SEGMENT_CAP;
    const wantedIds = String(kwargs.ids ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    const dtos = await collectSegments(session, docId, { pageSize, maxSegments });
    let segments = dtos.map((dto, position) => normalizeSegment(dto, position));
    if (wantedIds.length > 0) {
      const wanted = new Set(wantedIds);
      segments = segments.filter((segment) => wanted.has(segment.sentId));
      if (segments.length === 0) {
        throw new EmptyResultError('webcat sentences', `None of the requested sentIds exist in document ${docId}`);
      }
    } else {
      segments = segments.filter((segment) => segmentMatchesFilter(segment, kwargs.filter ?? 'all'));
    }

    if (kwargs['strip-html'] === true) {
      segments = segments.map(({ sourceHtml, targetHtml, ...rest }) => rest);
    }

    const out = String(kwargs.out ?? '').trim();
    if (out) {
      const resolved = path.resolve(out);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, `${segments.map((segment) => JSON.stringify(segment)).join('\n')}\n`, 'utf-8');
    }

    if (segments.length === 0) {
      return [];
    }
    return segments;
  },
});

export const __test__ = { command, collectSegments, parsePositiveInt };
