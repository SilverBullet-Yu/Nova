/* Nova · 本地草案生命周期。工具适配器负责领域校验及原子提交。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.Rhythm = root.Rhythm || {}; root.Rhythm.workflow = factory(); }
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  function positiveLimit(value, fallback, max, name) {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > max) {
      throw new RangeError(name + ' 必须是 1–' + max + ' 的整数');
    }
    return n;
  }

  function createWorkflow({ tools, version, now, rulesVersion, onSettled, traceVersion = version, maxTrace = 200, maxDrafts = 20 }) {
    const directory = new Map(Object.entries(tools).map(([name, tool]) => [name, { ...tool }]));
    const drafts = new Map();
    const settled = new Map();
    const trace = [];
    const traceLimit = positiveLimit(maxTrace, 200, 10000, 'maxTrace');
    const draftLimit = positiveLimit(maxDrafts, 20, 1000, 'maxDrafts');

    function record(draft, status) {
      draft.status = status;
      const event = { id: draft.id, tool: draft.tool, at: now(), planVersion: draft.traceVersion, rulesVersion, status };
      trace.push(event);
      if (trace.length > traceLimit) trace.splice(0, trace.length - traceLimit);
      if (status !== 'pending' && onSettled) onSettled({ ...event });
      if (status !== 'pending') {
        delete draft.result;
        drafts.delete(draft.id);
        settled.set(draft.id, draft);
        if (settled.size > draftLimit) settled.delete(settled.keys().next().value);
      }
      return { id: draft.id, status };
    }

    function preview(tool, input) {
      if (!directory.has(tool)) return { status: 'unsupported' };
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
      const id = 'draft-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      const draft = { id, tool, planVersion: version(), traceVersion: traceVersion() };
      if (drafts.size >= draftLimit) settle(drafts.keys().next().value, false);
      drafts.set(draft.id, draft);
      try {
        draft.result = structuredClone(directory.get(tool).preview(input));
        return { ...record(draft, 'pending'), result: structuredClone(draft.result) };
      } catch {
        return record(draft, 'failed');
      }
    }

    function settle(id, confirm) {
      const draft = drafts.get(id) || settled.get(id);
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
