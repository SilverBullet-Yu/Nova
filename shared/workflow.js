/* Nova · 本地草案生命周期。工具适配器负责领域校验及原子提交。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.Rhythm = root.Rhythm || {}; root.Rhythm.workflow = factory(); }
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  function createWorkflow({ tools, version, now, rulesVersion, onSettled, traceVersion = version }) {
    const directory = new Map(Object.entries(tools).map(([name, tool]) => [name, { ...tool }]));
    const drafts = new Map();
    const trace = [];

    function record(draft, status) {
      draft.status = status;
      const event = { id: draft.id, tool: draft.tool, at: now(), planVersion: draft.traceVersion, rulesVersion, status };
      trace.push(event);
      if (status !== 'pending' && onSettled) onSettled({ ...event });
      if (status !== 'pending') delete draft.result;
      return { id: draft.id, status };
    }

    function preview(tool, input) {
      if (!directory.has(tool)) return { status: 'unsupported' };
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
      const id = 'draft-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      const draft = { id, tool, planVersion: version(), traceVersion: traceVersion() };
      drafts.set(draft.id, draft);
      try {
        draft.result = structuredClone(directory.get(tool).preview(input));
        return { ...record(draft, 'pending'), result: structuredClone(draft.result) };
      } catch {
        return record(draft, 'failed');
      }
    }

    function settle(id, confirm) {
      const draft = drafts.get(id);
      if (!draft) return { status: 'unknown' };
      if (draft.status !== 'pending') return { id, status: draft.status };
      if (!confirm) return record(draft, 'rejected');
      if (draft.planVersion !== version()) return record(draft, 'stale');
      draft.status = 'committing';
      try {
        directory.get(draft.tool).commit(draft.result);
      } catch {
        return record(draft, 'failed');
      }
      return record(draft, 'committed');
    }

    return { preview, confirm: id => settle(id, true), reject: id => settle(id, false), events: () => structuredClone(trace) };
  }

  return { createWorkflow };
});
