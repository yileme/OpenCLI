/**
 * `opencli webcat confirm` — mark segments as confirmed (or withdraw confirmation).
 */

import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { WEBCAT_DOMAIN, flowGetSentence, getTaskDetail, loadSession, normalizeSegment, segmentMatchesFilter, webcatFetch } from './_api.js';

async function collectIdsByFilter(session, docId, filter) {
  const page = await flowGetSentence(session, {
    docId,
    pageSize: 500,
    splitIndex: session.splitIndex || '0',
    filterEmptySourceAndTarget: true,
  });
  return page.list
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
