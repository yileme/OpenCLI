/**
 * Shared client for WebCAT (云译客 / iol8.com online CAT editor).
 *
 * The editor at https://webcat-dl.iol8.com is a Vue SPA that talks to
 * `POST https://webcat-dl.iol8.com/api/...` with:
 *   - a hard-coded HTTP Basic client credential (same for every browser tab),
 *   - a `ck` header taken from the editor URL query string,
 *   - the user session carried by cookies (CASID/ck/... on `.iol8.com`).
 *
 * So a CLI can drive the editor directly over HTTP: harvest the cookies once
 * (`opencli webcat login`), keep the task URL (`opencli webcat open <url>`),
 * then read and write segments like the web UI does.
 *
 * Endpoint contract recovered from the production bundle (app.*.js):
 *   POST /task/info/getTaskDetail                      -> task detail (docId, taskId, langs, ...)
 *   POST /sentence/webcatSentence/sumSentenceCount      -> { total, filterTotal, ... }
 *   POST /sentence/webcatSentence/flowGetSentence       -> { data: { data: [sentenceDTO], isTop, isBottom } }
 *   POST /sentence/webcatSentence/batch-save-target     -> bulk write targets (data = JSON string)
 *   POST /sentence/webcatSentence/commit                -> write one sentence DTO
 *   POST /sentence/webcatSentence/confirmSentences      -> { docId, sentIds, isConfirm }
 *   POST /task/info/finishTask                          -> { taskId, status: 3 }
 *   POST /sentence/sentence-check/all                   -> QA check
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  ConfigError,
  getErrorMessage,
} from '@jackwener/opencli/errors';

export const WEBCAT_WEB_ORIGIN = 'https://webcat-dl.iol8.com';
export const WEBCAT_API_BASE = `${WEBCAT_WEB_ORIGIN}/api`;
export const WEBCAT_DOMAIN = 'webcat-dl.iol8.com';
export const WEBCAT_COOKIE_SUFFIX = 'iol8.com';
/** Client credential hard-coded in the WebCAT bundle (`webcat-server:...`). */
export const WEBCAT_BASIC_AUTH = 'Basic d2ViY2F0LXNlcnZlcjplNmx0b2plRlVVRG0=';
export const WEBCAT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
/** errorCode values the SPA treats as "session invalid, log in again". */
export const WEBCAT_AUTH_ERROR_CODES = new Set(['000005', '420021']);
export const WEBCAT_DEFAULT_PAGE_SIZE = 200;
export const WEBCAT_MAX_PAGE_SIZE = 500;

export function getWebcatSessionFile() {
  return process.env.WEBCAT_SESSION_FILE || path.join(os.homedir(), '.opencli', 'webcat.json');
}

function sessionHint() {
  return `Run \`opencli webcat login\` (opens a Chrome window you sign in with) or \`opencli webcat open "<editor url>"\`.`;
}

export function createWebcatAuthError(message) {
  return new AuthRequiredError(WEBCAT_DOMAIN, `${message}. ${sessionHint()}`);
}

function normalizeCookie(cookie) {
  if (!cookie || typeof cookie !== 'object') return null;
  const name = String(cookie.name ?? '').trim();
  if (!name || cookie.value === undefined || cookie.value === null) return null;
  return {
    name,
    value: String(cookie.value),
    domain: String(cookie.domain ?? `.${WEBCAT_COOKIE_SUFFIX}`),
    path: String(cookie.path ?? '/'),
  };
}

export function normalizeCookies(cookies) {
  const byName = new Map();
  for (const raw of Array.isArray(cookies) ? cookies : []) {
    const cookie = normalizeCookie(raw);
    if (!cookie) continue;
    const domain = cookie.domain.replace(/^\./, '');
    if (!(domain === WEBCAT_COOKIE_SUFFIX || domain.endsWith(`.${WEBCAT_COOKIE_SUFFIX}`))) continue;
    // Prefer the most specific domain when the same cookie name shows up twice.
    const existing = byName.get(cookie.name);
    if (!existing || cookie.domain.length > existing.domain.length) byName.set(cookie.name, cookie);
  }
  return [...byName.values()];
}

export function cookieHeaderOf(session) {
  return (session?.cookies ?? [])
    .filter((cookie) => cookie?.name && cookie.value !== undefined && cookie.value !== null && cookie.value !== '')
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

/**
 * Parse a WebCAT editor URL such as
 *   https://webcat-dl.iol8.com/?ck=<session>&isPreview=false&splitIndex=0&isCorpus=false&r=<req>#/project
 */
export function parseEditorUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new ArgumentError('A WebCAT editor URL is required');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ArgumentError(`Not a valid URL: ${raw}`);
  }
  const origin = url.origin.replace(/\/+$/, '');
  if (!/^https:\/\/([a-z0-9-]+\.)*iol8\.com$/i.test(origin)) {
    throw new ArgumentError(`Expected a iol8.com WebCAT URL, got: ${origin}`);
  }
  const ck = url.searchParams.get('ck') || '';
  if (!ck) throw new ArgumentError('The editor URL has no `ck` query parameter; copy the URL straight from the WebCAT browser tab.');
  return {
    url: raw,
    origin,
    ck,
    r: url.searchParams.get('r') || '',
    splitIndex: url.searchParams.get('splitIndex') || '0',
    isPreview: url.searchParams.get('isPreview') || '',
    isCorpus: url.searchParams.get('isCorpus') || '',
  };
}

export function normalizeSession(raw) {
  const cookies = normalizeCookies(raw?.cookies);
  const url = String(raw?.url ?? '').trim();
  let ck = String(raw?.ck ?? '').trim();
  if (!ck && url) {
    try {
      ck = parseEditorUrl(url).ck;
    } catch {
      ck = '';
    }
  }
  return {
    baseUrl: String(raw?.baseUrl ?? WEBCAT_WEB_ORIGIN).replace(/\/+$/, ''),
    ck,
    r: String(raw?.r ?? ''),
    splitIndex: String(raw?.splitIndex ?? '0'),
    url,
    cookies,
    docId: String(raw?.docId ?? ''),
    taskId: String(raw?.taskId ?? ''),
    userCasId: String(raw?.userCasId ?? ''),
    savedAt: String(raw?.savedAt ?? ''),
  };
}

export function loadSession({ required = true } = {}) {
  const file = getWebcatSessionFile();
  if (!fs.existsSync(file)) {
    if (!required) return null;
    throw new ConfigError(`No WebCAT session found at ${file}`, sessionHint());
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (error) {
    throw new ConfigError(`Failed to parse WebCAT session file ${file}`, `Delete the file and run \`opencli webcat login\`. (${getErrorMessage(error)})`);
  }
  const session = normalizeSession(parsed);
  if (!required) return session;
  if (!session.ck) throw createWebcatAuthError('The saved WebCAT session has no `ck` (task key)');
  if (session.cookies.length === 0) throw createWebcatAuthError('The saved WebCAT session has no iol8.com cookies');
  return session;
}

export function saveSession(next) {
  const file = getWebcatSessionFile();
  const session = normalizeSession({ ...next, savedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(session, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort on filesystems without POSIX modes
  }
  return session;
}

function encodeFormBody(data) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'object') params.append(key, JSON.stringify(value));
    else params.append(key, typeof value === 'boolean' ? String(value) : String(value));
  }
  return params.toString();
}

export function buildHeaders(session, { json = false } = {}) {
  const headers = {
    Authorization: WEBCAT_BASIC_AUTH,
    ck: String(session.ck),
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'User-Agent': WEBCAT_USER_AGENT,
    Origin: WEBCAT_WEB_ORIGIN,
    Referer: session.url || `${WEBCAT_WEB_ORIGIN}/`,
  };
  const cookieHeader = cookieHeaderOf(session);
  if (cookieHeader) headers.Cookie = cookieHeader;
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

export function describeEnvelope(envelope) {
  const code = envelope?.errorCode ? ` [${envelope.errorCode}]` : '';
  const message = envelope?.errorMsg || envelope?.message || 'unknown WebCAT error';
  return `${message}${code}`;
}

/**
 * Call a WebCAT API path and return the response envelope
 * (`{ result, data, errorCode, errorMsg, success }`).
 */
export async function webcatFetch(apiPath, options = {}) {
  const {
    method = 'POST',
    data,
    json = false,
    session,
    fetchImpl = fetch,
    timeoutMs = 30_000,
    query,
  } = options;

  if (!session?.ck) throw createWebcatAuthError('WebCAT session is missing the `ck` task key');

  // WEBCAT_BASE_URL exists for tests / self-hosted regions; production always
  // targets the origin stored in the session (from the editor URL).
  const baseUrl = process.env.WEBCAT_BASE_URL || session.baseUrl || WEBCAT_WEB_ORIGIN;
  let url = `${baseUrl.replace(/\/+$/, '')}/api${apiPath}`;
  if (query) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      search.append(key, String(value));
    }
    const qs = search.toString();
    if (qs) url += `${url.includes('?') ? '&' : '?'}${qs}`;
  }

  const upper = method.toUpperCase();
  const headers = buildHeaders(session, { json: json && upper !== 'GET' });
  let body;
  if (upper !== 'GET' && upper !== 'HEAD' && data !== undefined) {
    if (json) body = JSON.stringify(data);
    else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = encodeFormBody(data);
    }
  }

  let response;
  try {
    response = await fetchImpl(url, { method: upper, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new CommandExecutionError(`WebCAT request ${apiPath} failed: ${getErrorMessage(error)}`);
  }

  const text = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw createWebcatAuthError(`WebCAT rejected the request with HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new CommandExecutionError(`WebCAT request ${apiPath} returned HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
  }

  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch (error) {
    throw new CommandExecutionError(`WebCAT request ${apiPath} returned invalid JSON: ${getErrorMessage(error)} (${text.slice(0, 200)})`);
  }

  const code = envelope?.errorCode === undefined || envelope?.errorCode === null ? '' : String(envelope.errorCode);
  if (code && code !== '0') {
    if (WEBCAT_AUTH_ERROR_CODES.has(code)) {
      throw createWebcatAuthError(`WebCAT session is no longer valid (${describeEnvelope(envelope)})`);
    }
    throw new CommandExecutionError(`WebCAT API error on ${apiPath}: ${describeEnvelope(envelope)}`);
  }
  if (envelope?.success === false) {
    throw new CommandExecutionError(`WebCAT API error on ${apiPath}: ${describeEnvelope(envelope)}`);
  }
  return envelope ?? {};
}

export function payloadOf(envelope) {
  if (envelope && typeof envelope === 'object' && 'data' in envelope) return envelope.data;
  return envelope;
}

export async function getTaskDetail(session, fetchImpl = fetch) {
  const envelope = await webcatFetch('/task/info/getTaskDetail', { session, fetchImpl });
  const detail = payloadOf(envelope);
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
    throw new CommandExecutionError('WebCAT returned a malformed task detail');
  }
  return detail;
}

export async function sumSentenceCount(session, { docId, splitIndex } = {}, fetchImpl = fetch) {
  const envelope = await webcatFetch('/sentence/webcatSentence/sumSentenceCount', {
    session,
    fetchImpl,
    data: { docId, splitIndex: splitIndex ?? session.splitIndex ?? '0' },
  });
  return payloadOf(envelope) ?? {};
}

export async function flowGetSentence(session, params, fetchImpl = fetch) {
  const envelope = await webcatFetch('/sentence/webcatSentence/flowGetSentence', {
    session,
    fetchImpl,
    data: params,
  });
  const page = payloadOf(envelope);
  if (!page || typeof page !== 'object') {
    throw new CommandExecutionError('WebCAT returned a malformed sentence page');
  }
  return {
    list: Array.isArray(page.data) ? page.data : [],
    isTop: page.isTop === true,
    isBottom: page.isBottom === true,
  };
}

/* ------------------------------------------------------------------ */
/* Segment helpers                                                    */
/* ------------------------------------------------------------------ */

const NAMED_ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&middot;': '·',
};

export function decodeEntities(html) {
  return String(html ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&[a-z]+;|&#39;/gi, (entity) => NAMED_ENTITIES[entity.toLowerCase()] ?? entity);
}

function safeFromCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Strip WebCAT markup down to the translator-visible text. */
export function htmlToPlain(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr)>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  );
}

/** Escape a plain translation into the HTML fragment WebCAT stores in `targetPlaceholder`. */
export function plainToHtml(text) {
  const escaped = String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '<br>')
    .replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;');
}

/** Inline tag fragments (images / styled spans) that a target must keep. */
export function extractTagTokens(html) {
  const tokens = [];
  const seen = new Set();
  const matches = String(html ?? '').match(/<[^>]+>/g) ?? [];
  for (const token of matches) {
    if (/^<\/?(br|p|div|li|tr|span|b|i|u|em|strong)\b/i.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

export function normalizeSegment(dto, index = 0) {
  const sourceHtml = String(dto?.sourcePlaceholder ?? dto?.sourceText ?? '');
  const targetHtml = String(dto?.targetPlaceholder ?? dto?.targetText ?? '');
  const source = dto?.sourceText ? String(dto.sourceText) : htmlToPlain(sourceHtml);
  const target = dto?.targetText ? String(dto.targetText) : htmlToPlain(targetHtml);
  const isConfirm = dto?.isConfirm === true || dto?.confirm === true;
  const status = isConfirm ? 'confirmed' : target.trim() ? 'translated' : 'untranslated';
  return {
    sentId: String(dto?.sentId ?? ''),
    index: dto?.serialNum ?? index + 1,
    status,
    isConfirm,
    locked: dto?.locked === true || dto?.isLocked === true,
    source,
    target,
    sourceHtml,
    targetHtml,
    sourceTags: extractTagTokens(sourceHtml),
    sourceLangId: dto?.sourceLangId,
    targetLangId: dto?.targetLangId,
    targetFrom: dto?.targetFrom ?? '',
    wordCount: dto?.wordCount ?? dto?.sourceWordCount ?? 0,
    updateTargetTime: dto?.updateTargetTime ?? dto?.updateSourceTime ?? 0,
    ...(dto?.groupParentId ? { groupParentId: dto.groupParentId } : {}),
  };
}

export function segmentMatchesFilter(segment, filter) {
  switch (String(filter ?? 'all').toLowerCase()) {
    case 'all':
      return true;
    case 'untranslated':
    case 'todo':
      return segment.status === 'untranslated';
    case 'translated':
      return segment.status !== 'untranslated';
    case 'unconfirmed':
      return segment.status === 'translated';
    case 'confirmed':
      return segment.status === 'confirmed';
    case 'locked':
      return segment.locked === true;
    case 'unlocked':
      return segment.locked !== true;
    default:
      throw new ArgumentError(`Unsupported --filter value: ${filter} (use all|untranslated|translated|unconfirmed|confirmed|locked|unlocked)`);
  }
}

/** Build one element of the `batch-save-target` payload. */
export function buildTargetItem(item, segment) {
  const sentId = String(item?.sentId ?? item?.id ?? segment?.sentId ?? '').trim();
  if (!sentId) throw new ArgumentError('Each translation needs a sentId');
  const plain = item?.text ?? item?.target ?? item?.translation;
  const rawHtml = item?.html ?? item?.targetHtml;
  if (plain === undefined && rawHtml === undefined) {
    throw new ArgumentError(`Translation for ${sentId} needs a "text" (or "html") field`);
  }
  const targetHtml = rawHtml !== undefined ? String(rawHtml) : plainToHtml(plain);
  const targetText = item?.targetText !== undefined ? String(item.targetText) : htmlToPlain(targetHtml);
  return {
    sentId,
    indexId: String(item?.indexId ?? segment?.sentId ?? sentId),
    targetPlaceholder: targetHtml,
    sourceHasChange: false,
    targetHasChange: true,
    targetText,
  };
}

export function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
