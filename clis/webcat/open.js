/**
 * `opencli webcat open "<editor url>"` — point the CLI at another WebCAT task document.
 *
 * The task key lives in the editor URL query string (`?ck=...`), and the iol8.com
 * cookies come from `webcat login` (or `--cookie`).
 */

import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import {
  WEBCAT_DOMAIN,
  getTaskDetail,
  getWebcatSessionFile,
  loadSession,
  normalizeCookies,
  parseEditorUrl,
  saveSession,
} from './_api.js';

export function parseCookieHeader(input) {
  const pairs = String(input ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  const cookies = [];
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    if (index <= 0) throw new ArgumentError(`Malformed cookie pair: ${pair} (expected name=value)`);
    cookies.push({ name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim(), domain: '.iol8.com', path: '/' });
  }
  if (cookies.length === 0) throw new ArgumentError('--cookie needs at least one name=value pair');
  return cookies;
}

export const command = cli({
  site: 'webcat',
  name: 'open',
  access: 'write',
  description: 'Point the WebCAT session at a task document URL (updates ck/splitIndex kept in ~/.opencli/webcat.json)',
  domain: WEBCAT_DOMAIN,
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'url', positional: true, required: true, help: 'WebCAT editor URL, e.g. https://webcat-dl.iol8.com/?ck=...&splitIndex=0#/project' },
    { name: 'cookie', help: 'Cookie header to store with the session, e.g. "ck=...; CASID=..." (usually unnecessary after webcat login)' },
  ],
  columns: ['status', 'ck', 'docId', 'taskId', 'session_file'],
  func: async (kwargs) => {
    const parsed = parseEditorUrl(kwargs.url);
    const existing = loadSession({ required: false });
    const cookies = kwargs.cookie ? normalizeCookies(parseCookieHeader(kwargs.cookie)) : existing?.cookies ?? [];
    const candidate = {
      baseUrl: parsed.origin,
      url: parsed.url,
      ck: parsed.ck,
      r: parsed.r,
      splitIndex: parsed.splitIndex,
      cookies,
    };
    if (cookies.length === 0) {
      throw new ArgumentError(
        'No iol8.com cookies stored yet',
        'Run `opencli webcat login` once, or pass --cookie "ck=...; CASID=...".',
      );
    }
    const detail = await getTaskDetail(candidate);
    const saved = saveSession({
      ...candidate,
      docId: detail.docId,
      taskId: detail.taskId,
      userCasId: detail.userCasId,
    });
    return {
      status: 'opened',
      ck: saved.ck,
      docId: saved.docId,
      taskId: saved.taskId,
      session_file: getWebcatSessionFile(),
    };
  },
});

export const __test__ = { command, parseCookieHeader };
