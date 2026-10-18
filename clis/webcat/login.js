/**
 * `opencli webcat login` — capture a WebCAT session for the CLI.
 *
 * WebCAT authenticates with iol8.com cookies, so the CLI needs them once.
 * This command launches Chrome with its own profile (reused on later runs),
 * waits until you are signed in *and* have a task document open, then stores
 * the cookie jar plus the task key (`ck`) in ~/.opencli/webcat.json.
 *
 * Passing `--cdp http://127.0.0.1:9222` harvests the session from a Chrome you
 * already started with `--remote-debugging-port=9222` instead of launching one.
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArgumentError, CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import WebSocket from 'ws';
import {
  WEBCAT_DOMAIN,
  WEBCAT_WEB_ORIGIN,
  formatError,
  getTaskDetail,
  getWebcatSessionFile,
  normalizeCookies,
  parseEditorUrl,
  saveSession,
} from './_api.js';

const DEFAULT_PROFILE_DIR = path.join(os.homedir(), '.opencli', 'webcat-chrome-profile');
const DEFAULT_TIMEOUT_SECONDS = 300;
const POLL_INTERVAL_MS = 2000;
const CDP_READY_TIMEOUT_MS = 30_000;
const CDP_CALL_TIMEOUT_MS = 15_000;

const CHROME_BINARIES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function findChromeBinary(explicit) {
  const wanted = String(explicit ?? '').trim();
  if (wanted) {
    if (!fs.existsSync(wanted)) throw new ArgumentError(`Chrome binary not found: ${wanted}`);
    return wanted;
  }
  for (const candidate of CHROME_BINARIES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'google-chrome-stable']) {
    const probe = spawnSync('which', [name], { encoding: 'utf-8' });
    const found = String(probe.stdout ?? '').trim();
    if (probe.status === 0 && found) return found;
  }
  throw new CommandExecutionError(
    'No Chrome/Chromium binary found for the WebCAT login flow',
    'Install Chrome, or pass --chrome <path>, or use --cdp <endpoint> with a Chrome already running with --remote-debugging-port.',
  );
}

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new CommandExecutionError('Could not reserve a local port'))));
    });
  });
}

export async function waitForBrowserWs(port, timeoutMs = CDP_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const body = await response.json();
        if (body?.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = formatError(error);
    }
    await delay(500);
  }
  throw new CommandExecutionError(
    `Chrome did not expose a DevTools endpoint on 127.0.0.1:${port} (${lastError})`,
    'Close other Chrome windows using the same profile directory, then retry.',
  );
}

export async function resolveBrowserWs(endpoint) {
  const raw = String(endpoint ?? '').trim();
  if (!raw) throw new ArgumentError('--cdp needs an endpoint such as http://127.0.0.1:9222');
  if (/^wss?:\/\//i.test(raw)) return raw;
  const base = raw.replace(/\/+$/, '');
  let response;
  try {
    response = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    throw new CommandExecutionError(`Could not reach CDP endpoint ${base}: ${formatError(error)}`, 'Make sure Chrome runs with --remote-debugging-port=<port>.');
  }
  if (!response.ok) throw new CommandExecutionError(`CDP endpoint ${base} returned HTTP ${response.status}`);
  const body = await response.json();
  if (!body?.webSocketDebuggerUrl) throw new CommandExecutionError(`CDP endpoint ${base} did not return a webSocketDebuggerUrl`);
  return body.webSocketDebuggerUrl;
}

export function cdpCall(wsUrl, method, params = {}, timeoutMs = CDP_CALL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(wsUrl);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // ignore close races
      }
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new CommandExecutionError(`CDP ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
    socket.on('open', () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (message?.id !== 1) return;
      if (message.error) finish(reject, new CommandExecutionError(`CDP ${method} failed: ${message.error.message ?? 'unknown error'}`));
      else finish(resolve, message.result ?? {});
    });
    socket.on('error', (error) => finish(reject, new CommandExecutionError(`CDP connection to ${wsUrl} failed: ${formatError(error)}`)));
  });
}

export async function readBrowserCookies(wsUrl) {
  const result = await cdpCall(wsUrl, 'Storage.getCookies');
  return normalizeCookies(result?.cookies ?? []);
}

export async function readWebcatTabUrls(wsUrl) {
  const result = await cdpCall(wsUrl, 'Target.getTargets');
  const infos = Array.isArray(result?.targetInfos) ? result.targetInfos : [];
  return infos
    .filter((info) => info?.type === 'page' && typeof info.url === 'string')
    .map((info) => info.url)
    .filter((url) => url.includes('iol8.com'));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeLaunchedBrowser(wsUrl) {
  try {
    await cdpCall(wsUrl, 'Browser.close', {}, 5000);
  } catch {
    // best effort — the user can close the window manually
  }
}

export const command = cli({
  site: 'webcat',
  name: 'login',
  access: 'write',
  description: 'Launch/harvest a Chrome session for the WebCAT (云译客) editor and save the CLI session',
  domain: WEBCAT_DOMAIN,
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'url', positional: true, help: 'WebCAT editor URL to open (must contain ?ck=...); defaults to the WebCAT home page' },
    { name: 'cdp', help: 'Reuse a running Chrome DevTools endpoint, e.g. http://127.0.0.1:9222' },
    { name: 'chrome', help: 'Path to the Chrome/Chromium binary used for the login window' },
    { name: 'profile', help: `Chrome profile directory for the login window (default: ${DEFAULT_PROFILE_DIR})` },
    { name: 'timeout', type: 'int', default: DEFAULT_TIMEOUT_SECONDS, help: 'Maximum seconds to wait for sign-in plus an open task document' },
    { name: 'close', type: 'bool', default: false, help: 'Close the Chrome window once the session is captured' },
  ],
  columns: ['status', 'ck', 'cookies', 'docId', 'taskId', 'session_file'],
  func: async (kwargs) => {
    const timeoutSeconds = Number(kwargs.timeout ?? DEFAULT_TIMEOUT_SECONDS);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new ArgumentError('--timeout must be a positive number of seconds');
    const requestedUrl = String(kwargs.url ?? '').trim();
    const cdpEndpoint = String(kwargs.cdp ?? '').trim();

    let wsUrl;
    let launched = false;
    if (cdpEndpoint) {
      wsUrl = await resolveBrowserWs(cdpEndpoint);
    } else {
      const binary = findChromeBinary(kwargs.chrome);
      const profileDir = String(kwargs.profile ?? '').trim() || DEFAULT_PROFILE_DIR;
      fs.mkdirSync(profileDir, { recursive: true });
      const port = await getFreePort();
      const child = spawn(
        binary,
        [
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profileDir}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--new-window',
          requestedUrl || WEBCAT_WEB_ORIGIN,
        ],
        { detached: true, stdio: 'ignore' },
      );
      child.unref();
      launched = true;
      wsUrl = await waitForBrowserWs(port);
    }

    const deadline = Date.now() + timeoutSeconds * 1000;
    let lastMessage = '';

    while (Date.now() < deadline) {
      let cookies = [];
      try {
        cookies = await readBrowserCookies(wsUrl);
      } catch (error) {
        lastMessage = formatError(error);
      }
      let tabUrls = [];
      try {
        tabUrls = await readWebcatTabUrls(wsUrl);
      } catch {
        tabUrls = [];
      }

      if (cookies.length > 0) {
        const candidates = [];
        for (const tabUrl of tabUrls) {
          try {
            candidates.push(parseEditorUrl(tabUrl));
          } catch {
            // tab without a usable task key (e.g. the iol8 home page)
          }
        }
        if (candidates.length === 0 && requestedUrl) {
          try {
            candidates.push(parseEditorUrl(requestedUrl));
          } catch {
            // user supplied a URL without ck — keep waiting for a real editor tab
          }
        }
        for (const candidate of candidates) {
          const session = {
            baseUrl: candidate.origin,
            url: candidate.url,
            ck: candidate.ck,
            r: candidate.r,
            splitIndex: candidate.splitIndex,
            cookies,
          };
          try {
            const detail = await getTaskDetail(session);
            const saved = saveSession({
              ...session,
              docId: detail.docId,
              taskId: detail.taskId,
              userCasId: detail.userCasId,
            });
            if (launched && kwargs.close === true) await closeLaunchedBrowser(wsUrl);
            return {
              status: 'session_saved',
              ck: saved.ck,
              cookies: saved.cookies.map((cookie) => cookie.name).join(','),
              docId: saved.docId,
              taskId: saved.taskId,
              session_file: getWebcatSessionFile(),
            };
          } catch (error) {
            lastMessage = formatError(error);
          }
        }
      }
      await delay(POLL_INTERVAL_MS);
    }

    throw new TimeoutError(
      'webcat login',
      timeoutSeconds,
      `Sign in to iol8.com and open a WebCAT task document in the login window, then rerun.${lastMessage ? ` Last check: ${lastMessage}` : ''}`,
    );
  },
});

export const __test__ = {
  DEFAULT_PROFILE_DIR,
  findChromeBinary,
  getFreePort,
  readBrowserCookies,
  readWebcatTabUrls,
  resolveBrowserWs,
  command,
};
