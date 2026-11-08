/* =========================================================
   诺瓦 Nova · 目标落地 flow（Stage A / F-1.1 F-1.2 F-2.1 F-2.2 F-2.3）
   ---------------------------------------------------------
   四步同一弹层：设定目标 → 可行性判定 →（R<0.70 校准）→ 拆解草案 → 确认生效。
   约束：
   · 经典 script，IIFE 挂 ZX.flows.goal，支持 file:// 双击
   · 弹层、确认、轻提示只用 ZX.ui 原语，不另造弹窗
   · 可行性统一走 ZX.engine.feasibilityNow，不复制排程 / 可行性算法
   · 新增状态只有 ZX.state.goalDraft / planDraft，打开时初始化，关闭时清空
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var U = ZX.util;

  /* 演示口径：基准需求工时（小时）。产品化后应由知识树节点标准工时累加得出，
     这里的常量只保证 demo 的数值可复现，不与后端 seed 冲突。 */
  var BASE_HOURS = { '考研': 913, '考公': 660, '项目导学': 520 };

  /* 当前基础系数：越熟练，完成同样节点所需的标准工时越少 */
  var BASE_COEF = { '零基础': 1.30, '一轮': 1.00, '二轮': 0.75, '多战': 0.60 };

  var TYPES = ['考研', '考公', '项目导学'];
  var BASES = ['零基础', '一轮', '二轮', '多战'];
  var SUBJECTS = ['数学', '英语', '408', '政治'];

  var DISCOUNT = 0.85;      /* 折扣系数：名义可用时间的折算比例 */
  var GATE = 0.7;           /* 进入拆解的可行性阈值 */
  var TARGET_R = 0.9;       /* 校准目标：达到「合理」区间下沿 */
  var MIN_EST = 15;         /* 单计划项下限（分钟） */
  var MAX_EST = 240;        /* 单计划项上限（分钟） */
  var STEP = 15;            /* 每次加减的粒度 */
  var OVER_RATIO = 1.15;    /* 周负载超过容量 15% 判为超载 */
  var AMP_LIMIT = 0.30;     /* 相对初始草案的修改幅度阈值 */

  /* 拆解模板：6–8 项，覆盖数学 / 英语 / 408 / 政治（演示口径）
     顺序按「一天四科各一项」排，前 4 项会直接成为今天的任务 */
  var TEMPLATE = [
    { s: '数学', title: '高数 · 极限与连续 40 题', est: 90, weight: 0.92 },
    { s: '英语', title: '阅读真题 · 2 篇精读', est: 60, weight: 0.78 },
    { s: '408', title: '数据结构 · 树与二叉树 应用', est: 75, weight: 0.86 },
    { s: '政治', title: '马原 · 第 2 章 多选 60 题', est: 45, weight: 0.41 },
    { s: '数学', title: '线代 · 矩阵与特征值 20 题', est: 60, weight: 0.81 },
    { s: '408', title: '操作系统 · 进程与调度 选择 30', est: 45, weight: 0.71 },
    { s: '英语', title: '长难句 · 从句拆解 15 句', est: 30, weight: 0.62 }
  ];

  var api = null;           /* ZX.ui.sheet 控制器 */
  var step = 1;
  var initialPlan = [];     /* 初始草案快照，用于计算修改幅度 */
  var addForm = { s: '数学', title: '', min: 45 };
  var dragId = null;
  var overEl = null;

  /* ---------- 日期与数值 ---------- */
  function today0() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function parseDay(str) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''));
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    d.setHours(0, 0, 0, 0);
    return isNaN(d.getTime()) ? null : d;
  }

  function isoDay(d) {
    return d.getFullYear() + '-' + U.pad2(d.getMonth() + 1) + '-' + U.pad2(d.getDate());
  }

  function addDays(d, n) {
    var x = new Date(d.getTime());
    x.setDate(x.getDate() + n);
    return x;
  }

  /* 从今天到截止日期的整周数，至少 1 周 */
  function weeksUntil(day) {
    return Math.max(1, Math.floor((day.getTime() - today0().getTime()) / 604800000));
  }

  function coefOf(base) { return BASE_COEF[base] || 1; }

  function demandOf(type, base) {
    return Math.round((BASE_HOURS[type] || BASE_HOURS['考研']) * coefOf(base));
  }

  function clampEst(n) {
    var v = Math.round(U.num(n, MIN_EST));
    return Math.max(MIN_EST, Math.min(MAX_EST, v));
  }

  /* ---------- 草稿 ---------- */
  function defaultDraft() {
    var deadline = '2027-12-25';
    var day = parseDay(deadline);
    return {
      type: '考研',
      name: '2027 考研 · 计算机',
      deadline: deadline,
      weeklyH: 20,
      weeks: day ? weeksUntil(day) : 1,
      base: '一轮',
      demand: demandOf('考研', '一轮'),
      discount: DISCOUNT
    };
  }

  function makePlan() {
    return TEMPLATE.map(function (t, i) {
      return { id: 'd_' + (i + 1), s: t.s, title: t.title, est: t.est, weight: t.weight, order: i };
    });
  }

  function draft() { return ZX.state.goalDraft; }
  function plan() { return ZX.state.planDraft; }

  function feasOf(d) {
    return ZX.engine.feasibilityNow({
      weeklyH: d.weeklyH, weeks: d.weeks, discount: DISCOUNT, demand: d.demand
    });
  }

  function totalMin() {
    return plan().reduce(function (a, t) { return a + U.num(t.est, 0); }, 0);
  }

  function findItem(id) {
    var list = plan();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* ---------- 校准求解：只调参数，不复制 T/D 公式 ---------- */
  function solveWeekly(d, target) {
    for (var w = 1; w <= 168; w++) {
      if (feasOf({ weeklyH: w, weeks: d.weeks, demand: d.demand }).R >= target) return w;
    }
    return 168;
  }

  function solveWeeks(d, target) {
    for (var k = 1; k <= 520; k++) {
      if (feasOf({ weeklyH: d.weeklyH, weeks: k, demand: d.demand }).R >= target) return k;
    }
    return 520;
  }

  /* ---------- 渲染骨架 ---------- */
  function setHead(eyebrow, title, sub) {
    if (!api) return;
    var h = api.root.querySelector('.sheet-h');
    if (!h) return;
    var e = h.querySelector('.sheet-eyebrow');
    if (e) e.textContent = eyebrow;
    var t = h.querySelector('h2');
    if (t) t.textContent = title;
    var p = h.querySelector('p');
    if (p) p.textContent = sub;
  }

  function render() {
    if (!api) return;
    if (step === 3) captureAdd();   /* 重绘前留住「添加计划项」里已输入的内容 */
    var keep = recallFocus();
    var head, body, footer;
    if (step === 1) {
      head = ['GOAL / 新建', '设定你的目标', '先设目标，再判断可行性；不可行就先校准，不直接砍计划。'];
      body = formHtml();
      footer = formFooter();
    } else if (step === 2) {
      head = ['GOAL / 可行性', '可行性判定', 'R = T / D。低于 0.70 时先校准，再决定怎么拆。'];
      body = feasHtml();
      footer = feasFooter();
    } else {
      head = ['GOAL / 拆解', '拆解草案', '这一页只调计划项；确认后写入「计划」并生成今天的前 4 项。'];
      body = planHtml();
      footer = planFooter();
    }
    api.setBody(body);
    api.setFooter(footer);
    setHead(head[0], head[1], head[2]);
    var sheetEl = api.root.querySelector('.sheet');
    if (sheetEl) sheetEl.classList.toggle('wide', step === 3);
    restoreFocus(keep);
  }

  /* 重绘会把聚焦的元素一起换掉：先记住它的 data-sa / data-id，重绘后放回原处，
     键盘用户连续点 +/- 时焦点不会掉到弹层外面 */
  function recallFocus() {
    var el = document.activeElement;
    if (!el || !api || !api.root.contains(el) || !el.dataset) return null;
    if (!el.dataset.sa) return null;
    return { act: el.dataset.sa, id: el.dataset.id || '' };
  }

  function restoreFocus(keep) {
    if (!api) return;
    var root = api.root;
    if (keep) {
      var sel = '[data-sa="' + keep.act + '"]' + (keep.id ? '[data-id="' + keep.id + '"]' : '');
      var back = root.querySelector(sel);
      if (back && !back.disabled) { try { back.focus(); return; } catch (e) { /* 忽略 */ } }
    }
    if (root.contains(document.activeElement)) return;
    var body = root.querySelectorAll('.sheet-b button:not([disabled]),.sheet-b input:not([disabled])');
    var el = body[0] ||
      root.querySelector('.sheet-f .btn.pri:not([disabled])') ||
      root.querySelector('.sheet-f button:not([disabled])');
    if (el) { try { el.focus(); } catch (e2) { /* 忽略 */ } }
  }

  /* ---------- 第 1 步：表单 ---------- */
  function formHtml() {
    var d = draft();
    return '<div class="sa-form">' +
      '<div class="field"><label>目标类型</label>' +
        '<div class="seg sa-seg">' + TYPES.map(function (t) {
          return '<button type="button" data-sa="type" data-v="' + t + '" aria-pressed="' + (d.type === t) + '"' +
            ' class="' + (d.type === t ? 'on' : '') + '">' + t + '</button>';
        }).join('') + '</div>' +
      '</div>' +
      '<div class="field"><label for="saName">目标名称</label>' +
        '<input class="input" id="saName" data-f="name" autofocus value="' + U.esc(d.name) + '" />' +
        '<div class="hint sa-hint" data-hint="name"></div>' +
      '</div>' +
      '<div class="row2f">' +
        '<div class="field"><label for="saDeadline">截止日期</label>' +
          '<input class="input mono" id="saDeadline" data-f="deadline" type="date" value="' + U.esc(d.deadline) + '" />' +
          '<div class="hint sa-hint" data-hint="deadline"></div>' +
        '</div>' +
        '<div class="field"><label for="saWeekly">每周可用小时</label>' +
          '<input class="input mono" id="saWeekly" data-f="weekly" type="number" min="1" max="80" step="1" value="' + d.weeklyH + '" />' +
          '<div class="hint sa-hint" data-hint="weekly"></div>' +
        '</div>' +
      '</div>' +
      '<div class="field"><label>当前基础</label>' +
        '<div class="seg sa-seg">' + BASES.map(function (b) {
          return '<button type="button" data-sa="base" data-v="' + b + '" aria-pressed="' + (d.base === b) + '"' +
            ' class="' + (d.base === b ? 'on' : '') + '">' + b + '（' + BASE_COEF[b].toFixed(2) + '）</button>';
        }).join('') + '</div>' +
        '<div class="hint">基础越扎实，完成同一套节点所需的标准工时越少。</div>' +
      '</div>' +
      '<div class="notice sa-calc" id="saCalc">' + calcPreview() + '</div>' +
    '</div>';
  }

  function calcPreview() {
    var d = draft();
    return '需求 D = <b>' + d.demand + ' h</b>　' + d.type + '基准 ' + BASE_HOURS[d.type] +
      ' h × 基础系数 ' + coefOf(d.base).toFixed(2) +
      '<br>周期 = <b>' + d.weeks + ' 周</b>　每周 ' + d.weeklyH + ' h × 折扣 0.85 → 可用 T ≈ ' +
      Math.round(d.weeklyH * d.weeks * DISCOUNT) + ' h';
  }

  function formFooter() {
    return '<button type="button" class="btn ghost" data-close>取消</button>' +
      '<button type="button" class="btn pri" data-sa="next">下一步 · 可行性判定</button>';
  }

  function captureForm() {
    var d = draft();
    var n = api.$('#saName');
    var dl = api.$('#saDeadline');
    var wk = api.$('#saWeekly');
    if (n) d.name = String(n.value || '');
    if (dl) d.deadline = String(dl.value || '');
    if (wk && String(wk.value).trim() !== '') d.weeklyH = U.num(wk.value, d.weeklyH);
    d.demand = demandOf(d.type, d.base);
    var day = parseDay(d.deadline);
    if (day) d.weeks = weeksUntil(day);
  }

  function validate() {
    var d = draft();
    var errs = {};
    if (!String(d.name || '').trim()) errs.name = '请填写目标名称，例如「2027 考研 · 计算机」。';
    var day = parseDay(d.deadline);
    if (!day) errs.deadline = '请选择截止日期。';
    else if (day.getTime() <= today0().getTime()) errs.deadline = '截止日期需要晚于今天。';
    var w = U.num(d.weeklyH, 0);
    if (!(w >= 1)) errs.weekly = '每周可用小时至少 1 小时。';
    else if (w > 80) errs.weekly = '每周可用小时上限为 80 小时。';
    return errs;
  }

  function markErrors(errs) {
    ['name', 'deadline', 'weekly'].forEach(function (k) {
      var el = api.$('[data-f="' + k + '"]');
      var hint = api.$('[data-hint="' + k + '"]');
      if (!el) return;
      if (errs[k]) {
        el.classList.add('sa-bad');
        el.setAttribute('aria-invalid', 'true');
        if (hint) { hint.textContent = errs[k]; hint.classList.add('sa-err'); }
      } else {
        el.classList.remove('sa-bad');
        el.removeAttribute('aria-invalid');
        if (hint) { hint.textContent = ''; hint.classList.remove('sa-err'); }
      }
    });
    var first = api.$('.sa-bad');
    if (first) first.focus();
  }

  /* ---------- 第 2 步：可行性 ---------- */
  function verdictClass(v) {
    return v === '充裕' || v === '合理' ? 'ok' : v === '偏紧' ? 'warn' : 'bad';
  }

  function feasHtml() {
    var d = draft();
    var f = feasOf(d);
    var gap = Math.max(0, f.D - f.T);
    var over = f.R >= GATE;
    return '<div class="sa-f">' +
      '<div class="sa-f-top">' +
        '<div class="sa-f-r"><b>' + f.R.toFixed(2) + '</b>' +
          '<span class="sa-tag ' + verdictClass(f.verdict) + '">' + f.verdict + '</span></div>' +
        '<div class="sa-f-note">T = ' + d.weeklyH + ' h/周 × ' + d.weeks + ' 周 × 0.85 = ' + f.T + ' h<br>' +
          'D = ' + BASE_HOURS[d.type] + ' h × 基础系数 ' + coefOf(d.base).toFixed(2) + ' = ' + f.D + ' h</div>' +
      '</div>' +
      '<div class="sa-kvs">' +
        kv('可用 T', f.T) + kv('需求 D', f.D) +
        kv('缓冲', Math.max(0, f.T - f.D)) +
        kv('缺口', gap, gap > 0 ? 'gap' : '') +
      '</div>' +
      (over
        ? '<p class="sa-f-line">R 在可执行区间（≥ 0.70），可以进入拆解。缓冲 ' + Math.max(0, f.T - f.D) +
          ' h 是真实可损耗的余量，不是可以提前花掉的额度。</p>'
        : calibrateHtml(f)) +
    '</div>';
  }

  function kv(label, val, cls) {
    return '<div class="sa-kv ' + (cls || '') + '"><span>' + label + '</span><b>' + val + '</b><i>h</i></div>';
  }

  function calibrateHtml(f) {
    var d = draft();
    var rows = [];

    /* 1 提高周投入 */
    if (f.R >= TARGET_R) {
      rows.push(pathRow('提高周投入', '已满足 R ≥ 0.90', '当前 ' + d.weeklyH + ' h/周', false));
    } else {
      var needW = solveWeekly(d, TARGET_R);
      var applyW = Math.min(80, needW);
      var rw = feasOf({ weeklyH: applyW, weeks: d.weeks, demand: d.demand });
      var capped = needW > 80;
      rows.push(pathRow('提高周投入',
        'R ' + f.R.toFixed(2) + ' → ' + rw.R.toFixed(2),
        d.weeklyH + ' → ' + applyW + ' h/周' + (capped ? '（需 ' + needW + ' h/周，已到 80 上限）' : ''),
        true, 'fix-weekly'));
    }

    /* 2 延长周期 */
    if (f.R >= TARGET_R) {
      rows.push(pathRow('延长周期', '已满足 R ≥ 0.90', '当前 ' + d.weeks + ' 周', false));
    } else {
      var needK = solveWeeks(d, TARGET_R);
      var rk = feasOf({ weeklyH: d.weeklyH, weeks: needK, demand: d.demand });
      var cappedK = rk.R < TARGET_R;
      var newDay = isoDay(addDays(today0(), needK * 7));
      rows.push(pathRow('延长周期',
        'R ' + f.R.toFixed(2) + ' → ' + rk.R.toFixed(2),
        d.weeks + ' → ' + needK + ' 周' +
          (cappedK ? '（已到 520 周上限，仍低于 0.90）' : '（截止日期随之改为 ' + newDay + '）'),
        true, 'fix-weeks'));
    }

    /* 3 缩小范围 */
    if (f.R >= TARGET_R) {
      rows.push(pathRow('缩小范围', '已满足 R ≥ 0.90', '需求 ' + d.demand + ' h', false));
    } else {
      var nd = Math.round(d.demand * 0.85);
      var rd = feasOf({ weeklyH: d.weeklyH, weeks: d.weeks, demand: nd });
      rows.push(pathRow('缩小范围',
        'R ' + f.R.toFixed(2) + ' → ' + rd.R.toFixed(2),
        '需求 ' + d.demand + ' → ' + nd + ' h（−15%）',
        true, 'fix-demand'));
    }

    return '<div class="notice warn sa-gate">R ' + f.R.toFixed(2) + ' 低于 0.70：先把可行性拉回可执行区间，再谈拆解。' +
        '三条路径可以叠加，每应用一次都会立即重算。</div>' +
      '<div class="sa-paths">' + rows.join('') + '</div>';
  }

  function pathRow(title, sub, detail, enabled, act) {
    return '<div class="sa-path"><div class="sa-path-t">' +
        '<div class="sa-path-h"><b>' + title + '</b><span>' + sub + '</span></div>' +
        '<div class="sa-path-d">' + detail + '</div>' +
      '</div>' +
      (enabled
        ? '<button type="button" class="btn" data-sa="' + act + '">应用</button>'
        : '<button type="button" class="btn" disabled>已达标</button>') +
      '</div>';
  }

  function feasFooter() {
    var f = feasOf(draft());
    var ok = f.R >= GATE;
    return '<button type="button" class="btn ghost" data-close>取消</button>' +
      '<button type="button" class="btn" data-sa="back">上一步</button>' +
      '<button type="button" class="btn pri" data-sa="decompose"' + (ok ? '' : ' disabled') +
      (ok ? '' : ' title="R 低于 0.70，先完成校准"') + '>进入拆解</button>';
  }

  /* ---------- 第 3 步：拆解草案 ---------- */
  function planHtml() {
    var d = draft();
    var f = feasOf(d);
    var cap = d.weeklyH * 60;
    var total = totalMin();
    var ratio = cap ? total / cap : 0;
    return '<div class="sa-stats">' +
        stat('计划总时长', U.hm(total)) +
        stat('周容量', U.hm(cap)) +
        stat('负载比', ratio.toFixed(2)) +
        stat('当前 R', f.R.toFixed(2), f.R >= GATE ? 'ac' : 'warn') +
      '</div>' +
      '<div class="sa-notices">' + noticesHtml(cap, total, f) + '</div>' +
      rowsHtml() +
      addHtml();
  }

  function stat(label, val, cls) {
    return '<div class="sa-st"><span>' + label + '</span><b class="' + (cls || '') + '">' + val + '</b></div>';
  }

  function noticesHtml(cap, total, f) {
    var out = '';
    if (total > cap * OVER_RATIO) {
      var pct = Math.round((total / cap - 1) * 100);
      var cut = total - cap;
      out += '<div class="notice warn sa-over">本周超载 <b>' + pct + '%</b>，建议压缩 ' + cut +
        ' 分钟。<button type="button" class="btn sa-inline" data-sa="compress">一键压缩</button></div>';
    }
    var amp = amplitude();
    if (amp > AMP_LIMIT) {
      out += '<div class="notice sa-amp">修改幅度 <b>' + Math.round(amp * 100) + '%</b>，已重新计算可行性 · 当前 R ' +
        f.R.toFixed(2) + '</div>';
    }
    return out;
  }

  function amplitude() {
    var init = initialPlan;
    var initTotal = init.reduce(function (a, t) { return a + t.est; }, 0);
    if (!initTotal) return 0;
    var diff = 0;
    var byId = {};
    plan().forEach(function (t) { byId[t.id] = t; });
    init.forEach(function (t) {
      var cur = byId[t.id];
      diff += cur ? Math.abs(cur.est - t.est) : t.est;
    });
    var initIds = {};
    init.forEach(function (t) { initIds[t.id] = true; });
    plan().forEach(function (t) { if (!initIds[t.id]) diff += t.est; });
    return diff / initTotal;
  }

  function rowsHtml() {
    var list = plan();
    if (!list.length) {
      return '<div class="empty sa-empty"><b>草案为空</b>至少保留一个计划项，才能生成今天要执行的任务。</div>';
    }
    return '<div class="sa-rows" id="saRows">' + list.map(function (it) {
      var c = (ZX.SUBJ[it.s] || {}).c || 'var(--txt2)';
      return '<div class="sa-row" draggable="true" data-id="' + U.esc(it.id) + '">' +
          '<span class="sa-grip" aria-hidden="true">⋮⋮</span>' +
          '<span class="sa-s" style="--c:' + c + '">' + U.esc(it.s) + '</span>' +
          '<span class="sa-t">' + U.esc(it.title) + '<i class="sa-w">w ' + it.weight.toFixed(2) + '</i></span>' +
          '<span class="sa-m">' + U.hm(it.est) + '</span>' +
          '<span class="sa-ops">' +
            '<button type="button" class="sa-mini" data-sa="minus" data-id="' + U.esc(it.id) + '" aria-label="减少 15 分钟">−</button>' +
            '<button type="button" class="sa-mini" data-sa="plus" data-id="' + U.esc(it.id) + '" aria-label="增加 15 分钟">+</button>' +
            '<button type="button" class="sa-mini del" data-sa="del" data-id="' + U.esc(it.id) + '" aria-label="删除「' + U.esc(it.title) + '」">×</button>' +
          '</span>' +
        '</div>';
    }).join('') + '</div>';
  }

  function addHtml() {
    var opts = SUBJECTS.map(function (k) {
      return '<option value="' + k + '"' + (k === addForm.s ? ' selected' : '') + '>' + k + '</option>';
    }).join('');
    return '<div class="sa-add">' +
        '<select class="input sa-add-s" id="saAddS" aria-label="新计划项科目">' + opts + '</select>' +
        '<input class="input sa-add-t" id="saAddT" placeholder="计划项标题，如「线代 · 矩阵 20 题」" value="' + U.esc(addForm.title) + '" />' +
        '<input class="input mono sa-add-m" id="saAddM" type="number" min="15" max="240" step="15" value="' + addForm.min + '" aria-label="预估分钟" />' +
        '<button type="button" class="btn" data-sa="add">添加计划项</button>' +
      '</div>';
  }

  function captureAdd() {
    if (step !== 3) return;
    var s = api.$('#saAddS');
    var t = api.$('#saAddT');
    var m = api.$('#saAddM');
    if (s) addForm.s = s.value;
    if (t) addForm.title = String(t.value || '');
    if (m && String(m.value).trim() !== '') addForm.min = U.num(m.value, addForm.min);
  }

  function planFooter() {
    var empty = totalMin() <= 0;
    return '<button type="button" class="btn ghost" data-close>取消</button>' +
      '<button type="button" class="btn" data-sa="back">上一步</button>' +
      '<button type="button" class="btn pri" data-sa="confirm"' + (empty ? ' disabled' : '') + '>确认生效</button>';
  }

  /* 按权重从低到高压缩到 1.0 倍容量，单项单次不超过原工时 40% */
  function compressToCap() {
    var cap = draft().weeklyH * 60;
    var need = totalMin() - cap;
    if (need <= 0) return;
    var order = plan().slice().sort(function (a, b) {
      return (a.weight - b.weight) || (a.order - b.order);
    });
    for (var i = 0; i < order.length && need > 0; i++) {
      var it = order[i];
      var maxCut = Math.floor(it.est * 0.4);
      var room = it.est - MIN_EST;
      var cut = Math.min(need, maxCut, room);
      if (cut > 0) { it.est -= cut; need -= cut; }
    }
  }

  /* ---------- 生效 ---------- */
  function timeAt(idx, est) {
    var starts = [9 * 60, 10 * 60 + 30, 14 * 60, 17 * 60];
    var s = starts[idx] !== undefined ? starts[idx] : 9 * 60 + idx * 150;
    var e = s + est;
    return U.pad2(Math.floor(s / 60)) + ':' + U.pad2(s % 60) + '–' +
      U.pad2(Math.floor(e / 60)) + ':' + U.pad2(e % 60);
  }

  function apply() {
    var S = ZX.state;
    var d = draft();
    var total = totalMin();
    if (total <= 0) { ZX.ui.toast('草案为空，先添加计划项', 'warn'); return; }
    var f = feasOf(d);
    if (f.R < GATE) { ZX.ui.toast('R 低于 0.70，先完成校准', 'warn'); return; }

    var picked = plan().slice(0, 4);
    var stamp = Date.now().toString(36);

    S.goal.name = String(d.name || '').trim();
    S.goal.deadline = d.deadline;
    S.goal.weeks = d.weeks;
    S.feas.weeklyH = d.weeklyH;
    S.feas.weeks = d.weeks;
    S.feas.discount = DISCOUNT;
    S.feas.demand = d.demand;

    S.tasks = picked.map(function (it, i) {
      return S.normTask({
        id: 't_' + stamp + i,
        subject: it.s,
        title: it.title,
        est: it.est,
        time: timeAt(i, it.est),
        weight: it.weight,
        done: false
      });
    });

    /* 新目标生效后，旧计时与旧重排快照都失去对应任务，一并作废 */
    S.running = null;
    S.timerStart = null;
    S.pausedAt = null;
    S.pausedTotal = 0;
    S.replanned = false;
    S.snapshot = null;
    S.replanRecord = null;

    S.goalDraft = null;
    S.planDraft = null;

    ZX.ui.toast('目标已生效', 'ok');
    var ctl = api;
    api = null;
    if (ctl) ctl.close('applied');
    ZX.render();
    ZX.setTab('plan');
  }

  /* ---------- 事件 ---------- */
  function onInput(e) {
    if (step !== 1 || !api) return;
    var id = e.target && e.target.id;
    if (id !== 'saName' && id !== 'saDeadline' && id !== 'saWeekly') return;
    captureForm();
    var calc = api.$('#saCalc');
    if (calc) calc.innerHTML = calcPreview();
  }

  function onClick(e) {
    if (!api) return;
    var t = e.target.closest ? e.target.closest('[data-sa]') : null;
    if (!t) return;
    var act = t.dataset.sa;

    if (act === 'type' || act === 'base') {
      captureForm();
      if (act === 'type') draft().type = t.dataset.v;
      else draft().base = t.dataset.v;
      draft().demand = demandOf(draft().type, draft().base);
      render();
      return;
    }

    if (act === 'next') {
      captureForm();
      draft().name = String(draft().name || '').trim();
      var errs = validate();
      markErrors(errs);
      if (Object.keys(errs).length) { ZX.ui.toast('还有几项需要补全', 'warn'); return; }
      step = 2;
      render();
      return;
    }

    if (act === 'back') {
      step = step === 3 ? 2 : 1;
      render();
      return;
    }

    if (act === 'decompose') {
      if (feasOf(draft()).R < GATE) return;
      step = 3;
      render();
      return;
    }

    if (act === 'fix-weekly') {
      var needW = solveWeekly(draft(), TARGET_R);
      draft().weeklyH = Math.min(80, needW);
      render();
      return;
    }

    if (act === 'fix-weeks') {
      var needK = solveWeeks(draft(), TARGET_R);
      draft().weeks = needK;
      draft().deadline = isoDay(addDays(today0(), needK * 7));
      render();
      return;
    }

    if (act === 'fix-demand') {
      draft().demand = Math.round(draft().demand * 0.85);
      render();
      return;
    }

    if (act === 'plus' || act === 'minus' || act === 'del') {
      var it = findItem(t.dataset.id);
      if (!it) return;
      if (act === 'plus') it.est = clampEst(it.est + STEP);
      else if (act === 'minus') it.est = clampEst(it.est - STEP);
      else {
        ZX.state.planDraft = plan().filter(function (x) { return x.id !== it.id; });
        ZX.ui.toast('已删除「' + it.title + '」', 'warn');
      }
      render();
      return;
    }

    if (act === 'add') {
      captureAdd();
      var title = String(addForm.title || '').trim();
      if (!title) { ZX.ui.toast('先写一个计划项标题', 'warn'); return; }
      plan().push({
        id: 'd_' + Date.now().toString(36),
        s: addForm.s,
        title: title,
        est: clampEst(addForm.min),
        weight: 0.5,
        order: plan().length
      });
      addForm.title = '';
      render();
      return;
    }

    if (act === 'compress') {
      compressToCap();
      render();
      return;
    }

    if (act === 'confirm') { apply(); return; }
  }

  function onDragStart(e) {
    var row = e.target.closest ? e.target.closest('.sa-row') : null;
    if (!row) return;
    dragId = row.dataset.id;
    row.classList.add('drag');
    try {
      e.dataTransfer.setData('text/plain', dragId);
      e.dataTransfer.effectAllowed = 'move';
    } catch (err) { /* 老浏览器忽略 */ }
  }

  function onDragOver(e) {
    if (!dragId) return;
    var row = e.target.closest ? e.target.closest('.sa-row') : null;
    if (!row || row.dataset.id === dragId) return;
    e.preventDefault();
    if (overEl && overEl !== row) overEl.classList.remove('over');
    overEl = row;
    row.classList.add('over');
  }

  function onDrop(e) {
    if (!dragId) return;
    var row = e.target.closest ? e.target.closest('.sa-row') : null;
    if (!row || row.dataset.id === dragId) { clearDrag(); return; }
    e.preventDefault();
    var list = plan();
    var from = -1, to = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === dragId) from = i;
      if (list[i].id === row.dataset.id) to = i;
    }
    if (from >= 0 && to >= 0) {
      var moved = list.splice(from, 1)[0];
      list.splice(to, 0, moved);
      list.forEach(function (x, i) { x.order = i; });
    }
    clearDrag();
    render();
  }

  function clearDrag() {
    dragId = null;
    if (overEl) { overEl.classList.remove('over'); overEl = null; }
    var d = api ? api.$('.sa-row.drag') : null;
    if (d) d.classList.remove('drag');
  }

  /* ---------- 入口 ---------- */
  function open() {
    if (api) return;              /* 已打开：避免重复叠加弹层 */
    if (!ZX.ui || !ZX.engine) return;

    ZX.state.goalDraft = defaultDraft();
    ZX.state.planDraft = makePlan();
    initialPlan = U.clone(ZX.state.planDraft);
    step = 1;
    addForm = { s: '数学', title: '', min: 45 };

    api = ZX.ui.sheet({
      eyebrow: 'GOAL / 新建',
      title: '设定你的目标',
      sub: '先设目标，再判断可行性；不可行就先校准，不直接砍计划。',
      body: formHtml(),
      footer: formFooter(),
      onClose: function () {
        ZX.state.goalDraft = null;
        ZX.state.planDraft = null;
        initialPlan = [];
        api = null;
      }
    });

    api.root.addEventListener('click', onClick);
    api.root.addEventListener('input', onInput);
    api.root.addEventListener('change', onInput);
    api.root.addEventListener('dragstart', onDragStart);
    api.root.addEventListener('dragover', onDragOver);
    api.root.addEventListener('drop', onDrop);
    api.root.addEventListener('dragend', clearDrag);
  }

  ZX.flows = ZX.flows || {};
  ZX.flows.goal = { open: open, apply: apply };

  /* 计划页头部按钮（按钮在 views/plan.js，事件在这里委托，不改 main.js） */
  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
    if (!e.target.closest('[data-goal-new]')) return;
    open();
  });

})(window.ZX);
