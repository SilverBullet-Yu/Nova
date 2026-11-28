/* 诺瓦 Nova · M1 共享纯落点模型（UMD）
 *
 * 浏览器：window.Rhythm.placementModel
 * Node   ：require('./placement-model.js')
 *
 * 边界：
 * · 只保存可验证的具体日期、IANA 时区和分钟偏移；不读时钟、随机数、环境或 I/O。
 * · 普通容量与弹性容量分列；弹性占用只由 currentSegments.isBuffer 证明。
 * · originalSegments 是创建时证据快照，任何写入都不改写它。
 * · 不读取旧 week.total / buf，也不从二者之差反推普通工时。
 * · 每个窗口限定在一个民用日内的 0..1440 分钟；跨日任务必须按日期拆段。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.Rhythm = root.Rhythm || {}; root.Rhythm.placementModel = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCHEMA_VERSION = 1;
  var MAX_DAY_MIN = 1440;
  var DOW = ['日', '一', '二', '三', '四', '五', '六'];
  var DEFAULT_PREFIX = 'pm_';

  function fail(message) {
    throw new TypeError('placementModel: ' + message);
  }

  function isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function isId(v) {
    return typeof v === 'string' && v.trim() !== '';
  }

  function inputId(v, label) {
    if (isId(v)) return v;
    if (typeof v === 'number' && isInteger(v)) return String(v);
    fail(label + ' 必须是非空 ID');
  }

  function requireId(v, label) {
    if (!isId(v)) fail(label + ' 必须是非空字符串');
    return v;
  }

  function isInteger(v) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && Math.abs(v) <= 9007199254740991;
  }

  function requireInteger(v, min, max, label) {
    if (!isInteger(v) || v < min || (max !== undefined && v > max)) {
      fail(label + ' 必须是 ' + min + '..' + (max === undefined ? '安全整数' : max) + ' 的整数');
    }
    return v;
  }

  function requireBoolean(v, label) {
    if (typeof v !== 'boolean') fail(label + ' 必须是布尔值');
    return v;
  }

  function hasOwn(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  }

  function compareText(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function parseIsoDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    var y = Number(value.slice(0, 4));
    var m = Number(value.slice(5, 7));
    var d = Number(value.slice(8, 10));
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    var date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(y, m - 1, d);
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
    return date;
  }

  function requireIsoDate(value, label) {
    if (!parseIsoDate(value)) fail(label + ' 必须是有效的 YYYY-MM-DD 日期');
    return value;
  }

  function isoFromUtc(date) {
    var y = String(date.getUTCFullYear());
    while (y.length < 4) y = '0' + y;
    return y + '-' + String(date.getUTCMonth() + 1).padStart(2, '0') + '-' + String(date.getUTCDate()).padStart(2, '0');
  }

  function addDays(value, amount) {
    var date = parseIsoDate(value);
    if (!date) fail('startDate 必须是有效的 YYYY-MM-DD 日期');
    date.setUTCDate(date.getUTCDate() + amount);
    var out = isoFromUtc(date);
    if (!parseIsoDate(out)) fail('日期超出可表示的 YYYY-MM-DD 范围');
    return out;
  }

  function weekDates(startDate) {
    requireIsoDate(startDate, 'startDate');
    var out = [];
    for (var i = 0; i < 7; i++) out.push(addDays(startDate, i));
    return out;
  }

  function weekdayOf(value) {
    var date = parseIsoDate(value);
    if (!date) fail('日期无效：' + value);
    return DOW[date.getUTCDay()];
  }

  function validateTimezone(value) {
    if (!isId(value)) fail('timezone 必须是非空 IANA 时区字符串');
    try {
      var formatter = new Intl.DateTimeFormat('en-US', { timeZone: value });
      if (!formatter.resolvedOptions().timeZone) fail('timezone 无法解析');
    } catch (err) {
      fail('timezone 无效：' + value);
    }
    return value;
  }

  function normalizePrefix(value) {
    if (value === undefined) return DEFAULT_PREFIX;
    if (typeof value !== 'string') fail('idPrefix 必须是字符串');
    return value;
  }

  function taskMinutes(raw) {
    var hasMin = hasOwn(raw, 'estMin');
    var hasEst = hasOwn(raw, 'est');
    if (hasMin && hasEst && raw.estMin !== raw.est) fail('任务 estMin 与 est 同时存在且不一致');
    var value = hasMin ? raw.estMin : (hasEst ? raw.est : 0);
    if (!isInteger(value) || value < 0) fail('任务工时必须是非负整数分钟');
    return value;
  }

  function normalizeTasks(tasks, label) {
    if (!Array.isArray(tasks)) fail(label + ' 必须是数组');
    var seen = Object.create(null);
    var out = [];
    tasks.forEach(function (raw, idx) {
      if (!isObject(raw)) fail(label + '[' + idx + '] 必须是对象');
      var id = inputId(raw.id, label + '[' + idx + '].id');
      if (seen[id]) fail(label + ' 中 taskId 重复：' + id);
      seen[id] = true;
      var subject = raw.subject === undefined ? '未分类' : raw.subject;
      if (typeof subject !== 'string') fail(label + '[' + idx + '].subject 必须是字符串');
      out.push({
        id: id,
        subject: subject,
        minutes: taskMinutes(raw),
        done: raw.done === true,
        skipped: raw.skipped === true,
        deferred: raw.deferred === true,
        abandoned: raw.abandoned === true,
        substituted: raw.substituted === true
      });
    });
    return out;
  }

  function isPending(task) {
    return !!task && !task.done && !task.skipped && !task.deferred && !task.abandoned && !task.substituted;
  }

  function normalizeLocks(locks) {
    var out = Object.create(null);
    if (locks === undefined || locks === null) return out;
    if (!isObject(locks)) fail('locks 必须是对象');
    Object.keys(locks).forEach(function (key) {
      if (locks[key] === true) {
        if (!isId(key)) fail('locks 的 taskId 必须是非空字符串');
        out[key] = true;
      }
    });
    return out;
  }

  function findTask(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function findPlacement(model, taskId) {
    for (var i = 0; i < model.placements.length; i++) {
      if (model.placements[i].taskId === taskId) return model.placements[i];
    }
    return null;
  }

  function findDay(model, date) {
    for (var i = 0; i < model.days.length; i++) if (model.days[i].date === date) return model.days[i];
    return null;
  }

  function cloneSegment(seg) {
    return {
      blockId: seg.blockId,
      taskId: seg.taskId,
      date: seg.date,
      startMin: seg.startMin,
      durMin: seg.durMin,
      isBuffer: seg.isBuffer
    };
  }

  function cloneSegments(segs) {
    return segs.map(cloneSegment);
  }

  function sortSegments(segs) {
    return segs.slice().sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 :
        a.startMin - b.startMin || a.durMin - b.durMin ||
        (a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0);
    });
  }

  function sumSegments(segs, isBuffer) {
    var total = 0;
    segs.forEach(function (seg) {
      if (seg.isBuffer === isBuffer) total += seg.durMin;
    });
    return total;
  }

  function totalMinutes(segs) {
    var total = 0;
    segs.forEach(function (seg) { total += seg.durMin; });
    return total;
  }

  function setUnplanned(model, taskId, reason) {
    var idx = -1;
    for (var i = 0; i < model.unplanned.length; i++) {
      if (model.unplanned[i].taskId === taskId) { idx = i; break; }
    }
    if (reason === null) {
      if (idx >= 0) model.unplanned.splice(idx, 1);
    } else if (idx >= 0) {
      model.unplanned[idx] = { taskId: taskId, reason: reason };
    } else {
      model.unplanned.push({ taskId: taskId, reason: reason });
    }
  }

  /* ---------- slots → days/windows ---------- */

  function windowsFromSlots(slots, dates) {
    if (!Array.isArray(slots)) fail('slots 必须是数组');
    var allowed = Object.create(null);
    dates.forEach(function (date) { allowed[date] = true; });
    var usable = [];
    slots.forEach(function (raw, idx) {
      if (!isObject(raw)) fail('slots[' + idx + '] 必须是对象');
      var date = requireIsoDate(raw.date, 'slots[' + idx + '].date');
      if (!allowed[date]) fail('slots[' + idx + '] 的日期不在本周');
      var startMin = requireInteger(raw.startMin, 0, MAX_DAY_MIN - 1, 'slots[' + idx + '].startMin');
      var durMin = requireInteger(raw.durMin, 0, MAX_DAY_MIN - startMin, 'slots[' + idx + '].durMin');
      if (hasOwn(raw, 'available') && typeof raw.available !== 'boolean') fail('slots[' + idx + '].available 必须是布尔值');
      var isBuffer = raw.isBuffer === undefined ? false : raw.isBuffer;
      requireBoolean(isBuffer, 'slots[' + idx + '].isBuffer');
      if (raw.available !== false && durMin > 0) {
        usable.push({ date: date, startMin: startMin, endMin: startMin + durMin, isBuffer: isBuffer });
      }
    });
    usable.sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : a.startMin - b.startMin || (a.isBuffer === b.isBuffer ? 0 : a.isBuffer ? 1 : -1);
    });
    for (var i = 1; i < usable.length; i++) {
      var prev = usable[i - 1];
      var cur = usable[i];
      if (cur.date === prev.date && cur.startMin < prev.endMin) fail('可用 slots 不能重叠（' + cur.date + '）');
    }
    var windows = [];
    usable.forEach(function (slot) {
      var last = windows[windows.length - 1];
      if (last && last.date === slot.date && last.isBuffer === slot.isBuffer && last.endMin === slot.startMin) {
        last.endMin = slot.endMin;
      } else {
        windows.push({ date: slot.date, startMin: slot.startMin, endMin: slot.endMin, isBuffer: slot.isBuffer });
      }
    });
    var byDate = Object.create(null);
    windows.forEach(function (w) { (byDate[w.date] || (byDate[w.date] = [])).push(w); });
    return dates.map(function (date) {
      var normal = 0;
      var buffer = 0;
      (byDate[date] || []).forEach(function (w) {
        if (w.isBuffer) buffer += w.endMin - w.startMin;
        else normal += w.endMin - w.startMin;
      });
      return {
        date: date,
        capacityMin: normal,
        bufferCapacityMin: buffer,
        windows: (byDate[date] || []).map(function (w) {
          return { startMin: w.startMin, endMin: w.endMin, isBuffer: w.isBuffer };
        })
      };
    });
  }

  /* ---------- 严格模型校验 ---------- */

  function normalizeSegment(raw, placementTaskId, dayMap, label, isHistorical) {
    if (!isObject(raw)) fail(label + ' 必须是对象');
    var blockId = requireId(raw.blockId, label + '.blockId');
    var taskId = requireId(raw.taskId, label + '.taskId');
    if (taskId !== placementTaskId) fail(label + ' 的 taskId 与所属 placement 不一致');
    var date = requireIsoDate(raw.date, label + '.date');
    var startMin = requireInteger(raw.startMin, 0, MAX_DAY_MIN - 1, label + '.startMin');
    var durMin = requireInteger(raw.durMin, 1, MAX_DAY_MIN - startMin, label + '.durMin');
    var isBuffer = requireBoolean(raw.isBuffer, label + '.isBuffer');
    /* originalSegments 是历史证据：只校验日期、时刻和归属，不要求它属于当前窗口。
       当前落点始终必须有同日、同类型的可用窗口证明。 */
    if (!isHistorical) {
      var day = dayMap[date];
      if (!day) fail(label + ' 的日期不在本周');
      var endMin = startMin + durMin;
      var inside = day.windows.some(function (w) {
        return w.isBuffer === isBuffer && startMin >= w.startMin && endMin <= w.endMin;
      });
      if (!inside) fail(label + ' 超出同类型可用窗口或跨越窗口');
    }
    return { blockId: blockId, taskId: taskId, date: date, startMin: startMin, durMin: durMin, isBuffer: isBuffer };
  }

  function validateNoOverlap(segs, label) {
    var sorted = segs.slice().sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : a.startMin - b.startMin || compareText(a.blockId, b.blockId);
    });
    for (var i = 1; i < sorted.length; i++) {
      var prev = sorted[i - 1];
      var cur = sorted[i];
      if (cur.date === prev.date && cur.startMin < prev.startMin + prev.durMin) fail(label + ' 存在时间重叠');
    }
  }

  function normalizeModel(raw) {
    if (!isObject(raw)) fail('model 必须是对象');
    if (raw.schemaVersion !== SCHEMA_VERSION) fail('schemaVersion 必须为 1');
    var startDate = requireIsoDate(raw.startDate, 'startDate');
    var timezone = validateTimezone(raw.timezone);
    var dates = weekDates(startDate);
    if (!Array.isArray(raw.days) || raw.days.length !== 7) fail('days 必须恰好包含连续 7 天');
    var dayMap = Object.create(null);
    var days = [];
    for (var i = 0; i < 7; i++) {
      var d = raw.days[i];
      if (!isObject(d)) fail('days[' + i + '] 必须是对象');
      var date = requireIsoDate(d.date, 'days[' + i + '].date');
      if (date !== dates[i]) fail('days 必须从 startDate 起按顺序连续 7 天');
      if (!Array.isArray(d.windows)) fail('days[' + i + '].windows 必须是数组');
      var windows = d.windows.map(function (w, wi) {
        if (!isObject(w)) fail('days[' + i + '].windows[' + wi + '] 必须是对象');
        var startMin = requireInteger(w.startMin, 0, MAX_DAY_MIN - 1, 'window.startMin');
        var endMin = requireInteger(w.endMin, startMin + 1, MAX_DAY_MIN, 'window.endMin');
        return { startMin: startMin, endMin: endMin, isBuffer: requireBoolean(w.isBuffer, 'window.isBuffer') };
      });
      windows.sort(function (a, b) { return a.startMin - b.startMin || (a.isBuffer === b.isBuffer ? 0 : a.isBuffer ? 1 : -1); });
      for (var j = 1; j < windows.length; j++) {
        if (windows[j].startMin < windows[j - 1].endMin) fail('days[' + i + '] 的 windows 不能重叠');
      }
      var normalCapacity = 0;
      var bufferCapacity = 0;
      windows.forEach(function (w) {
        if (w.isBuffer) bufferCapacity += w.endMin - w.startMin;
        else normalCapacity += w.endMin - w.startMin;
      });
      var capacityMin = requireInteger(d.capacityMin, 0, MAX_DAY_MIN, 'days[' + i + '].capacityMin');
      var bufferCapacityMin = requireInteger(d.bufferCapacityMin, 0, MAX_DAY_MIN, 'days[' + i + '].bufferCapacityMin');
      if (capacityMin !== normalCapacity || bufferCapacityMin !== bufferCapacity) fail('days[' + i + '] 的容量必须等于同类 windows 时长之和');
      var day = { date: date, capacityMin: capacityMin, bufferCapacityMin: bufferCapacityMin, windows: windows };
      days.push(day);
      dayMap[date] = day;
    }

    if (!Array.isArray(raw.placements)) fail('placements 必须是数组');
    var placementIds = Object.create(null);
    var taskIds = Object.create(null);
    var originalOwners = Object.create(null);
    var currentOwners = Object.create(null);
    var placements = raw.placements.map(function (p, pi) {
      if (!isObject(p)) fail('placements[' + pi + '] 必须是对象');
      var placementId = requireId(p.placementId, 'placements[' + pi + '].placementId');
      var taskId = requireId(p.taskId, 'placements[' + pi + '].taskId');
      if (placementIds[placementId]) fail('placementId 重复：' + placementId);
      if (taskIds[taskId]) fail('placement taskId 重复：' + taskId);
      placementIds[placementId] = true;
      taskIds[taskId] = true;
      if (!isId(p.source)) fail('placements[' + pi + '].source 必须是非空字符串');
      if (!Array.isArray(p.originalSegments) || !Array.isArray(p.currentSegments)) fail('placement 的 originalSegments/currentSegments 必须是数组');
      var originalSegments = p.originalSegments.map(function (s, si) {
        return normalizeSegment(s, taskId, dayMap, 'placements[' + pi + '].originalSegments[' + si + ']', true);
      });
      var currentSegments = p.currentSegments.map(function (s, si) {
        return normalizeSegment(s, taskId, dayMap, 'placements[' + pi + '].currentSegments[' + si + ']', false);
      });
      validateNoOverlap(originalSegments, 'placements[' + pi + '].originalSegments');
      validateNoOverlap(currentSegments, 'placements[' + pi + '].currentSegments');
      originalSegments.forEach(function (s) {
        if (originalOwners[s.blockId]) fail('original blockId 重复：' + s.blockId);
        originalOwners[s.blockId] = taskId;
      });
      currentSegments.forEach(function (s) {
        if (currentOwners[s.blockId]) fail('current blockId 重复：' + s.blockId);
        if (originalOwners[s.blockId] && originalOwners[s.blockId] !== taskId) fail('current blockId 属于其他任务：' + s.blockId);
        currentOwners[s.blockId] = taskId;
      });
      return {
        placementId: placementId,
        taskId: taskId,
        originalSegments: originalSegments,
        currentSegments: currentSegments,
        source: p.source
      };
    });

    var allOriginal = [];
    var allCurrent = [];
    placements.forEach(function (p) {
      allOriginal = allOriginal.concat(p.originalSegments);
      allCurrent = allCurrent.concat(p.currentSegments);
    });
    validateNoOverlap(allOriginal, '全部 originalSegments');
    validateNoOverlap(allCurrent, '全部 currentSegments');
    allCurrent.forEach(function (s) {
      if (originalOwners[s.blockId] && originalOwners[s.blockId] !== s.taskId) fail('current blockId 属于其他任务：' + s.blockId);
    });

    days.forEach(function (day) {
      var normalUsed = 0;
      var bufferUsed = 0;
      placements.forEach(function (p) {
        p.currentSegments.forEach(function (s) {
          if (s.date !== day.date) return;
          if (s.isBuffer) bufferUsed += s.durMin;
          else normalUsed += s.durMin;
        });
      });
      if (normalUsed > day.capacityMin || bufferUsed > day.bufferCapacityMin) fail(day.date + ' 的实际用量超过容量');
    });

    if (!Array.isArray(raw.unplanned)) fail('unplanned 必须是数组');
    var unplannedIds = Object.create(null);
    var unplanned = raw.unplanned.map(function (u, ui) {
      if (!isObject(u)) fail('unplanned[' + ui + '] 必须是对象');
      var taskId = requireId(u.taskId, 'unplanned[' + ui + '].taskId');
      if (unplannedIds[taskId]) fail('unplanned taskId 重复：' + taskId);
      if (!isId(u.reason)) fail('unplanned[' + ui + '].reason 必须是非空字符串');
      unplannedIds[taskId] = true;
      return { taskId: taskId, reason: u.reason };
    });

    return { schemaVersion: SCHEMA_VERSION, startDate: startDate, timezone: timezone, days: days, placements: placements, unplanned: unplanned };
  }

  /* ---------- 跨窗滚动 ----------
     窗口和当前落点都按原日期索引平移；原始落点保持创建时的历史证据。
     已释放任务的 currentSegments 为空，滚动不会从 originalSegments 将其复活。 */
  function rollWindow(model, newStartDate, idPrefix) {
    var m = normalizeModel(model);
    var startDate = requireIsoDate(newStartDate, 'newStartDate');
    var prefix = normalizePrefix(idPrefix);
    if (startDate === m.startDate) return m;
    if (startDate < m.startDate) fail('newStartDate 不能早于当前 startDate');

    var oldDates = m.days.map(function (day) { return day.date; });
    var dates = weekDates(startDate);
    var indexByDate = Object.create(null);
    oldDates.forEach(function (date, index) { indexByDate[date] = index; });
    m.startDate = startDate;
    m.days.forEach(function (day, index) { day.date = dates[index]; });

    var idState = collectIdState(m);
    var rolledIds = Object.create(null);
    m.placements.forEach(function (placement) {
      placement.currentSegments = placement.currentSegments.map(function (segment) {
        var index = indexByDate[segment.date];
        if (index === undefined) fail('currentSegments 的日期不在当前窗口');
        var date = dates[index];
        var base = generatedBlockId(prefix, placement.taskId, date, segment.startMin);
        var blockId = base;
        var suffix = 2;
        while (idState.reserved[blockId] || rolledIds[blockId]) blockId = base + ':' + suffix++;
        idState.reserved[blockId] = true;
        idState.owners[blockId] = placement.taskId;
        rolledIds[blockId] = true;
        return {
          blockId: blockId,
          taskId: segment.taskId,
          date: date,
          startMin: segment.startMin,
          durMin: segment.durMin,
          isBuffer: segment.isBuffer
        };
      });
    });
    return normalizeModel(m);
  }

  /* ---------- 创建与投影 ---------- */

  function createModel(input) {
    if (!isObject(input)) fail('createModel 需要输入对象');
    var startDate = requireIsoDate(input.startDate, 'startDate');
    var timezone = validateTimezone(input.timezone);
    var prefix = normalizePrefix(input.idPrefix);
    var dates = weekDates(startDate);
    var days = windowsFromSlots(input.slots, dates);
    var dayMap = Object.create(null);
    days.forEach(function (day) { dayMap[day.date] = day; });
    var tasks = normalizeTasks(input.tasks, 'tasks');
    if (!Array.isArray(input.blocks)) fail('blocks 必须是数组');
    var rawUnplanned = input.unplanned === undefined ? [] : input.unplanned;
    if (!Array.isArray(rawUnplanned)) fail('unplanned 必须是数组');

    var blocksByTask = Object.create(null);
    var blockIds = Object.create(null);
    input.blocks.forEach(function (raw, idx) {
      if (!isObject(raw)) fail('blocks[' + idx + '] 必须是对象');
      var blockId = requireId(raw.id, 'blocks[' + idx + '].id');
      if (blockIds[blockId]) fail('blockId 重复：' + blockId);
      blockIds[blockId] = true;
      var taskId = inputId(raw.taskId, 'blocks[' + idx + '].taskId');
      if (!findTask(tasks, taskId)) fail('blocks[' + idx + '] 引用了未知任务：' + taskId);
      var isBuffer = raw.isBuffer === undefined ? false : raw.isBuffer;
      var seg = normalizeSegment({
        blockId: blockId,
        taskId: taskId,
        date: raw.date,
        startMin: raw.startMin,
        durMin: raw.durMin,
        isBuffer: isBuffer
      }, taskId, dayMap, 'blocks[' + idx + ']');
      var reason = raw.reason === undefined ? 'schedule' : raw.reason;
      if (!isId(reason)) fail('blocks[' + idx + '].reason 必须是非空字符串');
      (blocksByTask[taskId] || (blocksByTask[taskId] = [])).push({ segment: seg, reason: reason });
    });

    var unplanned = [];
    var unplannedIds = Object.create(null);
    rawUnplanned.forEach(function (raw, idx) {
      if (!isObject(raw)) fail('unplanned[' + idx + '] 必须是对象');
      var taskId = inputId(raw.taskId, 'unplanned[' + idx + '].taskId');
      if (!findTask(tasks, taskId)) fail('unplanned[' + idx + '] 引用了未知任务：' + taskId);
      if (unplannedIds[taskId]) fail('unplanned taskId 重复：' + taskId);
      if (!isId(raw.reason)) fail('unplanned[' + idx + '].reason 必须是非空字符串');
      unplannedIds[taskId] = true;
      unplanned.push({ taskId: taskId, reason: raw.reason });
    });

    var placements = [];
    tasks.forEach(function (task) {
      var blocks = blocksByTask[task.id] || [];
      if (!blocks.length && !unplannedIds[task.id]) {
        unplannedIds[task.id] = true;
        unplanned.push({ taskId: task.id, reason: task.minutes === 0 ? '标准工时为 0，无可排内容' : '未排入可用窗口' });
      }
      if (!blocks.length) return;
      blocks.sort(function (a, b) {
        var as = a.segment;
        var bs = b.segment;
        return as.date < bs.date ? -1 : as.date > bs.date ? 1 : as.startMin - bs.startMin || compareText(as.blockId, bs.blockId);
      });
      var segments = blocks.map(function (b) { return cloneSegment(b.segment); });
      placements.push({
        placementId: prefix + 'p:' + task.id,
        taskId: task.id,
        originalSegments: cloneSegments(segments),
        currentSegments: cloneSegments(segments),
        source: blocks[0].reason
      });
    });

    return normalizeModel({
      schemaVersion: SCHEMA_VERSION,
      startDate: startDate,
      timezone: timezone,
      days: days,
      placements: placements,
      unplanned: unplanned
    });
  }

  function usageByDay(model) {
    var out = Object.create(null);
    model.days.forEach(function (day) {
      out[day.date] = { normalUsedMin: 0, bufferUsedMin: 0 };
    });
    model.placements.forEach(function (p) {
      p.currentSegments.forEach(function (s) {
        if (s.isBuffer) out[s.date].bufferUsedMin += s.durMin;
        else out[s.date].normalUsedMin += s.durMin;
      });
    });
    return out;
  }

  function summary(model) {
    var m = normalizeModel(model);
    var usage = usageByDay(m);
    var totals = { capacityMin: 0, bufferCapacityMin: 0, normalUsedMin: 0, bufferUsedMin: 0, usedMin: 0, remainingNormalMin: 0, remainingBufferMin: 0 };
    var days = m.days.map(function (day) {
      var u = usage[day.date];
      var row = {
        date: day.date,
        d: weekdayOf(day.date),
        capacityMin: day.capacityMin,
        bufferCapacityMin: day.bufferCapacityMin,
        normalUsedMin: u.normalUsedMin,
        bufferUsedMin: u.bufferUsedMin,
        usedMin: u.normalUsedMin + u.bufferUsedMin,
        remainingNormalMin: day.capacityMin - u.normalUsedMin,
        remainingBufferMin: day.bufferCapacityMin - u.bufferUsedMin
      };
      totals.capacityMin += row.capacityMin;
      totals.bufferCapacityMin += row.bufferCapacityMin;
      totals.normalUsedMin += row.normalUsedMin;
      totals.bufferUsedMin += row.bufferUsedMin;
      totals.usedMin += row.usedMin;
      totals.remainingNormalMin += row.remainingNormalMin;
      totals.remainingBufferMin += row.remainingBufferMin;
      return row;
    });
    return { days: days, totals: totals };
  }

  function projectWeek(model, tasks) {
    var m = normalizeModel(model);
    var list = normalizeTasks(tasks, 'tasks');
    var byId = Object.create(null);
    list.forEach(function (task) { byId[task.id] = task; });
    m.placements.forEach(function (p) {
      if (!byId[p.taskId]) fail('projectWeek 缺少任务科目：' + p.taskId);
    });
    var usage = usageByDay(m);
    return m.days.map(function (day) {
      var segs = [];
      var bySubject = Object.create(null);
      var current = [];
      m.placements.forEach(function (p, pi) {
        p.currentSegments.forEach(function (s) {
          if (s.date === day.date) current.push({ seg: s, subject: byId[p.taskId].subject, order: pi });
        });
      });
      current.sort(function (a, b) {
        return a.seg.startMin - b.seg.startMin || a.order - b.order || compareText(a.seg.blockId, b.seg.blockId);
      });
      current.forEach(function (item) {
        var s = item.seg;
        if (s.isBuffer) return;
        if (!bySubject[item.subject]) {
          bySubject[item.subject] = [item.subject, 0];
          segs.push(bySubject[item.subject]);
        }
        bySubject[item.subject][1] += s.durMin;
      });
      var u = usage[day.date];
      return {
        d: weekdayOf(day.date),
        date: day.date,
        segs: segs,
        buf: day.bufferCapacityMin,
        total: u.normalUsedMin + u.bufferUsedMin,
        normalUsed: u.normalUsedMin,
        bufferUsed: u.bufferUsedMin,
        capacityMin: day.capacityMin,
        bufferCapacityMin: day.bufferCapacityMin
      };
    });
  }

  function taskSegmentsMap(model) {
    var m = normalizeModel(model);
    var out = Object.create(null);
    m.placements.forEach(function (placement) {
      out[placement.taskId] = sortSegments(placement.currentSegments).map(cloneSegment);
    });
    return out;
  }

  function taskSegments(model, taskId) {
    var m = normalizeModel(model);
    var id = inputId(taskId, 'taskId');
    var p = findPlacement(m, id);
    return p ? sortSegments(p.currentSegments).map(cloneSegment) : [];
  }

  function replanWeek(model, tasks, locks) {
    var m = normalizeModel(model);
    var list = normalizeTasks(tasks, 'tasks');
    var byId = Object.create(null);
    list.forEach(function (task) { byId[task.id] = task; });
    var locked = normalizeLocks(locks);
    var usage = usageByDay(m);
    var released = Object.create(null);
    m.days.forEach(function (day) { released[day.date] = { normal: 0, buffer: 0 }; });
    m.placements.forEach(function (p) {
      var task = byId[p.taskId];
      if (!task || !isPending(task) || locked[p.taskId] === true) return;
      p.currentSegments.forEach(function (s) {
        if (s.isBuffer) released[s.date].buffer += s.durMin;
        else released[s.date].normal += s.durMin;
      });
    });
    return m.days.map(function (day) {
      var u = usage[day.date];
      var r = released[day.date];
      return {
        date: day.date,
        minutes: u.normalUsedMin,
        bufferUsed: u.bufferUsedMin,
        buffer: day.bufferCapacityMin,
        capacity: day.capacityMin,
        releasedMinutes: r.normal,
        releasedBufferMinutes: r.buffer
      };
    });
  }

  /* ---------- 装箱与稳定 ID ---------- */

  function makeFreeIntervals(model, baseSegments) {
    var free = Object.create(null);
    model.days.forEach(function (day) {
      var list = [];
      day.windows.forEach(function (w) {
        var occupied = [];
        baseSegments.forEach(function (s) {
          if (s.date !== day.date || s.isBuffer !== w.isBuffer) return;
          var start = Math.max(w.startMin, s.startMin);
          var end = Math.min(w.endMin, s.startMin + s.durMin);
          if (start < end) occupied.push({ startMin: start, endMin: end });
        });
        occupied.sort(function (a, b) { return a.startMin - b.startMin || a.endMin - b.endMin; });
        var merged = [];
        occupied.forEach(function (o) {
          var last = merged[merged.length - 1];
          if (last && o.startMin <= last.endMin) last.endMin = Math.max(last.endMin, o.endMin);
          else merged.push({ startMin: o.startMin, endMin: o.endMin });
        });
        var cursor = w.startMin;
        merged.forEach(function (o) {
          if (cursor < o.startMin) list.push({ startMin: cursor, endMin: o.startMin, isBuffer: w.isBuffer });
          cursor = Math.max(cursor, o.endMin);
        });
        if (cursor < w.endMin) list.push({ startMin: cursor, endMin: w.endMin, isBuffer: w.isBuffer });
      });
      list.sort(function (a, b) { return a.startMin - b.startMin || (a.isBuffer === b.isBuffer ? 0 : a.isBuffer ? 1 : -1); });
      free[day.date] = list;
    });
    return free;
  }

  function fillFree(free, date, minutes, isBuffer) {
    var list = free[date] || [];
    var remaining = minutes;
    var out = [];
    for (var i = 0; i < list.length && remaining > 0; i++) {
      var interval = list[i];
      if (interval.isBuffer !== isBuffer) continue;
      var take = Math.min(remaining, interval.endMin - interval.startMin);
      if (take <= 0) continue;
      out.push({ date: date, startMin: interval.startMin, durMin: take, isBuffer: isBuffer });
      remaining -= take;
      if (take === interval.endMin - interval.startMin) list.splice(i--, 1);
      else interval.startMin += take;
    }
    return out;
  }

  function fillDate(free, date, minutes) {
    var normal = fillFree(free, date, minutes, false);
    var normalUsed = totalMinutes(normal);
    var buffer = normalUsed < minutes ? fillFree(free, date, minutes - normalUsed, true) : [];
    return normal.concat(buffer);
  }

  function collectIdState(model) {
    var reserved = Object.create(null);
    var owners = Object.create(null);
    model.placements.forEach(function (p) {
      p.originalSegments.forEach(function (s) { reserved[s.blockId] = true; owners[s.blockId] = p.taskId; });
      p.currentSegments.forEach(function (s) { reserved[s.blockId] = true; owners[s.blockId] = p.taskId; });
    });
    return { reserved: reserved, owners: owners };
  }

  function generatedBlockId(prefix, taskId, date, startMin) {
    return prefix + 'b:' + taskId + ':' + date + ':' + startMin;
  }

  function assignBlockIds(segs, oldSegments, taskId, prefix, state, activeUsed) {
    var ordered = sortSegments(segs);
    var old = sortSegments(oldSegments || []);
    return ordered.map(function (seg, idx) {
      var blockId = null;
      if (old[idx] && !activeUsed[old[idx].blockId] && (!state.owners[old[idx].blockId] || state.owners[old[idx].blockId] === taskId)) {
        blockId = old[idx].blockId;
      }
      if (!blockId) {
        var base = generatedBlockId(prefix, taskId, seg.date, seg.startMin);
        blockId = base;
        var suffix = 2;
        while (state.reserved[blockId] || activeUsed[blockId]) blockId = base + ':' + suffix++;
        state.reserved[blockId] = true;
        state.owners[blockId] = taskId;
      }
      activeUsed[blockId] = true;
      return {
        blockId: blockId,
        taskId: taskId,
        date: seg.date,
        startMin: seg.startMin,
        durMin: seg.durMin,
        isBuffer: seg.isBuffer
      };
    });
  }

  function activeIds(segs) {
    var out = Object.create(null);
    segs.forEach(function (s) { out[s.blockId] = true; });
    return out;
  }

  function allCurrent(model, exceptTaskId) {
    var out = [];
    model.placements.forEach(function (p) {
      if (p.taskId === exceptTaskId) return;
      p.currentSegments.forEach(function (s) { out.push(s); });
    });
    return out;
  }

  function uniquePlacementId(model, prefix, taskId) {
    var base = prefix + 'p:' + taskId;
    var candidate = base;
    var suffix = 2;
    var exists = true;
    while (exists) {
      exists = false;
      for (var i = 0; i < model.placements.length; i++) {
        if (model.placements[i].placementId === candidate) { exists = true; break; }
      }
      if (exists) candidate = base + ':' + suffix++;
    }
    return candidate;
  }

  function dayUsage(model, date) {
    var row = null;
    summary(model).days.forEach(function (day) { if (day.date === date) row = day; });
    if (!row) fail('目标日期不在本周');
    return {
      normalUsedMin: row.normalUsedMin,
      bufferUsedMin: row.bufferUsedMin,
      usedMin: row.usedMin,
      remainingNormalMin: row.remainingNormalMin,
      remainingBufferMin: row.remainingBufferMin
    };
  }

  /* ---------- 写入：移动 / 缩放 ---------- */

  function moveTask(model, taskId, targetDate, idPrefix) {
    var m = normalizeModel(model);
    var prefix = normalizePrefix(idPrefix);
    var id = inputId(taskId, 'taskId');
    if (!findDay(m, targetDate)) return { ok: false, reason: '目标日期不在本周' };
    var placement = findPlacement(m, id);
    if (!placement) return { ok: false, reason: '任务不存在或没有当前落点' };
    var old = placement.currentSegments;
    var minutes = totalMinutes(old);
    if (minutes === 0 || old.every(function (s) { return s.date === targetDate; })) {
      var unchangedUsage = dayUsage(m, targetDate);
      return { ok: true, model: m, date: targetDate, normalUsedMin: unchangedUsage.normalUsedMin, bufferUsedMin: unchangedUsage.bufferUsedMin, usedMin: unchangedUsage.usedMin, remainingNormalMin: unchangedUsage.remainingNormalMin, remainingBufferMin: unchangedUsage.remainingBufferMin };
    }
    var base = allCurrent(m, id);
    var free = makeFreeIntervals(m, base);
    var rawSegments = fillDate(free, targetDate, minutes);
    if (totalMinutes(rawSegments) !== minutes) return { ok: false, reason: '目标日期普通窗口与弹性窗口均不足，或与现有落点冲突' };
    var state = collectIdState(m);
    var segments = assignBlockIds(rawSegments, old, id, prefix, state, activeIds(base));
    placement.currentSegments = segments;
    setUnplanned(m, id, null);
    var out = normalizeModel(m);
    var usage = dayUsage(out, targetDate);
    return { ok: true, model: out, date: targetDate, normalUsedMin: usage.normalUsedMin, bufferUsedMin: usage.bufferUsedMin, usedMin: usage.usedMin, remainingNormalMin: usage.remainingNormalMin, remainingBufferMin: usage.remainingBufferMin };
  }

  function resizeTask(model, taskId, newMinutes, idPrefix) {
    var m = normalizeModel(model);
    var prefix = normalizePrefix(idPrefix);
    var id = inputId(taskId, 'taskId');
    newMinutes = requireInteger(newMinutes, 0, 7 * MAX_DAY_MIN, 'newMinutes');
    var placement = findPlacement(m, id);
    var knownUnplanned = m.unplanned.some(function (u) { return u.taskId === id; });
    if (!placement && !knownUnplanned) return { ok: false, reason: '任务不存在或未排入' };
    var old = placement ? placement.currentSegments : [];
    var currentMinutes = totalMinutes(old);
    if (newMinutes === currentMinutes) return { ok: true, model: m };

    var dates = [];
    var quotas = Object.create(null);
    old.forEach(function (s) {
      if (dates.indexOf(s.date) < 0) dates.push(s.date);
      quotas[s.date] = (quotas[s.date] || 0) + s.durMin;
    });
    dates.sort();
    if (newMinutes > 0 && !dates.length) return { ok: false, reason: '任务没有可重排的日期' };

    var base = allCurrent(m, id);
    var free = makeFreeIntervals(m, base);
    var rawSegments = [];
    var remaining = newMinutes;
    if (newMinutes < currentMinutes) {
      dates.forEach(function (date) {
        if (remaining <= 0) return;
        var quota = Math.min(remaining, quotas[date]);
        var segs = fillDate(free, date, quota);
        if (totalMinutes(segs) !== quota) remaining = -1;
        else {
          rawSegments = rawSegments.concat(segs);
          remaining -= quota;
        }
      });
    } else {
      dates.forEach(function (date) {
        var segs = fillDate(free, date, quotas[date]);
        if (totalMinutes(segs) !== quotas[date]) remaining = -1;
        else rawSegments = rawSegments.concat(segs);
      });
      if (remaining >= 0) {
        remaining = newMinutes - currentMinutes;
        dates.forEach(function (date) {
          if (remaining <= 0) return;
          var segs = fillDate(free, date, remaining);
          rawSegments = rawSegments.concat(segs);
          remaining -= totalMinutes(segs);
        });
      }
    }
    if (remaining !== 0 || totalMinutes(rawSegments) !== newMinutes) return { ok: false, reason: '原落点日期内容量不足，无法重排全部分钟' };

    var state = collectIdState(m);
    var segments = assignBlockIds(rawSegments, old, id, prefix, state, activeIds(base));
    placement.currentSegments = segments;
    setUnplanned(m, id, newMinutes === 0 ? '工时为 0，未排入' : null);
    return { ok: true, model: normalizeModel(m) };
  }

  function releaseTask(model, taskId, reason, idPrefix) {
    var m = normalizeModel(model);
    var id = inputId(taskId, 'taskId');
    if (!isId(reason)) fail('releaseTask.reason 必须是非空字符串');
    var placement = findPlacement(m, id);
    if (placement) placement.currentSegments = [];
    setUnplanned(m, id, reason);
    return { ok: true, model: normalizeModel(m) };
  }

  function restoreTask(model, taskId, idPrefix, restoreMinutes) {
    var m = normalizeModel(model);
    var prefix = normalizePrefix(idPrefix);
    var id = inputId(taskId, 'taskId');
    var placement = findPlacement(m, id);
    if (!placement || !placement.originalSegments.length) return { ok: false, reason: '任务没有可恢复的原始落点' };
    var originalMinutes = totalMinutes(placement.originalSegments);
    var minutes = restoreMinutes === undefined ? originalMinutes : requireInteger(restoreMinutes, 0, originalMinutes, 'restoreMinutes');
    var base = allCurrent(m, id);
    var free = makeFreeIntervals(m, base);
    var quotas = Object.create(null);
    var dates = [];
    placement.originalSegments.forEach(function (original) {
      var date = findDay(m, original.date) ? original.date : m.days.find(function (day) {
        return new Date(day.date + 'T00:00:00Z').getUTCDay() === new Date(original.date + 'T00:00:00Z').getUTCDay();
      }).date;
      if (dates.indexOf(date) < 0) dates.push(date);
      quotas[date] = (quotas[date] || 0) + original.durMin;
    });
    var rawSegments = [];
    var remaining = minutes;
    for (var i = 0; i < dates.length && remaining > 0; i++) {
      var date = dates[i];
      var take = Math.min(remaining, quotas[date]);
      var segs = fillDate(free, date, take);
      if (totalMinutes(segs) !== take) return { ok: false, reason: '原始落点与当前计划冲突，无法恢复' };
      rawSegments = rawSegments.concat(segs);
      remaining -= take;
    }
    if (remaining !== 0) return { ok: false, reason: '恢复工时超出原始落点' };
    var state = collectIdState(m);
    placement.currentSegments = assignBlockIds(rawSegments, placement.originalSegments, id, prefix, state, activeIds(base));
    setUnplanned(m, id, minutes === 0 ? '工时为 0，未排入' : null);
    return { ok: true, model: normalizeModel(m) };
  }

  /* ---------- 写入：应用重排结果 ---------- */

  function normalizeNextPlacements(raw, model) {
    if (!Array.isArray(raw)) fail('result.nextPlacements 必须是数组');
    var seen = Object.create(null);
    return raw.map(function (p, pi) {
      if (!isObject(p)) fail('nextPlacements[' + pi + '] 必须是对象');
      /* 规范形状是 taskId + segments；同时接受 shared/engine/replan.js 的
         task + segs 原生形状，避免共享模型与现有引擎之间再复制一份适配逻辑。 */
      var native = !hasOwn(p, 'taskId') && isObject(p.task) && Array.isArray(p.segs);
      var taskId = inputId(native ? p.task.id : p.taskId, 'nextPlacements[' + pi + '].taskId');
      var rawSegments = native ? p.segs : p.segments;
      if (seen[taskId]) fail('nextPlacements taskId 重复：' + taskId);
      seen[taskId] = true;
      if (!Array.isArray(rawSegments)) fail('nextPlacements[' + pi + '].segments 必须是数组');
      var minutes = requireInteger(p.minutes, 0, 7 * MAX_DAY_MIN, 'nextPlacements[' + pi + '].minutes');
      var locked = native && !hasOwn(p, 'locked') ? false : requireBoolean(p.locked, 'nextPlacements[' + pi + '].locked');
      var sum = 0;
      var segments = rawSegments.map(function (s, si) {
        if (!isObject(s)) fail('nextPlacements[' + pi + '].segments[' + si + '] 必须是对象');
        var date = requireIsoDate(s.date, 'nextPlacements segment.date');
        if (!findDay(model, date)) fail('nextPlacements segment 日期不在本周');
        var value = requireInteger(s.minutes, 1, MAX_DAY_MIN, 'nextPlacements segment.minutes');
        sum += value;
        return { date: date, minutes: value, isBuffer: requireBoolean(s.isBuffer, 'nextPlacements segment.isBuffer') };
      });
      if (sum !== minutes || (minutes === 0 && segments.length)) fail('nextPlacements.minutes 必须等于 segments 分钟之和');
      return { taskId: taskId, segments: segments, minutes: minutes, locked: locked };
    });
  }

  function applyReplan(model, result, idPrefix) {
    var m = normalizeModel(model);
    var prefix = normalizePrefix(idPrefix);
    if (!isObject(result)) fail('result 必须是对象');
    if (Object.prototype.hasOwnProperty.call(result, 'accepted') || Object.prototype.hasOwnProperty.call(result, 'needsConfirmation')) {
      if (result.accepted !== true || result.needsConfirmation !== false) fail('重排结果尚未确认，不能写入落点模型');
    }
    var tasks = normalizeTasks(result.nextTasks, 'result.nextTasks');
    var byId = Object.create(null);
    tasks.forEach(function (task) { byId[task.id] = task; });
    var entries = normalizeNextPlacements(result.nextPlacements, m);
    var entryByTask = Object.create(null);
    entries.forEach(function (entry) {
      if (!byId[entry.taskId]) fail('nextPlacements 引用了 nextTasks 中不存在的任务：' + entry.taskId);
      entryByTask[entry.taskId] = entry;
    });

    var updates = [];
    var kept = [];
    function addUpdate(taskId, segments, reason) {
      updates.push({ taskId: taskId, segments: segments, reason: reason });
    }
    function findUpdate(taskId) {
      for (var i = 0; i < updates.length; i++) if (updates[i].taskId === taskId) return updates[i];
      return null;
    }

    m.placements.forEach(function (p) {
      var task = byId[p.taskId];
      var entry = entryByTask[p.taskId];
      var locked = !!entry && entry.locked;
      if (!task) {
        kept.push(p.currentSegments);
      } else if (task.abandoned || task.substituted) {
        if (locked) fail('锁定任务不能同时被放弃或替代：' + p.taskId);
        addUpdate(p.taskId, [], task.abandoned ? '任务已放弃' : '任务已被替代');
      } else if (!isPending(task) || locked) {
        kept.push(p.currentSegments);
      } else {
        addUpdate(p.taskId, null, '重排后未提供落点');
      }
    });

    entries.forEach(function (entry) {
      var task = byId[entry.taskId];
      if ((task.abandoned || task.substituted) && entry.locked) fail('锁定任务不能同时被放弃或替代：' + entry.taskId);
      if (entry.locked && !findPlacement(m, entry.taskId)) fail('锁定任务没有可保留的旧落点：' + entry.taskId);
    });

    var base = [];
    kept.forEach(function (segs) { base = base.concat(segs); });
    var free = makeFreeIntervals(m, base);
    var state = collectIdState(m);
    var active = activeIds(base);

    entries.forEach(function (entry) {
      var task = byId[entry.taskId];
      if (task.abandoned || task.substituted || !isPending(task) || entry.locked) return;
      if (entry.minutes !== task.minutes) fail('待排任务工时与落点分钟不一致：' + entry.taskId);
      var rawSegments = [];
      entry.segments.forEach(function (request) {
        var segs = fillFree(free, request.date, request.minutes, request.isBuffer);
        if (totalMinutes(segs) !== request.minutes) fail('无法可靠装入重排落点（' + entry.taskId + ' / ' + request.date + '）');
        rawSegments = rawSegments.concat(segs);
      });
      var oldPlacement = findPlacement(m, entry.taskId);
      var old = oldPlacement ? oldPlacement.currentSegments : [];
      var segments = assignBlockIds(rawSegments, old, entry.taskId, prefix, state, active);
      var update = findUpdate(entry.taskId);
      if (update) {
        update.segments = segments;
        update.reason = segments.length ? null : '重排后未排入';
      } else {
        addUpdate(entry.taskId, segments, segments.length ? null : '重排后未排入');
      }
    });

    updates.forEach(function (update) {
      var p = findPlacement(m, update.taskId);
      if (update.segments === null) update.segments = [];
      if (p) p.currentSegments = cloneSegments(update.segments);
      else if (update.segments.length) {
        m.placements.push({
          placementId: uniquePlacementId(m, prefix, update.taskId),
          taskId: update.taskId,
          originalSegments: [],
          currentSegments: cloneSegments(update.segments),
          source: 'replan'
        });
      }
      setUnplanned(m, update.taskId, update.reason);
    });

    return normalizeModel(m);
  }

  function matchesSlots(model, slots) {
    var m = normalizeModel(model);
    var dates = m.days.map(function (day) { return day.date; });
    var expected = windowsFromSlots(slots, dates);
    return expected.every(function (day, index) {
      var actual = m.days[index];
      if (day.capacityMin !== actual.capacityMin || day.bufferCapacityMin !== actual.bufferCapacityMin ||
          day.windows.length !== actual.windows.length) return false;
      return day.windows.every(function (window, windowIndex) {
        var current = actual.windows[windowIndex];
        return window.startMin === current.startMin && window.endMin === current.endMin &&
          window.isBuffer === current.isBuffer;
      });
    });
  }

  return {
    createModel: createModel,
    normalizeModel: normalizeModel,
    rollWindow: rollWindow,
    matchesSlots: matchesSlots,
    summary: summary,
    projectWeek: projectWeek,
    taskSegments: taskSegments,
    taskSegmentsMap: taskSegmentsMap,
    replanWeek: replanWeek,
    applyReplan: applyReplan,
    moveTask: moveTask,
    resizeTask: resizeTask,
    releaseTask: releaseTask,
    restoreTask: restoreTask
  };
}));
