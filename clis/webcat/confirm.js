/**
 * `opencli webcat confirm` — mark segments as confirmed (or withdraw confirmation).
 */

import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { WEBCAT_DOMAIN, flowGetSentence, getTaskDetail, loadSession, normalizeSegment, segmentMatchesFilter, webcatFetch } from './_api.js';

async function collectIdsByFilter(session, docId, filter) {
  // Page through the whole document (both directions) so --filter never
  // silently truncates on documents larger than one page.
  const ids = [];
  const seen = new Set();
  const base = {
    docId,
    pageSize: 500,
    splitIndex: session.splitIndex || '0',
    filterEmptySourceAndTarget: true,
  };
  const initial = await flowGetSentence(session, { ...base });
  const push = (list) => {
    for (const dto of list) {
      const id = String(dto?.sentId ?? '');
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(dto);
      }
    }
  };
  push(initial.list);

  if (!initial.isBottom) {
    let cursor = String(initial.list[initial.list.length - 1]?.sentId ?? '');
    while (cursor) {
      const page = await flowGetSentence(session, { ...base, pullSentId: cursor, pullDirection: 'Down' });
      if (page.list.length === 0) break;
      push(page.list);
      if (page.isBottom) break;
      const next = String(page.list[page.list.length - 1]?.sentId ?? '');
      if (!next || next === cursor) break;
      cursor = next;
    }
  }
  if (!initial.isTop) {
    let cursor = String(initial.list[0]?.sentId ?? '');
    while (cursor) {
      const page = await flowGetSentence(session, { ...base, pullSentId: cursor, pullDirection: 'Up' });
      if (page.list.length === 0) break;
      push(page.list);
      if (page.isTop) break;
      const next = String(page.list[0]?.sentId ?? '');
      if (!next || next === cursor) break;
      cursor = next;
    }
  }

  return ids
    .map((dto, index) => normalizeSegment(dto, index))
    .filter((segment) => segmentMatchesFilter(segment, filter))
    .map((segment) => segment.sentId)
    .filter(Boolean);
}

export const command = cli({
  site: 'webcat',
  name: 'confirm',
  access: 'write',
  description: 'Confirm WebCAT segments (or undo confirmation with --undo)',
  domain: WEBCAT_DOMAIN,
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'ids', help: 'Comma-separated sentIds to confirm' },
    { name: 'filter', help: 'Instead of --ids: confirm every segment matching untranslated|translated|unconfirmed|confirmed|locked|unlocked' },
    { name: 'undo', type: 'bool', default: false, help: 'Set isConfirm=false instead of true' },
    { name: 'dry-run', type: 'bool', default: false, help: 'Show what would be confirmed without writing' },
  ],
  columns: ['docId', 'isConfirm', 'count', 'sentIds'],
  func: async (kwargs) => {
    const session = loadSession();
    const detail = await getTaskDetail(session);
    const docId = detail.docId;
    if (!docId) throw new CommandExecutionError('WebCAT task detail has no docId');

    let ids = String(kwargs.ids ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    if (ids.length === 0 && kwargs.filter) {
      ids = await collectIdsByFilter(session, docId, kwargs.filter);
    }
    if (ids.length === 0) {
      throw new ArgumentError('Nothing to confirm', 'Pass --ids a,b,c or --filter <name>.');
    }

    const isConfirm = kwargs.undo !== true;
    if (kwargs['dry-run'] === true) {
      return { docId, isConfirm, count: ids.length, sentIds: ids.join(',') };
    }

    await webcatFetch('/sentence/webcatSentence/confirmSentences', {
      session,
      data: { docId, sentIds: ids.join(','), isConfirm },
    });

    return { docId, isConfirm, count: ids.length, sentIds: ids.join(',') };
  },
});

export const __test__ = { collectIdsByFilter, command };
