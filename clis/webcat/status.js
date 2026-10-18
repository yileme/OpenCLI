/**
 * `opencli webcat status` — what document is the CLI session pointed at, and how far along is it.
 */

import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  WEBCAT_DOMAIN,
  getTaskDetail,
  getWebcatSessionFile,
  loadSession,
  payloadOf,
  sumSentenceCount,
  webcatFetch,
} from './_api.js';

async function getLanguageNames(session) {
  // Map languageId -> display name ("英语 (English)"). Best-effort: failures
  // degrade to bare ids instead of failing the whole status command.
  try {
    const envelope = await webcatFetch('/mt/info/getLanguageList', { session, method: 'POST', data: {} });
    const payload = payloadOf(envelope);
    const list = Array.isArray(payload) ? payload : payload?.list;
    const map = new Map();
    if (Array.isArray(list)) {
      for (const lang of list) {
        if (lang?.languageId === undefined) continue;
        const name = String(lang.languageName ?? '').trim();
        const en = String(lang.en ?? '').trim();
        map.set(String(lang.languageId), name && en ? `${name} (${en})` : name || en);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

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
  columns: ['docId', 'taskId', 'docName', 'sourceLang', 'targetLang', 'taskStatus', 'total', 'filterTotal', 'session_age_seconds'],
  func: async (kwargs) => {
    const session = loadSession();
    const detail = await getTaskDetail(session);
    const languageNames = await getLanguageNames(session);
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
      sourceLang: languageNames.get(String(detail.sourceLangId)) ?? '',
      targetLang: languageNames.get(String(detail.targetLangId)) ?? '',
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
