/**
 * `opencli webcat status` — what document is the CLI session pointed at, and how far along is it.
 */

import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  WEBCAT_DOMAIN,
  getTaskDetail,
  getWebcatSessionFile,
  loadSession,
  sumSentenceCount,
} from './_api.js';

function sessionAgeSeconds(session) {
  const savedAt = Date.parse(session.savedAt ?? '');
  if (!Number.isFinite(savedAt)) return null;
  return Math.round((Date.now() - savedAt) / 1000);
}

export const command = cli({
  site: 'webcat',
  name: 'status',
  access: 'read',
  description: 'Show the current WebCAT (云译客) task, language pair, and translation progress',
  domain: WEBCAT_DOMAIN,
  strategy: Strategy.LOCAL,
  browser: false,
  defaultFormat: 'plain',
  args: [
    { name: 'skip-counts', type: 'bool', default: false, help: 'Skip the sentence-count request (fewer API calls)' },
  ],
  columns: ['docId', 'taskId', 'docName', 'sourceLangId', 'targetLangId', 'taskStatus', 'total', 'filterTotal', 'session_age_seconds'],
  func: async (kwargs) => {
    const session = loadSession();
    const detail = await getTaskDetail(session);
    let counts = {};
    if (kwargs['skip-counts'] !== true) {
      try {
        counts = await sumSentenceCount(session, { docId: detail.docId });
      } catch {
        counts = {};
      }
    }
    return {
      docId: detail.docId ?? '',
      taskId: detail.taskId ?? '',
      docName: detail.docName ?? detail.taskName ?? detail.fileName ?? '',
      projectName: detail.projectName ?? detail.groupName ?? '',
      sourceLangId: detail.sourceLangId ?? '',
      targetLangId: detail.targetLangId ?? '',
      taskStatus: detail.taskStatus ?? '',
      taskClassify: detail.taskClassify ?? '',
      taskType: detail.taskType ?? '',
      total: counts.total ?? '',
      filterTotal: counts.filterTotal ?? '',
      counts,
      ck: session.ck,
      editorUrl: session.url,
      session_age_seconds: sessionAgeSeconds(session),
      session_file: getWebcatSessionFile(),
    };
  },
});

export const __test__ = { command, sessionAgeSeconds };
