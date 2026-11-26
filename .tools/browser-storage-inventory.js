(function (root, factory) {
  'use strict';
  var api = factory(root);
  root.NovaStorageInventory = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof module === 'undefined' && !root.__novaInventoryLoading && root.localStorage && root.console) {
    api.run().then(function (result) {
      root.console.log(JSON.stringify(result, null, 2));
    }).catch(function (error) {
      root.console.error(JSON.stringify({ ok: false, error: error && error.message ? error.message : 'inventory failed' }));
    });
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var KEYS = ['zx.overlay', 'zx.op_queue', 'zx.pending_plan', 'zx.server_plan_version', 'zx.trash'];
  var TERMINAL = ['done', 'skipped', 'abandoned', 'substituted'];

  function parse(raw) {
    try { return { ok: true, value: JSON.parse(raw) }; } catch (e) { return { ok: false }; }
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function segments(model) {
    var current = 0, original = 0;
    (model.placements || []).forEach(function (placement) {
      current += Array.isArray(placement.currentSegments) ? placement.currentSegments.length : 0;
      original += Array.isArray(placement.originalSegments) ? placement.originalSegments.length : 0;
    });
    return { current: current, original: original };
  }

  function numberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function overlaySummary(raw, parsed) {
    if (!parsed.ok) return { present: true, parseOk: false, classificationHint: 'C', issues: ['invalid-json'] };
    var overlay = parsed.value;
    if (!isObject(overlay)) return { present: true, parseOk: false, classificationHint: 'C', issues: ['not-object'] };
    var tasks = Array.isArray(overlay.tasks) ? overlay.tasks : [];
    var ids = new Set(tasks.map(function (task) { return task && task.id; }));
    var duplicates = tasks.length - ids.size;
    var terminal = {};
    TERMINAL.forEach(function (key) { terminal[key] = tasks.filter(function (task) { return task && task[key] === true; }).length; });
    var model = isObject(overlay.placementModel) ? overlay.placementModel : null;
    var placements = model && Array.isArray(model.placements) ? model.placements : [];
    var unplanned = model && Array.isArray(model.unplanned) ? model.unplanned : [];
    var dangling = placements.filter(function (item) { return !ids.has(item && item.taskId); }).length +
      unplanned.filter(function (item) { return !ids.has(item && item.taskId); }).length;
    var covered = new Set(unplanned.map(function (item) { return item && item.taskId; }));
    placements.forEach(function (item) {
      if (item && Array.isArray(item.currentSegments) && item.currentSegments.length) covered.add(item.taskId);
    });
    var pendingMissing = tasks.filter(function (task) {
      return task && !TERMINAL.some(function (key) { return task[key] === true; }) && !covered.has(task.id);
    }).length;
    var legacyBlocks = 0;
    var legacyEvidenceByField = {};
    [overlay.week, overlay.weekShift].forEach(function (week, weekIndex) {
      if (Array.isArray(week)) week.forEach(function (day) {
        if (day && Array.isArray(day.segs)) {
          var count = day.segs.filter(Array.isArray).length;
          legacyBlocks += count;
          var field = weekIndex === 0 ? 'week' : 'weekShift';
          legacyEvidenceByField[field] = (legacyEvidenceByField[field] || 0) + count;
        }
      });
    });
    var issues = [];
    if (duplicates) issues.push('duplicate-task-ids');
    if (dangling) issues.push('dangling-model-references');
    if (pendingMissing) issues.push('pending-task-coverage-missing');
    if (model && (!Array.isArray(model.days) || model.days.length !== 7)) issues.push('model-days-not-seven');
    if (model && (!Array.isArray(model.placements) || !Array.isArray(model.unplanned))) issues.push('model-collections-invalid');
    if (overlay.format !== 'nova-overlay') issues.push('overlay-format-invalid');
    if ([1, 2, 3].indexOf(overlay.version) < 0) issues.push('overlay-version-invalid');
    if (overlay.version === 3 && overlay.syncMode !== 'local-only') issues.push('overlay-sync-mode-invalid');
    if (overlay.version === 3 && (!Number.isInteger(overlay.revision) || overlay.revision < 0)) issues.push('overlay-revision-invalid');
    if (overlay.version === 3 && typeof overlay.installId !== 'string') issues.push('overlay-install-id-invalid');
    var classification = model ? (issues.length ? 'C' : 'A') : (legacyBlocks ? 'C' : 'B');
    var taskProfiles = tasks.map(function (task, index) {
      return {
        index: index,
        est: numberOrNull(task.est), estMin: numberOrNull(task.estMin), actual: numberOrNull(task.actual),
        plannedEst: numberOrNull(task.plannedEst), originalEst: numberOrNull(task.originalEst), weight: numberOrNull(task.weight),
        done: task.done === true, skipped: task.skipped === true, deferred: task.deferred === true,
        abandoned: task.abandoned === true, substituted: task.substituted === true,
        hasDate: typeof task.date === 'string' && task.date.length > 0,
        hasTime: typeof task.time === 'string' && task.time.length > 0,
        dayAssignPresent: isObject(overlay.dayAssign) && Object.prototype.hasOwnProperty.call(overlay.dayAssign, task.id),
        locked: isObject(overlay.locks) && overlay.locks[task.id] === true,
        estimateConflict: Object.prototype.hasOwnProperty.call(task, 'est') && Object.prototype.hasOwnProperty.call(task, 'estMin') && task.est !== task.estMin,
        fieldKeys: Object.keys(task).sort()
      };
    });
    var weekProfiles = ['week', 'weekShift'].map(function (field) {
      var week = overlay[field];
      return {
        field: field,
        days: Array.isArray(week) ? week.map(function (day) {
          return {
            total: numberOrNull(day && day.total), buf: numberOrNull(day && day.buf),
            normalUsed: numberOrNull(day && day.normalUsed), bufferUsed: numberOrNull(day && day.bufferUsed),
            capacityMin: numberOrNull(day && day.capacityMin), bufferCapacityMin: numberOrNull(day && day.bufferCapacityMin),
            datePresent: typeof (day && day.date) === 'string',
            segments: day && Array.isArray(day.segs) ? day.segs.length : 0,
            arraySegments: day && Array.isArray(day.segs) ? day.segs.filter(Array.isArray).length : 0
          };
        }) : []
      };
    });
    var availTrueCells = Array.isArray(overlay.avail) ? overlay.avail.reduce(function (sum, row) {
      return sum + (Array.isArray(row) ? row.filter(function (cell) { return cell === true; }).length : 0);
    }, 0) : 0;
    return {
      present: true, parseOk: true, classificationHint: classification,
      formatType: typeof overlay.format, version: typeof overlay.version === 'number' ? overlay.version : null,
      syncModeType: typeof overlay.syncMode, revisionType: typeof overlay.revision, updatedAtType: typeof overlay.updatedAt,
      installIdPresent: typeof overlay.installId === 'string' && overlay.installId.length > 0,
      planVersionPresent: typeof overlay.planVersion === 'string' && overlay.planVersion.length > 0,
      topLevelKeys: Object.keys(overlay).sort(),
      nestedSnapshotPresent: !!overlay.snapshot, nestedDataPresent: !!overlay.data, nestedStatePresent: !!overlay.state,
      tasks: tasks.length, uniqueTaskIds: ids.size, duplicateTaskIds: duplicates,
      sessions: Array.isArray(overlay.sessions) ? overlay.sessions.length : 0,
      terminal: terminal, deferred: tasks.filter(function (task) { return task && task.deferred === true; }).length,
      placementModelPresent: !!model, modelSchemaVersion: model ? model.schemaVersion : null,
      modelDays: model && Array.isArray(model.days) ? model.days.length : 0,
      placements: placements.length, unplanned: unplanned.length,
      segmentCounts: model ? segments(model) : { current: 0, original: 0 },
      legacyBlockEvidence: legacyBlocks, legacyEvidenceByField: legacyEvidenceByField, issues: issues,
      taskProfiles: taskProfiles, weekProfiles: weekProfiles,
      dayAssignEntries: isObject(overlay.dayAssign) ? Object.keys(overlay.dayAssign).length : 0,
      lockedEntries: isObject(overlay.locks) ? Object.keys(overlay.locks).filter(function (id) { return overlay.locks[id] === true; }).length : 0,
      replanSnapshotTasks: isObject(overlay.replanSnapshot) && Array.isArray(overlay.replanSnapshot.tasks) ? overlay.replanSnapshot.tasks.length : 0,
      availTrueCells: availTrueCells,
      deferredTopLevel: Array.isArray(overlay.deferred) ? { type: 'array', count: overlay.deferred.length } : { type: typeof overlay.deferred, count: 0 }
    };
  }

  async function run(storageOverride) {
    var storage = storageOverride || root.localStorage;
    if (!storage) throw new Error('localStorage unavailable');
    var result = {
      schema: 'nova-browser-storage-inventory-v1', ok: true, readOnly: true,
      page: { protocol: root.location && root.location.protocol ? root.location.protocol : null },
      keys: {}
    };
    for (var key of KEYS) {
      var raw = storage.getItem(key);
      if (raw === null || raw === undefined) {
        result.keys[key] = { present: false };
        continue;
      }
      var parsed = parse(raw);
      var entry = { present: true, bytes: new TextEncoder().encode(raw).length, parseOk: parsed.ok };
      if (root.crypto && root.crypto.subtle) {
        var digest = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
        entry.sha256 = Array.from(new Uint8Array(digest)).map(function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
      }
      if (key === 'zx.overlay') Object.assign(entry, overlaySummary(raw, parsed));
      if (key === 'zx.op_queue' && parsed.ok) {
        entry.array = Array.isArray(parsed.value);
        entry.items = Array.isArray(parsed.value) ? parsed.value.length : 0;
        entry.pending = Array.isArray(parsed.value) ? parsed.value.filter(function (item) { return !!(item && item.pending); }).length : 0;
      }
      if (key === 'zx.pending_plan' && parsed.ok) entry.object = isObject(parsed.value);
      if (key === 'zx.trash' && parsed.ok && isObject(parsed.value)) {
        entry.atType = typeof parsed.value.at;
        entry.snapshotPresent = !!parsed.value.snapshot;
        entry.snapshotTasks = parsed.value.snapshot && Array.isArray(parsed.value.snapshot.tasks) ? parsed.value.snapshot.tasks.length : 0;
      }
      result.keys[key] = entry;
    }
    return result;
  }

  return { run: run };
}));
