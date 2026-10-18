import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArgumentError, AuthRequiredError, CommandExecutionError, ConfigError } from '@jackwener/opencli/errors';

import {
  buildTargetItem,
  cookieHeaderOf,
  extractTagTokens,
  flowGetSentence,
  getWebcatSessionFile,
  htmlToPlain,
  loadSession,
  normalizeCookies,
  normalizeSegment,
  normalizeSession,
  parseEditorUrl,
  plainToHtml,
  saveSession,
  segmentMatchesFilter,
  webcatFetch,
} from './_api.js';
import { collectSegments } from './sentences.js';
import { pushTargets, normalizeForCompare, fetchSegmentsByIds } from './fill.js';
import { parseCookieHeader } from './open.js';
import { command as statusCommand } from './status.js';

const EDITOR_URL = 'https://webcat-dl.iol8.com/?ck=3598addb07cdae9240c60b24e8a2e136&isPreview=false&splitIndex=0&isCorpus=false&r=6437ff9104a14f58bbf6ca67ee53763c#/project';

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function makeSession() {
  return normalizeSession({
    url: EDITOR_URL,
    ck: 'ck-1',
    splitIndex: '0',
    cookies: [
      { name: 'ck', value: 'ck-1', domain: '.iol8.com', path: '/' },
      { name: 'CASID', value: 'cas-1', domain: '.iol8.com', path: '/' },
      { name: 'other', value: 'nope', domain: '.example.com', path: '/' },
    ],
  });
}

const tempDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcat-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('webcat editor URL parsing', () => {
  it('extracts ck/r/splitIndex from a real editor URL', () => {
    const parsed = parseEditorUrl(EDITOR_URL);
    expect(parsed.ck).toBe('3598addb07cdae9240c60b24e8a2e136');
    expect(parsed.r).toBe('6437ff9104a14f58bbf6ca67ee53763c');
    expect(parsed.splitIndex).toBe('0');
    expect(parsed.origin).toBe('https://webcat-dl.iol8.com');
  });

  it('rejects non-iol8 hosts and URLs without ck', () => {
    expect(() => parseEditorUrl('https://example.com/?ck=abc')).toThrow(ArgumentError);
    expect(() => parseEditorUrl('https://webcat-dl.iol8.com/#/project')).toThrow(ArgumentError);
    expect(() => parseEditorUrl('not a url')).toThrow(ArgumentError);
  });
});

describe('webcat cookies', () => {
  it('keeps only iol8.com cookies and de-duplicates by name', () => {
    const cookies = normalizeCookies([
      { name: 'ck', value: 'a', domain: '.iol8.com' },
      { name: 'ck', value: 'b', domain: 'webcat-dl.iol8.com' },
      { name: 'CKID', value: 'c', domain: 'iol8.com' },
      { name: 'x', value: 'y', domain: '.example.com' },
      { name: '', value: 'z' },
    ]);
    expect(cookies.map((cookie) => `${cookie.name}=${cookie.value}@${cookie.domain}`)).toEqual([
      'ck=b@webcat-dl.iol8.com',
      'CKID=c@iol8.com',
    ]);
    expect(cookieHeaderOf({ cookies })).toBe('ck=b; CKID=c');
  });

  it('parses a manual --cookie header', () => {
    expect(parseCookieHeader('ck=abc; CASID=def')).toEqual([
      { name: 'ck', value: 'abc', domain: '.iol8.com', path: '/' },
      { name: 'CASID', value: 'def', domain: '.iol8.com', path: '/' },
    ]);
    expect(() => parseCookieHeader('broken')).toThrow(ArgumentError);
  });
});

describe('webcat HTML helpers', () => {
  it('round-trips plain text through WebCAT target HTML', () => {
    expect(plainToHtml('Hello\nworld & <tags>')).toBe('Hello<br>world &amp; &lt;tags&gt;');
    expect(htmlToPlain('Hello<br>world &amp; &lt;tags&gt;')).toBe('Hello\nworld & <tags>');
    expect(htmlToPlain('中文&nbsp;文本')).toBe('中文 文本');
  });

  it('collects inline tag tokens a target must keep', () => {
    expect(extractTagTokens('<span class="term">t</span><img src="/img/transparent.png" data-id="1">')).toEqual([
      '<img src="/img/transparent.png" data-id="1">',
    ]);
    expect(extractTagTokens('plain text')).toEqual([]);
  });
});

describe('webcat segment model', () => {
  const dto = {
    sentId: 's1',
    serialNum: 3,
    sourcePlaceholder: '源文<br>第二行',
    targetPlaceholder: '译文<br>第二行',
    targetText: '译文\n第二行',
    isConfirm: true,
    locked: true,
    wordCount: 7,
  };

  it('normalizes a sentence DTO', () => {
    const segment = normalizeSegment(dto);
    expect(segment).toMatchObject({
      sentId: 's1',
      index: 3,
      status: 'confirmed',
      isConfirm: true,
      locked: true,
      source: '源文\n第二行',
      target: '译文\n第二行',
      wordCount: 7,
    });
  });

  it('derives status flags and filters', () => {
    expect(normalizeSegment({ sentId: 'a', sourcePlaceholder: 'x' }).status).toBe('untranslated');
    expect(normalizeSegment({ sentId: 'a', sourcePlaceholder: 'x', targetPlaceholder: 'y' }).status).toBe('translated');
    expect(segmentMatchesFilter(normalizeSegment({ sentId: 'a', targetPlaceholder: 'y' }), 'unconfirmed')).toBe(true);
    expect(segmentMatchesFilter(normalizeSegment({ sentId: 'a' }), 'untranslated')).toBe(true);
    expect(segmentMatchesFilter(normalizeSegment(dto), 'confirmed')).toBe(true);
    expect(() => segmentMatchesFilter(normalizeSegment(dto), 'bogus')).toThrow(ArgumentError);
  });
});

describe('webcat batch write payload', () => {
  it('mirrors the editor batch-save-target item shape', () => {
    const item = buildTargetItem({ text: 'Hello & goodbye' }, { sentId: 's1' });
    expect(item).toEqual({
      sentId: 's1',
      indexId: 's1',
      targetPlaceholder: 'Hello &amp; goodbye',
      sourceHasChange: false,
      targetHasChange: true,
      targetText: 'Hello & goodbye',
    });
  });

  it('accepts raw html and keeps indexId from the segment', () => {
    const item = buildTargetItem({ sentId: 's2', html: '译文<img src="/img/transparent.png">' }, { sentId: 's2-merged' });
    expect(item.targetPlaceholder).toBe('译文<img src="/img/transparent.png">');
    expect(item.indexId).toBe('s2-merged');
    expect(item.targetText).toBe('译文');
  });

  it('fails typed when text is missing', () => {
    expect(() => buildTargetItem({ sentId: 's3' }, { sentId: 's3' })).toThrow(ArgumentError);
    expect(() => buildTargetItem({}, {})).toThrow(ArgumentError);
  });

  it('posts data as a JSON string with docId + items', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ result: '1', data: null, success: true });
    };
    await pushTargets(makeSession(), 4242, [{ sentId: 's1', targetPlaceholder: 'A' }], { chunkSize: 10, fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://webcat-dl.iol8.com/api/sentence/webcatSentence/batch-save-target');
    const params = new URLSearchParams(calls[0].options.body);
    expect(params.get('saveSnapshot')).toBe('false');
    expect(JSON.parse(params.get('data'))).toEqual({ docId: 4242, data: [{ sentId: 's1', targetPlaceholder: 'A' }] });
  });
});

describe('webcat HTTP client', () => {
  it('sends the editor headers and returns the envelope', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ result: '1', data: { total: 12 }, success: true });
    };
    const envelope = await webcatFetch('/sentence/webcatSentence/sumSentenceCount', {
      session: makeSession(),
      data: { docId: 4242, splitIndex: '0' },
      fetchImpl,
    });
    expect(envelope.data).toEqual({ total: 12 });
    const { options } = calls[0];
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Basic d2ViY2F0LXNlcnZlcjplNmx0b2plRlVVRG0=');
    expect(options.headers.ck).toBe('ck-1');
    expect(options.headers.Cookie).toBe('ck=ck-1; CASID=cas-1');
    expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(options.headers.Origin).toBe('https://webcat-dl.iol8.com');
    expect(options.body).toBe('docId=4242&splitIndex=0');
  });

  it('maps WebCAT auth errors to AuthRequiredError', async () => {
    await expect(webcatFetch('/task/info/getTaskDetail', {
      session: makeSession(),
      fetchImpl: async () => jsonResponse({ result: '0', errorCode: '000005', errorMsg: '无效的授权信息,请重新登录系统！', success: false }),
    })).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('maps other business errors to CommandExecutionError', async () => {
    await expect(webcatFetch('/task/info/getTaskDetail', {
      session: makeSession(),
      fetchImpl: async () => jsonResponse({ result: '0', errorCode: '999999', errorMsg: 'boom', success: false }),
    })).rejects.toThrow(CommandExecutionError);
  });

  it('rejects HTTP failures and malformed JSON', async () => {
    await expect(webcatFetch('/task/info/getTaskDetail', {
      session: makeSession(),
      fetchImpl: async () => jsonResponse('nope', { status: 500 }),
    })).rejects.toThrow(CommandExecutionError);
    await expect(webcatFetch('/task/info/getTaskDetail', {
      session: makeSession(),
      fetchImpl: async () => jsonResponse('<html>login</html>'),
    })).rejects.toThrow(CommandExecutionError);
  });

  it('appends query parameters for GET requests', async () => {
    const calls = [];
    await webcatFetch('/sentence/sent_filter/sidebar_list', {
      method: 'GET',
      session: makeSession(),
      query: { docId: 7, splitIndex: '0' },
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse({ result: '1', data: {} });
      },
    });
    expect(calls[0].url).toBe('https://webcat-dl.iol8.com/api/sentence/sent_filter/sidebar_list?docId=7&splitIndex=0');
    expect(calls[0].options.body).toBeUndefined();
  });
});

describe('webcat segment paging', () => {
  it('walks both directions so the whole document is returned in order', async () => {
    const seenDirections = [];
    const fetchImpl = async (url, options) => {
      const params = new URLSearchParams(options.body);
      const direction = params.get('pullDirection') ?? '';
      seenDirections.push(direction);
      if (direction === '') return jsonResponse({ result: '1', data: { data: [{ sentId: 's2' }, { sentId: 's3' }], isTop: false, isBottom: false } });
      if (direction === 'Down') return jsonResponse({ result: '1', data: { data: [{ sentId: 's4' }], isTop: false, isBottom: true } });
      return jsonResponse({ result: '1', data: { data: [{ sentId: 's1' }], isTop: true, isBottom: false } });
    };
    const dtos = await collectSegments(makeSession(), 4242, { pageSize: 2, maxSegments: 100, fetchImpl });
    expect(dtos.map((dto) => dto.sentId)).toEqual(['s1', 's2', 's3', 's4']);
    expect(seenDirections).toEqual(['', 'Down', 'Up']);
  });

  it('stops on an empty page without looping forever', async () => {
    let calls = 0;
    const page = await flowGetSentence(makeSession(), { docId: 1 }, async () => {
      calls += 1;
      return jsonResponse({ result: '1', data: { data: [], isTop: false, isBottom: false } });
    });
    expect(page.list).toEqual([]);
    expect(calls).toBe(1);
    expect(page.isBottom).toBe(false);
  });

  it('reads segments by id in chunks', async () => {
    const bodies = [];
    const map = await fetchSegmentsByIds(makeSession(), 4242, ['a', 'b', 'c'], async (url, options) => {
      bodies.push(new URLSearchParams(options.body).get('sentIds'));
      return jsonResponse({ result: '1', data: { data: [{ sentId: 'a' }, { sentId: 'b' }], isTop: true, isBottom: true } });
    });
    expect(bodies).toEqual(['a,b,c']);
    expect([...map.keys()]).toEqual(['a', 'b']);
  });

  it('normalizes text for write verification', () => {
    expect(normalizeForCompare('  译文\u200b  第二行 ')).toBe('译文 第二行');
  });
});

describe('webcat sessions', () => {
  it('persists and reloads a session with 0600 permissions', () => {
    const dir = tempDir();
    const file = path.join(dir, 'webcat.json');
    vi.stubEnv('WEBCAT_SESSION_FILE', file);
    expect(getWebcatSessionFile()).toBe(file);

    saveSession({
      url: EDITOR_URL,
      ck: 'ck-1',
      cookies: [{ name: 'CASID', value: 'cas-1', domain: '.iol8.com' }],
      docId: 11,
      taskId: 22,
    });
    const loaded = loadSession();
    expect(loaded.ck).toBe('ck-1');
    expect(loaded.docId).toBe('11');
    expect(loaded.cookies).toHaveLength(1);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('fails typed when the session file is missing', () => {
    vi.stubEnv('WEBCAT_SESSION_FILE', path.join(tempDir(), 'missing.json'));
    expect(() => loadSession()).toThrow(ConfigError);
    expect(loadSession({ required: false })).toBeNull();
  });
});

describe('webcat command registration', () => {
  it('exposes the read/write access split the CLI relies on', () => {
    expect(statusCommand.access).toBe('read');
    expect(statusCommand.browser).toBe(false);
    expect(statusCommand.site).toBe('webcat');
  });
});
