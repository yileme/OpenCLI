
import { describe, expect, it } from 'vitest';
import {
  checkConsistency,
  extractTermPairs,
  zhTermCandidates,
} from './terms.js';
import { classifyQaLog, classifyQaLogs } from './qa.js';
import { __test__ as fillTest } from './fill.js';
import { __test__ as restoreTest } from './restore.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'webcat-p3-'));
}

describe('terms extraction', () => {
  it('ranks frequency candidates and flags inconsistent repeats — never invents translations', () => {
    const segments = [
      { sentId: '1', index: 1, source: '医疗器械行业快速发展', target: 'The medical device industry is developing fast' },
      { sentId: '2', index: 2, source: '医疗器械行业规模扩大', target: 'The medical device industry is expanding' },
      { sentId: '3', index: 3, source: '医疗器械行业进入黄金期', target: 'The medical device industry has entered a golden period' },
      { sentId: '4', index: 4, source: '创新的审批加快', target: 'Approval of innovation accelerates' },
      { sentId: '5', index: 5, source: '创新的审批加快', target: 'Approval of innovative products accelerates' },
    ];
    const { terms, repeatInconsistencies } = extractTermPairs(segments, { minCount: 2 });
    const hit = terms.find((p) => p.source === '医疗器械行业');
    expect(hit).toBeTruthy();
    expect(hit.count).toBe(3);
    expect(hit.target).toBe(''); // translations are not guessed from enclosing sentences
    expect(terms.find((p) => p.source === '审批加快')).toBeTruthy();
    // identical source, two different translations → genuine inconsistency with sentIds
    expect(repeatInconsistencies).toHaveLength(1);
    expect(repeatInconsistencies[0].variants.map((v) => v.count)).toEqual([1, 1]);
    expect(repeatInconsistencies[0].variants.flatMap((v) => v.sentIds).sort()).toEqual(['4', '5']);
  });

  it('zh candidates reject stop-char edges', () => {
    const cands = zhTermCandidates('在医疗器械行业的快速发展中');
    expect(cands).not.toContain('在医疗器械行业');
  });
});

describe('terms consistency check', () => {
  it('flags segments missing the approved rendering', () => {
    const terms = [{ source: '医疗器械', target: 'medical device' }];
    const segments = [
      { sentId: '1', index: 1, source: '医疗器械行业', target: 'medical device industry' },
      { sentId: '2', index: 2, source: '医疗器械行业', target: 'medical equipment industry' },
      { sentId: '3', index: 3, source: '医疗器械行业', target: '' },
    ];
    const issues = checkConsistency(segments, terms);
    expect(issues.map((i) => i.sentId)).toEqual(['2']);
  });
});

describe('qa false-positive classification', () => {
  const ctx = (source, target) => ({ source, target });

  it('NUMBER: same numbers present → false positive', () => {
    const v = classifyQaLog({ checkType: 'NUMBER_CHECK', original: '2026' }, ctx('2026年发布', 'Published in 2026'));
    expect(v.verdict).toBe('false_positive');
  });

  it('NUMBER: scale-converted number (万/亿) → false positive', () => {
    const v = classifyQaLog({ checkType: 'NUMBER_CHECK', original: '35.79亿' }, ctx('迈瑞医疗35.79亿', 'Mindray RMB 3.579 billion'));
    expect(v.verdict).toBe('false_positive');
  });

  it('NUMBER: missing from target only → review', () => {
    const v = classifyQaLog({ checkType: 'NUMBER_CHECK', original: '4763' }, ctx('广东省4763家', 'Guangdong Province, many manufacturers'));
    expect(v.verdict).toBe('review');
  });

  it('NUMBER: absent from both sides → real', () => {
    const v = classifyQaLog({ checkType: 'NUMBER_CHECK', original: '9999' }, ctx('内容甲', 'Content A'));
    expect(v.verdict).toBe('real');
  });

  it('NUMBER: digit string from an HTML entity (&#8216;) is not a number (regression)', () => {
    const v = classifyQaLog({ checkType: 'NUMBER_CHECK', original: '8217' },
      ctx('“人工智能医生”出现在手机上。', '&#8216;AI doctors&#8217; appear on phones.'));
    expect(v.verdict).toBe('false_positive');
  });

  it('PUNCT: convention swap → false positive; mixed latin/CJK punct → review', () => {
    expect(classifyQaLog({ checkType: 'PUNCTUATION_CHECK', original: '，' }, ctx('中文，中文', 'English, English')).verdict).toBe('false_positive');
    expect(classifyQaLog({ checkType: 'SPACE_CHECK', original: ' ' }, ctx('a b', 'a，b')).verdict).toBe('review');
  });

  it('TAG: entity spelling difference → false positive; truly missing → real', () => {
    expect(classifyQaLog({ checkType: 'TAG_CHECK', original: '‘' }, ctx('“引号”', '&#8216;quotes&#8217;')).verdict).toBe('false_positive');
    expect(classifyQaLog({ checkType: 'PLACEHOLDER_CHECK', original: '{0}' }, ctx('选项{0}', 'Option disabled')).verdict).toBe('real');
  });

  it('SPELL: proper noun kept verbatim in target → false positive', () => {
    const v = classifyQaLog({ checkType: 'SPELL_CHECK', original: 'Healthineers' }, ctx('德国西门子医疗', 'Siemens Healthineers (Germany)'));
    expect(v.verdict).toBe('false_positive');
    const v2 = classifyQaLog({ checkType: 'SPELL_CHECK', original: 'NeuSofte' }, ctx('东软医疗', 'Neusoft Medical'));
    expect(v2.verdict).toBe('review');
  });

  it('TERM → review (needs termbase cross-check)', () => {
    expect(classifyQaLog({ checkType: 'TERM_CHECK', original: '术语' }, ctx('术语', 'term')).verdict).toBe('review');
  });

  it('classifyQaLogs keeps ids and counts verdicts', () => {
    const out = classifyQaLogs([
      { sentId: 'a', checkType: 'NUMBER_CHECK', original: '2026', source: '2026年', target: 'in 2026' },
      { sentId: 'b', checkType: 'NUMBER_CHECK', original: '777', source: '内容', target: 'content' },
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((x) => x.sentId === 'a').verdict).toBe('false_positive');
    expect(out.find((x) => x.sentId === 'b').verdict).toBe('real');
  });
});

describe('fill backup + restore', () => {
  it('writes a snapshot and restore lists/uses it', async () => {
    const dir = tmpdir();
    process.env.WEBCAT_BACKUP_DIR = dir;
    try {
      const map = new Map([['s1', { targetPlaceholder: '旧译文', targetText: '旧译文' }], ['s2', { targetPlaceholder: 'old', targetText: 'old' }]]);
      const file = fillTest.writeBackup('doc1', map);
      expect(fs.existsSync(file)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      expect(parsed.docId).toBe('doc1');
      expect(parsed.segments.s1.targetText).toBe('旧译文');
      const backups = restoreTest.listBackups(dir);
      expect(backups).toHaveLength(1);
      expect(backups[0].segments).toBe(2);
    } finally {
      delete process.env.WEBCAT_BACKUP_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resilient push retries then surfaces failure, and auth errors are not retried', async () => {
    const { AuthRequiredError, CommandExecutionError } = await import('@jackwener/opencli/errors');
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls < 3) throw new Error('boom');
      return { ok: true, status: 200, text: async () => JSON.stringify({ result: '1', data: null, success: true }) };
    };
    const items = Array.from({ length: 3 }, (_, i) => ({ sentId: `s${i}`, targetPlaceholder: `t${i}` }));
    const res = await fillTest.pushTargetsResilient({ ck: 'x', splitIndex: '0', cookies: [{ name: 'a', value: 'b', domain: '.iol8.com', path: '/' }] }, 1, items, { chunkSize: 2, retries: 2, fetchImpl: flaky });
    expect(res.chunks).toBe(2);
    expect(calls).toBeGreaterThanOrEqual(3); // retried at least once, then succeeded
    expect(calls).toBeLessThanOrEqual(4);

    let authCalls = 0;
    const authFail = async () => {
      authCalls += 1;
      const text = JSON.stringify({ result: '0', errorCode: '000005', errorMsg: '无效', success: false });
      return { ok: true, status: 200, text: async () => text };
    };
    await expect(fillTest.pushTargetsResilient({ ck: 'x', splitIndex: '0', cookies: [{ name: 'a', value: 'b', domain: '.iol8.com', path: '/' }] }, 1, items, { chunkSize: 2, retries: 2, fetchImpl: authFail }))
      .rejects.toBeInstanceOf(AuthRequiredError);
    expect(authCalls).toBe(1); // no retry on auth
  });

  it('retries the intermittent 900000 write error instead of losing the chunk', async () => {
    // Observed live: batch-save-target answers `900000 权限不足或句子不符合条件`
    // even though the same payload succeeds on a later attempt.
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls < 4) {
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ result: '0', errorCode: '900000', errorMsg: '权限不足或句子不符合条件', success: false }),
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ result: '1', data: null, success: true }) };
    };
    const items = [{ sentId: 's1', targetPlaceholder: 't1' }];
    const session = { ck: 'x', splitIndex: '0', cookies: [{ name: 'a', value: 'b', domain: '.iol8.com', path: '/' }] };
    const waits = [];
    const res = await fillTest.pushTargetsResilient(session, 1, items, {
      chunkSize: 1, retries: 3, fetchImpl: flaky, waitImpl: async (ms) => { waits.push(ms); },
    });
    expect(res.chunks).toBe(1);
    expect(calls).toBe(4); // three 900000 answers, then success
    expect(waits.length).toBe(3);
    expect(waits[0]).toBeGreaterThanOrEqual(2500); // permission-style errors back off harder
  });

  it('falls back to one segment per request when a chunk keeps failing', async () => {
    // Observed live: the chunk request keeps answering 900000 while a
    // single-segment request for the same content succeeds.
    const items = [{ sentId: 's1', targetPlaceholder: 'a' }, { sentId: 's2', targetPlaceholder: 'b' }];
    const session = { ck: 'x', splitIndex: '0', cookies: [{ name: 'a', value: 'b', domain: '.iol8.com', path: '/' }] };
    const seen = [];
    const fetchImpl = async (url, init) => {
      const body = decodeURIComponent(String(init?.body ?? ''));
      const ids = [...body.matchAll(/"sentId":"([^"]+)"/g)].map((m) => m[1]);
      const single = ids.length === 1;
      seen.push(single ? 'single' : 'chunk');
      if (!single) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ result: '0', errorCode: '900000', errorMsg: '权限不足或句子不符合条件', success: false }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ result: '1', data: null, success: true }) };
    };
    const res = await fillTest.pushTargetsResilient(session, 1, items, {
      chunkSize: 2, retries: 0, fetchImpl, waitImpl: async () => {},
    });
    expect(res.chunks).toBe(1);
    expect(seen.filter((x) => x === 'chunk').length).toBeGreaterThanOrEqual(1);
    expect(seen.filter((x) => x === 'single').length).toBe(2); // one per segment
  });

  it('does not report a chunk as failed when the write actually landed (read-back confirmation)', async () => {
    const items = [{ sentId: 's1', targetPlaceholder: '新译文', targetText: '新译文' }];
    const session = { ck: 'x', splitIndex: '0', cookies: [{ name: 'a', value: 'b', domain: '.iol8.com', path: '/' }] };
    process.env.WEBCAT_SESSION_FILE = '/tmp/does-not-exist-webcat.json';
    try {
      const fetchImpl = async (url) => {
        if (String(url).includes('flowGetSentence')) {
          return {
            ok: true, status: 200,
            text: async () => JSON.stringify({ result: '1', data: { data: [{ sentId: 's1', targetPlaceholder: '新译文', targetText: '新译文' }] }, success: true }),
          };
        }
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ result: '0', errorCode: '900000', errorMsg: '权限不足或句子不符合条件', success: false }),
        };
      };
      const res = await fillTest.pushTargetsResilient(session, 1, items, {
        chunkSize: 1, retries: 1, fetchImpl, waitImpl: async () => {},
      });
      expect(res.chunks).toBe(1); // no throw: re-read proved the write landed
    } finally {
      delete process.env.WEBCAT_SESSION_FILE;
    }
  });
});
