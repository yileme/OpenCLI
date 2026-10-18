/**
 * `opencli webcat submit` — hand the task back to WebCAT (`/task/info/finishTask`).
 *
 * Irreversible from the CLI's point of view, so it runs as a preview unless
 * `--yes` is passed.
 */

import { CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { WEBCAT_DOMAIN, getTaskDetail, loadSession, webcatFetch } from './_api.js';

export const command = cli({
  site: 'webcat',
  name: 'submit',
  access: 'write',
  description: 'Finish/submit the open WebCAT task (requires --yes)',
  domain: WEBCAT_DOMAIN,
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'yes', type: 'bool', default: false, help: 'Actually submit — without it this is a preview only' },
    { name: 'status', type: 'int', default: 3, help: 'Task status to send (WebCAT UI submits 3)' },
  ],
  columns: ['taskId', 'docId', 'status', 'submitted'],
  func: async (kwargs) => {
    const session = loadSession();
    const detail = await getTaskDetail(session);
    const taskId = detail.taskId;
    if (!taskId) throw new CommandExecutionError('WebCAT task detail has no taskId');
    const status = Number(kwargs.status ?? 3);
    if (!Number.isSafeInteger(status) || status <= 0) throw new CommandExecutionError('--status must be a positive integer');

    if (kwargs.yes !== true) {
      return {
        taskId,
        docId: detail.docId ?? '',
        status,
        submitted: false,
        preview: 'Add --yes to actually submit this task.',
      };
    }

    await webcatFetch('/task/info/finishTask', { session, data: { taskId, status } });
    return { taskId, docId: detail.docId ?? '', status, submitted: true };
  },
});

export const __test__ = { command };
