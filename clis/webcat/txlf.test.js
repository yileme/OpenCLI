
import { describe, expect, it } from 'vitest';
import {
  alignTxlfToWebcat,
  buildTargetHtml,
  normKey,
  parseTxlf,
  stripTags,
  tagSetsMatch,
  unitsOf,
} from './txlf.js';
import { normalizeForCompare } from './fill.js';

const TXLF = `<?xml version="1.0"?>
<xliff version="1.2">
<file><body>
<trans-unit id="1-1-1"><source>中国医疗器械行业<x ctype="lb" id="3" equiv-text=" "/>发展现状与展望</source><target>Current Status and Prospects of China's Medical Device Industry<x ctype="lb" id="3" equiv-text=" "/></target></trans-unit>
<trans-unit id="1-2-1"><source>王宝亭</source><target>Wang Baoting</target></trans-unit>
<trans-unit id="2-1-1"><source>福建省  631；  陕西省   621；  吉林省  618；</source><target>Fujian Province 631; Shaanxi Province 621; Jilin Province 618.</target></trans-unit>
<trans-unit id="3-1-1"><source><bpt ctype="x-fontFormat" id="4" rid="3">&lt;fontFormat name="仿宋"&gt;</bpt>前言<ept id="5" rid="3">&lt;/fontFormat&gt;</ept></source><target><bpt ctype="x-fontFormat" id="4" rid="3">&lt;fontFormat name="仿宋"&gt;</bpt>Introduction<ept id="5" rid="3">&lt;/fontFormat&gt;</ept></target></trans-unit>
<trans-unit id="4-1-1"><source>内容甲</source><target>Content A</target></trans-unit>
<trans-unit id="4-2-1"><source>内容乙</source><target>Content B</target></trans-unit>
</body></file>
</xliff>`;

function wcSeg(dto) {
  // raw DTO shape straight from flowGetSentence
  return {
    sentId: dto.sentId,
    sentIndex: dto.index,
    sourcePlaceholder: dto.sourceHtml ?? dto.source,
    targetText: dto.target ?? '',
    isLocked: dto.locked === true,
    ...dto,
  };
}

describe('txlf normKey', () => {
  it('drops TXLF wrapper payloads so they do not pollute matching keys', () => {
    const raw = '<bpt ctype="x-fontFormat" id="4" rid="3">&lt;fontFormat name="仿宋"&gt;</bpt>前言<ept id="5" rid="3">&lt;/fontFormat&gt;</ept>';
    expect(normKey(raw)).toBe('前言');
  });
  it('treats soft line breaks as whitespace', () => {
    expect(normKey('中国医疗器械行业<x ctype="lb" id="3" equiv-text=" "/>发展现状与展望')).toBe('中国医疗器械行业发展现状与展望');
  });
});

describe('txlf parse', () => {
  it('extracts trans-units with target presence', () => {
    const segs = parseTxlf(TXLF);
    expect(segs).toHaveLength(6);
    expect(segs[0].hasTarget).toBe(true);
    expect(segs[0].hasTags).toBe(true);
    expect(segs[1].hasTags).toBe(false);
  });
  it('rejects non-XLIFF input', () => {
    expect(() => parseTxlf('<html>nope</html>')).toThrow(/not a TXLF/);
  });
});

describe('txlf tag injection', () => {
  it('maps TXLF wrappers onto WC rs/re pairs by order and keeps visible text', () => {
    const srcHtml = '<img id="rs1_st-1-1" />前言<img id="re1_st-1-1" />（接上页）';
    const tUnits = unitsOf([
      ['tag', '<bpt ctype="x-fontFormat" id="4" rid="3">&lt;fontFormat&gt;</bpt>'],
      ['text', 'Introduction'],
      ['tag', '</bpt>'],
      ['text', '（接上页）'],
    ]);
    const html = buildTargetHtml(tUnits, srcHtml);
    expect(html).toBe('<img id="rs1_st-1-1" />Introduction<img id="re1_st-1-1" />（接上页）');
    expect(tagSetsMatch(srcHtml, html)).toBe(true);
  });
  it('injects positionally when TXLF has no wrappers but WC does', () => {
    const srcHtml = '我国医疗器械市场将<img id="rs1_st-1-1" />继续扩大<img id="re1_st-1-1" />';
    const html = buildTargetHtml([['text', "China's medical device market will continue to expand"]], srcHtml);
    expect(tagSetsMatch(srcHtml, html)).toBe(true);
    expect(stripTags(html)).toContain('continue to expand');
  });
  it('keeps unmatched WC pairs adjacent so the tag set is preserved', () => {
    const srcHtml = '<img id="rs1_st-1-1" />1<img id="re1_st-1-1" />';
    const html = buildTargetHtml([['text', '1']], srcHtml, { txlfSourceHtml: srcHtml });
    expect(tagSetsMatch(srcHtml, html)).toBe(true);
  });
});

describe('txlf alignment passes', () => {
  it('exact, row-cell, merge and locked/identical handling all work', () => {
    const txlf = parseTxlf(TXLF);
    const wc = [
      wcSeg({ sentId: 'a', index: 1, sourceHtml: '中国医疗器械行业\n发展现状与展望' }),
      wcSeg({ sentId: 'b', index: 2, source: '王宝亭', target: 'Wang Baoting' }), // identical → skip
      wcSeg({ sentId: 'c', index: 3, source: '福建省  631；' }), // row cell
      wcSeg({ sentId: 'd', index: 4, sourceHtml: '<img id="rs1_st-1-1" />前言<img id="re1_st-1-1" />' }),
      wcSeg({ sentId: 'e', index: 5, source: '内容甲 内容乙' }), // merge
      wcSeg({ sentId: 'f', index: 6, source: '锁定段', locked: true }),
      wcSeg({ sentId: 'g', index: 7, source: 'TXLF 里没有这句' }), // no match
    ];
    const { fills, report } = alignTxlfToWebcat(txlf, wc);
    expect(report.lockedSkipped).toBe(1);
    expect(report.identicalSkipped).toBe(1);
    expect(report.noMatch.map((n) => n.sentId)).toEqual(['g']);
    const byId = new Map(fills.map((f) => [f.sentId, f]));
    expect(byId.get('a').targetText).toContain("China's Medical Device Industry");
    expect(byId.get('c').targetText).toBe('Fujian Province 631;');
    expect(byId.get('d').html).toBe('<img id="rs1_st-1-1" />Introduction<img id="re1_st-1-1" />');
    expect(byId.get('e').targetText).toBe('Content A Content B');
    // tag sets preserved everywhere
    const srcById = new Map(wc.map((s) => [s.sentId, s.sourcePlaceholder ?? s.sourceHtml ?? '']));
    for (const f of fills) expect(tagSetsMatch(srcById.get(f.sentId), f.html)).toBe(true);
    // accounting balanced
    expect(report.pass1 + report.pass2Row + report.pass3Merge + report.pass4Prefix + report.pass5Tail).toBe(report.filled);
  });

  it('never writes an empty target from a mis-split row cell', () => {
    const txlf = parseTxlf(TXLF);
    const wc = [wcSeg({ sentId: 'x', index: 1, source: '；  陕西省   621；' })];
    const { fills, report } = alignTxlfToWebcat(txlf, wc);
    // either matched with non-empty text or went to manual review — never a blank write
    expect(fills.every((f) => f.targetText.trim())).toBe(true);
    expect(report.filled === fills.length).toBe(true);
  });
});

describe('fill verify entity decoding (regression: &#8216; false mismatch)', () => {
  it('compares visible text, not entity spelling', () => {
    expect(normalizeForCompare('&#8216;AI doctors&#8217;')).toBe(normalizeForCompare('‘AI doctors’'));
    expect(normalizeForCompare('R&amp;D')).toBe(normalizeForCompare('R&D'));
    expect(normalizeForCompare('a&nbsp;b')).toBe(normalizeForCompare('a b'));
  });
});

describe('translations file reading (regression: JSONL starting with {)', () => {
  it('parses per-line JSON objects when the whole file is not one JSON value', async () => {
    const { readTranslationsFile } = await import('./sentences.js');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webcat-jsonl-'));
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, '{"sentId":"1","text":"甲"}\n{"sentId":"2","text":"乙"}\n', 'utf-8');
    expect(readTranslationsFile(file)).toEqual([
      { sentId: '1', text: '甲' },
      { sentId: '2', text: '乙' },
    ]);
    const mapFile = path.join(dir, 'map.json');
    fs.writeFileSync(mapFile, '{"1":"甲","2":"乙"}', 'utf-8');
    expect(readTranslationsFile(mapFile)).toEqual([
      { sentId: '1', text: '甲' },
      { sentId: '2', text: '乙' },
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
