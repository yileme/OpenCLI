/**
 * `opencli webcat import` — backfill a WebCAT task from a Wordfast TXLF export.
 *
 * Runs the alignment+tag engine in clis/webcat/txlf.js against the open task:
 *   webcat import --file job.txlf --dry-run   → alignment report only
 *   webcat import --file job.txlf             → write tag-correct translations
 */

import * as fs from 'node:fs';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { WEBCAT_DOMAIN, getTaskDetail, loadSession } from './_api.js';
import { collectSegments } from './sentences.js';
import { pushTargets, fetchSegmentsByIds } from './fill.js';
import { alignTxlfToWebcat, parseTxlf, tagSetsMatch } from './txlf.js';

function readTxlfFile(file) {
  const resolved = String(file ?? '').trim();
  if (!resolved) throw new ArgumentError('--file <path> to the TXLF export is required');
  if (!fs.existsSync(resolved)) throw new ArgumentError(`TXLF file not found: ${resolved}`);
  const text = fs.readFileSync(resolved, 'utf-8');
  const segments = parseTxlf(text);
  if (segments.length === 0) throw new CommandExecutionError(`No trans-units found in ${resolved}`, 'Export the file again from Wordfast Pro (TXLF) and retry.');
  return segments;
}

export const command = cli({
  site: 'webcat',
  name: 'import',
  access: 'write',
  description: 'Backfill the open WebCAT task from a Wordfast TXLF export (aligned, inline tags preserved)',
  domain: WEBCAT_DOMAIN,
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'file', required: true, help: 'Path to the .txlf export from Wordfast Pro' },
    { name: 'dry-run', type: 'bool', default: false, help: 'Show the alignment report without writing' },
    { name: 'chunk', type: 'int', default: 40, help: 'Segments per batch-save-target request' },
    { name: 'overwrite', type: 'bool', default: false, help: 'Also rewrite segments whose current target already equals the TXLF translation' },
    { name: 'out', help: 'Write the aligned fill payload (JSONL) to this file' },
  ],
  columns: ['docId', 'txlf_segments', 'filled', 'identical_skipped', 'locked_skipped', 'no_match', 'tag_mismatches'],
  func: async (kwargs) => {
    const session = loadSession();
    const detail = await getTaskDetail(session);
    const docId = detail.docId;
    if (!docId) throw new CommandExecutionError('WebCAT task detail has no docId');

    const txlf = readTxlfFile(kwargs.file);
    const wcSegments = await collectSegments(session, docId, { pageSize: 500, maxSegments: 20000 });

    const { fills, report } = alignTxlfToWebcat(txlf, wcSegments, { skipIdentical: kwargs.overwrite !== true });

    // Pre-write gate: refuse to write anything unless every fill preserves the
    // source tag set exactly. wcSegments may be raw DTOs (sourcePlaceholder) or
    // normalized (sourceHtml) — resolve the source html per segment.
    const sourceHtmlOf = (seg) => seg?.sourceHtml ?? seg?.sourcePlaceholder ?? seg?.sourceText ?? '';
    const byId = new Map(wcSegments.map((s) => [s.sentId, s]));
    const tagMismatches = fills
      .filter((f) => !tagSetsMatch(sourceHtmlOf(byId.get(f.sentId)), f.html))
      .map((f) => f.sentId);

    if (kwargs.out) {
      fs.writeFileSync(String(kwargs.out), `${fills.map((f) => JSON.stringify(f)).join('\n')}\n`, 'utf-8');
    }

    const summary = {
      docId,
      docName: detail.docName ?? '',
      txlf_segments: txlf.length,
      matched_by_pass: { exact: report.pass1, row_cell: report.pass2Row, merge: report.pass3Merge, prefix_cell: report.pass4Prefix, row_tail: report.pass5Tail },
      filled: fills.length,
      identical_skipped: report.identicalSkipped,
      locked_skipped: report.lockedSkipped,
      no_match: report.noMatch.length,
      no_match_segments: report.noMatch.slice(0, 30),
      tag_mismatches: tagMismatches.length,
    };

    if (tagMismatches.length > 0) {
      summary.written = 0;
      summary.error_detail = `Refusing to write: ${tagMismatches.length} segment(s) would drop or invent <img> tags. Re-run with --out to inspect.`;
      return summary;
    }

    if (kwargs['dry-run'] === true) {
      summary.dry_run = true;
      summary.written = 0;
      return summary;
    }

    if (fills.length === 0) return { ...summary, written: 0 };

    const items = fills.map((f) => ({
      sentId: f.sentId,
      indexId: f.sentId,
      targetPlaceholder: f.html,
      sourceHasChange: false,
      targetHasChange: true,
      targetText: f.targetText,
    }));
    await pushTargets(session, docId, items, { chunkSize: Number(kwargs.chunk ?? 40) });

    // verify by re-reading
    const reread = await fetchSegmentsByIds(session, docId, fills.map((f) => f.sentId));
    let verified = 0;
    const mismatches = [];
    for (const f of fills) {
      const dto = reread.get(f.sentId);
      const actual = dto ? String(dto.targetText ?? '').replace(/\s+/g, ' ').trim() : null;
      const expected = f.targetText.replace(/\s+/g, ' ').trim();
      if (actual === expected) verified++;
      else mismatches.push({ sentId: f.sentId, expected, actual });
    }

    return {
      ...summary,
      written: items.length,
      verified,
      mismatch_count: mismatches.length,
      mismatches: mismatches.slice(0, 20),
    };
  },
});

export const __test__ = { command, readTxlfFile };
