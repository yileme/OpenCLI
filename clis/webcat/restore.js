/**
 * `opencli webcat restore` — roll targets back from a fill backup snapshot.
 *
 * fill (default --backup) writes ~/.opencli/webcat-backups/<docId>-<stamp>.json
 * before touching anything. This command pushes a chosen snapshot back.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { WEBCAT_DOMAIN, getTaskDetail, loadSession } from './_api.js';
import { getBackupDir, pushTargetsResilient } from './fill.js';

function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const file = path.join(dir, name);
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return { file, name, docId: parsed.docId ?? '', savedAt: parsed.savedAt ?? '', segments: Object.keys(parsed.segments ?? {}).length };
      } catch {
        return { file, name, docId: '?', savedAt: '?', segments: 0, corrupt: true };
      }
    })
    .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}

export const command = cli({
  site: 'webcat',
  name: 'restore',
  access: 'write',
  description: 'Restore WebCAT targets from a fill backup snapshot',
  domain: WEBCAT_DOMAIN,
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'file', positional: true, help: 'Backup file (from `fill` output); defaults to the newest snapshot for the open doc' },
    { name: 'dry-run', type: 'bool', default: false, help: 'Show what would be restored without writing' },
    { name: 'chunk', type: 'int', default: 40, help: 'Segments per batch-save-target request' },
  ],
  columns: ['docId', 'segments_in_backup', 'restored', 'backup_file'],
  func: async (kwargs) => {
    const session = loadSession();
    const detail = await getTaskDetail(session);
    const docId = detail.docId;
    if (!docId) throw new CommandExecutionError('WebCAT task detail has no docId');

    const backups = listBackups(getBackupDir());
    let target;
    if (kwargs.file) {
      target = backups.find((b) => b.file === path.resolve(String(kwargs.file)) || b.name === String(kwargs.file));
      if (!target) throw new ArgumentError(`Backup not found: ${kwargs.file}`, `Run \`webcat restore\` with no argument to list snapshots.`);
    } else {
      const forDoc = backups.filter((b) => String(b.docId) === String(docId));
      if (forDoc.length === 0) {
        return { docId, segments_in_backup: 0, restored: 0, backups_available: backups.length, note: 'No snapshots for this document. Snapshots are written by fill --backup (default).' };
      }
      target = forDoc[0];
    }

    const parsed = JSON.parse(fs.readFileSync(target.file, 'utf-8'));
    const entries = Object.entries(parsed.segments ?? {});
    const items = entries.map(([sentId, seg]) => ({
      sentId,
      indexId: sentId,
      targetPlaceholder: seg.targetPlaceholder ?? '',
      sourceHasChange: false,
      targetHasChange: true,
      targetText: seg.targetText ?? '',
    }));

    if (kwargs['dry-run'] === true) {
      return { docId, dry_run: true, segments_in_backup: items.length, restored: 0, backup_file: target.file };
    }
    if (items.length > 0) {
      await pushTargetsResilient(session, docId, items, { chunkSize: Number(kwargs.chunk ?? 40) });
    }
    return { docId, segments_in_backup: items.length, restored: items.length, backup_file: target.file };
  },
});

export const __test__ = { command, listBackups };
