/**
 * `opencli webcat count` — raw sentence counters for the open document.
 */

import { cli, Strategy } from '@jackwener/opencli/registry';
import { WEBCAT_DOMAIN, getTaskDetail, loadSession, sumSentenceCount } from './_api.js';

export const command = cli({
  site: 'webcat',
  name: 'count',
  access: 'read',
  description: 'Show raw WebCAT sentence counters (total, filtered total, ...) for the open document',
  domain: WEBCAT_DOMAIN,
  strategy: Strategy.LOCAL,
  browser: false,
  args: [],
  func: async () => {
    const session = loadSession();
    const detail = await getTaskDetail(session);
    const counts = await sumSentenceCount(session, { docId: detail.docId });
    return { docId: detail.docId ?? '', ...counts };
  },
});

export const __test__ = { command };
