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

  /* 对话输出统一走 assistant（goal.js 在 assistant.js 之前加载） */
  function say(html, eng) {
    if (ZX.assistant && typeof ZX.assistant.say === 'function') ZX.assistant.say(html, eng);
  }

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

  var api = null;           /* ZX.ui.sheet 控制器（flow.open() 产出） */
  var flow = null;          /* ZX.ui.flowSheet 步骤控制器 */
  var initialPlan = [];     /* 初始草案快照，用于计算修改幅度 */
  var addForm = { s: '数学', title: '', min: 45 };
  var dragId = null;
  var overEl = null;

  /* ---------- 日期与数值（parseDay / isoDay / addDays 用 util.js 共用实现） ---------- */
  function today0() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
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
    var day = U.parseDay(deadline);
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
    return U.findById(plan(), id);
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

  /* ---------- 渲染骨架（flowSheet 统一步骤编排：头三行 / 焦点记忆 / wide 切换） ---------- */
  function stepDef(n) {
    if (n === 1) {
      return {
        head: ['目标 / 新建', '设定你的目标', '先设目标，再判断可行性；不可行就先校准，不直接砍计划。'],
        body: formHtml(),
        footer: formFooter()
      };
    }
    if (n === 2) {
      return {
        head: ['目标 / 可行性', '可行性判定', 'R = T / D。低于 0.70 时先校准，再决定怎么拆。'],
        body: feasHtml(),
        footer: feasFooter()
      };
    }
    return {
      head: ['目标 / 拆解', '拆解草案', '当前仅编辑任务草案。确认后交给确定性引擎排程。'],
      body: planHtml(),
      footer: planFooter(),
      wide: true
    };
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
        '<div class="seg sa-seg sa-seg-4">' + BASES.map(function (b) {
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
    return ZX.ui.footNav({ ns: 'sa', act: 'next', label: '下一步 · 可行性判定' });
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
    var day = U.parseDay(d.deadline);
    if (day) d.weeks = weeksUntil(day);
  }

  function validate() {
    var d = draft();
    var errs = {};
    if (!String(d.name || '').trim()) errs.name = '请填写目标名称，例如「2027 考研 · 计算机」。';
    var day = U.parseDay(d.deadline);
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
        '<div class="sa-f-note">目标草案：' + d.weeklyH + ' h/周 × ' + d.weeks + ' 周<br>' +
          '确定性引擎：可用 T 按 ' + DISCOUNT + ' 折算为 ' + f.T + ' h；当前需求 D = ' + f.D + ' h</div>' +
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
      var newDay = U.isoDay(U.addDays(today0(), needK * 7));
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
    return ZX.ui.footNav({
      ns: 'sa', back: true, act: 'decompose', label: '进入拆解',
      disabled: !ok, title: ok ? '' : 'R 低于 0.70，先完成校准'
    });
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
        stat('草案周容量', U.hm(cap)) +
        stat('负载比', ratio.toFixed(2)) +
        stat('当前 R', f.R.toFixed(2), f.R >= GATE ? 'ac' : 'warn') +
      '</div>' +
      '<div class="sa-notices">' + noticesHtml(cap, total, f) + '</div>' +
      '<p class="note">' + scheduleConstraints(buildSlots()) + '</p>' +
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
            '<button type="button" class="sa-mini" data-sa="up" data-id="' + U.esc(it.id) + '" aria-label="上移「' + U.esc(it.title) + '」"' +
              (it === list[0] ? ' disabled' : '') + '>▲</button>' +
            '<button type="button" class="sa-mini" data-sa="down" data-id="' + U.esc(it.id) + '" aria-label="下移「' + U.esc(it.title) + '」"' +
              (it === list[list.length - 1] ? ' disabled' : '') + '>▼</button>' +
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

  function captureAdd(n) {
    if (n !== 3) return;
    var s = api.$('#saAddS');
    var t = api.$('#saAddT');
    var m = api.$('#saAddM');
    if (s) addForm.s = s.value;
    if (t) addForm.title = String(t.value || '');
    if (m && String(m.value).trim() !== '') addForm.min = U.num(m.value, addForm.min);
  }

  function planFooter() {
    return ZX.ui.footNav({
      ns: 'sa', back: true, act: 'confirm', label: '确认生效',
      disabled: totalMin() <= 0
    });
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

  /* ---------- 生效 ----------
     环节③④贯通：草案确认后交给 schedule 引擎真排进本周空档，
     今日任务、任务时段与周视图全部来自引擎输出，不再硬编码时段。 */

  /* 本周可排空档取自可用时段网格，弹性槽也必须位于可用窗口内。
     「今天」排数组最前：候选按 slots 顺序评估，权重最高的任务先占今天。 */
  var DAY_ORDER = ['一', '二', '三', '四', '五', '六', '日'];
  var STUDY_FROM = 18 * 60;        /* 18:00 */
  var STUDY_TO = 22 * 60;          /* 22:00 */
  var BUFFER_TIME = '22:00–23:00'; /* 与排程槽位同源（bufferRatio 预留之外的显式弹性位） */
  var BUFFER_MIN = 60;             /* 每日弹性位容量，与 seed.buf 一致 */

  function fmtMin(m) { return U.pad2(Math.floor(m / 60)) + ':' + U.pad2(m % 60); }

  function buildSlots() {
    var dow = U.todayDow();
    var days = [dow].concat(DAY_ORDER.filter(function (x) { return x !== dow; }));
    var slots = [];
    var grid = ZX.state.avail;
    var ranges = [[480, 720], [720, 1080], [1080, 1320]];
    days.forEach(function (d) {
      var row = grid && grid[DAY_ORDER.indexOf(d)];
      var starts = [];
      ranges.forEach(function (range, i) {
        if (row ? row[i] !== true : i !== 2) return;
        for (var min = range[0]; min < range[1]; min += 30) starts.push(min);
      });
      starts.forEach(function (min, i) {
        slots.push({ date: d, startMin: min, durMin: 30, available: true, isBuffer: i >= starts.length - BUFFER_MIN / 30 });
      });
    });
    return slots;
  }

  function scheduleConstraints(slots) {
    if (!slots.length) return '没有可用时段，无法排程。';
    var days = new Set(slots.map(function (s) { return s.date; }));
    var minutes = slots.reduce(function (sum, s) { return sum + s.durMin; }, 0);
    return '可用时段：' + days.size + ' 天，共 ' + minutes / 60 +
      ' 小时（含弹性位，不等于可排任务工时）；只在可用时段内排程，弹性位兜底。';
  }

  /* 引擎 blocks → 周视图（segs 按科目聚合；弹性位容量单列，与周图 .buf 同语） */
  function weekFromBlocks(blocks) {
    var dow = U.todayDow();
    var byDay = {};
    blocks.forEach(function (b) { (byDay[b.date] = byDay[b.date] || []).push(b); });
    return DAY_ORDER.map(function (d) {
      var segs = [];
      var sum = 0;
      (byDay[d] || []).forEach(function (b) {
        if (b.isBuffer) return;
        var hit = null;
        for (var i = 0; i < segs.length; i++) if (segs[i][0] === b.subject) { hit = segs[i]; break; }
        if (hit) hit[1] += b.durMin;
        else segs.push([b.subject, b.durMin]);
        sum += b.durMin;
      });
      return { d: d, segs: segs, buf: BUFFER_MIN, total: sum + BUFFER_MIN, today: d === dow };
    });
  }

  /* 引擎 blocks → 今日任务：今天排进 ≥30 分钟的任务按开始时间取前 4 项 */
  function todayTasksFromBlocks(blocks, all, stamp) {
    var S = ZX.state;
    var dow = U.todayDow();
    var byTask = {};
    blocks.forEach(function (b) {
      if (b.date !== dow || b.isBuffer) return;
      var g = byTask[b.taskId] = byTask[b.taskId] || { first: b.startMin, last: b.startMin + b.durMin, min: 0 };
      g.first = Math.min(g.first, b.startMin);
      g.last = Math.max(g.last, b.startMin + b.durMin);
      g.min += b.durMin;
    });
    return Object.keys(byTask)
      .map(function (id) {
        var src = null;
        for (var i = 0; i < all.length; i++) if (all[i].id === id) { src = all[i]; break; }
        return src ? { src: src, g: byTask[id] } : null;
      })
      .filter(function (x) { return x && x.g.min >= 30; })
      .sort(function (a, b) { return a.g.first - b.g.first; })
      .slice(0, 4)
      .map(function (x, i) {
        return S.normTask({
          id: 't_' + stamp + i,
          subject: x.src.subject,
          title: x.src.title,
          est: x.src.estMin,
          time: fmtMin(x.g.first) + '–' + fmtMin(x.g.last),
          weight: x.src.weight,
          done: false
        });
      });
  }

  function traceSchedule(status, planVersion) {
    try {
      var store = window.localStorage;
      var bytes = crypto.getRandomValues(new Uint8Array(16));
      var id = 'schedule-' + Array.from(bytes, function (v) { return v.toString(16).padStart(2, '0'); }).join('');
      var key = 'zx.scheduleTrace';
      var events = JSON.parse(store.getItem(key) || '[]');
      store.setItem(key, JSON.stringify((Array.isArray(events) ? events : []).slice(-99).concat([{
        id: id, tool: 'schedule', at: Date.now(), planVersion: planVersion,
        rulesVersion: 'nova-schedule-p0-1', status: status
      }])));
    } catch (err) { /* 留痕失败不影响排程 */ }
  }

  var scheduleRequest = 0;
  function apply() {
    var S = ZX.state;
    var d = draft();
    var total = totalMin();
    if (total <= 0) { ZX.ui.toast('草案为空，先添加计划项', 'warn'); return; }
    var f = feasOf(d);
    if (f.R < GATE) { ZX.ui.toast('R 低于 0.70，先完成校准', 'warn'); return; }

    var all = plan().map(function (it) {
      return { id: it.id, subject: it.s, title: it.title, estMin: it.est, weight: it.weight };
    });
    var slots = buildSlots();
    if (!slots.length) { ZX.ui.toast('没有可用时段，请先在「我的」中设置。当前计划未变更。', 'warn'); return; }
    var stamp = Date.now().toString(36);

    var request = ++scheduleRequest;
    var approved = JSON.stringify([d, all, slots]);
    ZX.engine.schedule({ tasks: all, slots: slots, params: {} }).then(function (res) {
      if (request !== scheduleRequest || S.goalDraft !== d) return;
      var current = plan().map(function (it) {
        return { id: it.id, subject: it.s, title: it.title, estMin: it.est, weight: it.weight };
      });
      if (approved !== JSON.stringify([d, current, buildSlots()])) {
        traceSchedule('stale', S.currentPlanVersion ? S.currentPlanVersion() : null);
        ZX.ui.toast('草案或可用时段有变，请重新确认。当前计划未变更。', 'warn');
        return;
      }
      if (!res || !Array.isArray(res.blocks) || !res.blocks.length || !Array.isArray(res.unplanned)) {
        traceSchedule('failed', S.currentPlanVersion ? S.currentPlanVersion() : null);
        ZX.ui.toast('没有可应用的排程结果，当前计划未变更。', 'warn');
        return;
      }
      applyScheduled(res, all, stamp, d, slots);
      if (ZX.api && ZX.api.stagePlan) {
        try {
          ZX.api.stagePlan({ tasks: all, slots: slots, params: {} }, res);
          if (ZX.reviewPendingPlan) ZX.reviewPendingPlan(false, true);
        } catch (e) { ZX.ui.toast('计划已在本机生效，但无法保存待复核请求。', 'warn'); }
      }
    }, function () {
      if (request === scheduleRequest && S.goalDraft === d) {
        traceSchedule('failed', S.currentPlanVersion ? S.currentPlanVersion() : null);
        ZX.ui.toast('排程未完成，当前计划未变更；可重试提交。', 'warn');
      }
    });
  }

  function applyScheduled(res, all, stamp, d, slots) {
    var S = ZX.state;
    var blocks = res.blocks;
    var unplanned = res.unplanned;
    var dow = U.todayDow();
    var week = weekFromBlocks(blocks);
    var patch = {
      goal: Object.assign({}, S.goal, { name: String(d.name || '').trim(), deadline: d.deadline, weeks: d.weeks, source: 'user' }),
      feas: { weeklyH: d.weeklyH, weeks: d.weeks, discount: DISCOUNT, demand: d.demand },
      week: week, weekShift: U.clone(week), tasks: todayTasksFromBlocks(blocks, all, stamp),
      buffer: { time: BUFFER_TIME, free: !blocks.some(function (b) { return b.isBuffer && b.date === dow; }) },
      replanned: false, snapshot: null, replanRecord: null, tiredAdopted: false, movedOut: null,
      replanHistory: [], dayAssign: {}, locks: {}, goalDraft: null, planDraft: null
    };
    S.resetTimer();
    Object.assign(S, patch);
    traceSchedule('committed', S.currentPlanVersion ? S.currentPlanVersion() : null);
    var ctl = api;
    api = null;
    if (ctl) ctl.close('applied');
    ZX.render();
    ZX.setTab('plan');

    var rows = S.tasks.map(function (t) {
      return '<div class="erow"><span class="k">' + U.esc(t.time.split('–')[0]) + '</span>' +
        '<span class="why" style="flex:1;color:var(--txt2)">' + U.esc(t.s) + ' · ' + U.esc(t.title) + '</span>' +
        '<span class="v">' + U.hm(t.est) + '</span></div>';
    }).join('');
    var unplannedTxt = unplanned.length
      ? '<div class="ecard-f"><span class="note">另 ' + unplanned.length + ' 项未排入：' +
        U.esc(unplanned.map(function (u) { return (u.reason || '无可用时段').split('，')[0]; }).join('；')) + '</span></div>'
      : '';
    say('<p>排程完成：<b>' + (all.length - unplanned.length) + '</b> 项已排入可用时段，' +
      '今天先做 <b>' + S.tasks.length + '</b> 项。</p>' +
      '<div class="ecard"><div class="ecard-h"><b>今晚开始</b><span class="tag">引擎 ' + U.esc(res.version || '') + '</span></div>' +
      '<div class="ecard-b"><p class="note">输入：已确认任务草案；来源：确定性引擎。' +
      scheduleConstraints(slots) + '</p>' + rows + unplannedTxt + '</div></div>', '排程 · ' + blocks.length + ' 块');
  }

  /* ---------- 事件 ---------- */
  function onInput(e) {
    if (!api || flow.step() !== 1) return;
    var id = e.target && e.target.id;
    if (id !== 'saName' && id !== 'saDeadline' && id !== 'saWeekly') return;
    captureForm();
    var calc = api.$('#saCalc');
    if (calc) calc.innerHTML = calcPreview();
  }

  /* 第 1 步：目标表单 */
  function onClickForm(act, t) {
    if (act === 'type' || act === 'base') {
      captureForm();
      if (act === 'type') draft().type = t.dataset.v;
      else draft().base = t.dataset.v;
      draft().demand = demandOf(draft().type, draft().base);
      flow.render();
      return;
    }
    if (act === 'next') {
      captureForm();
      draft().name = String(draft().name || '').trim();
      var errs = validate();
      markErrors(errs);
      if (Object.keys(errs).length) { ZX.ui.toast('还有几项需要补全', 'warn'); return; }
      flow.go(2);
    }
  }

  /* 第 2 步：可行性与校准路径 */
  function onClickFeas(act) {
    if (act === 'decompose') {
      if (feasOf(draft()).R < GATE) return;
      flow.go(3);
      return;
    }
    if (act === 'fix-weekly') {
      var needW = solveWeekly(draft(), TARGET_R);
      draft().weeklyH = Math.min(80, needW);
      flow.render();
      return;
    }
    if (act === 'fix-weeks') {
      var needK = solveWeeks(draft(), TARGET_R);
      draft().weeks = needK;
      draft().deadline = U.isoDay(U.addDays(today0(), needK * 7));
      flow.render();
      return;
    }
    if (act === 'fix-demand') {
      draft().demand = Math.round(draft().demand * 0.85);
      flow.render();
    }
  }

  /* 第 3 步：拆解草案 */
  function onClickPlan(act, t) {
    if (act === 'up' || act === 'down') {
      /* 键盘排序：与指针拖拽共用同一份 planDraft 顺序（拖拽的键盘替代路径） */
      var list = plan();
      var i = -1;
      for (var k = 0; k < list.length; k++) if (list[k].id === t.dataset.id) i = k;
      var j = act === 'up' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= list.length) return;
      var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
      list.forEach(function (x, idx) { x.order = idx; });
      flow.render();
      /* 移动后原按钮可能因到边而禁用（如升到首行）：聚焦该行仍可用的方向按钮，
         键盘连续移动不丢焦点 */
      var nextAct = j === 0 ? 'down' : 'up';
      U.refocus(api.root.querySelector('[data-sa="' + nextAct + '"][data-id="' + t.dataset.id + '"]:not([disabled])'));
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
      flow.render();
      return;
    }

    if (act === 'add') {
      captureAdd(3);
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
      flow.render();
      return;
    }

    if (act === 'compress') {
      compressToCap();
      flow.render();
      return;
    }

    if (act === 'confirm') { apply(); }
  }

  function onClick(e) {
    if (!api) return;
    var t = e.target.closest ? e.target.closest('[data-sa]') : null;
    if (!t) return;
    var act = t.dataset.sa;

    if (act === 'back') { flow.go(flow.step() === 3 ? 2 : 1); return; }

    if (flow.step() === 1) onClickForm(act, t);
    else if (flow.step() === 2) onClickFeas(act);
    else onClickPlan(act, t);
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
    flow.render();
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
    addForm = { s: '数学', title: '', min: 45 };

    flow = ZX.ui.flowSheet({
      ns: 'sa',
      step: 1,
      steps: { 1: stepDef, 2: stepDef, 3: stepDef },
      beforeRender: function (n) { if (api) captureAdd(n); },
      bind: function (a) {
        a.root.addEventListener('click', onClick);
        a.root.addEventListener('input', onInput);
        a.root.addEventListener('change', onInput);
        a.root.addEventListener('dragstart', onDragStart);
        a.root.addEventListener('dragover', onDragOver);
        a.root.addEventListener('drop', onDrop);
        a.root.addEventListener('dragend', clearDrag);
      },
      onClose: function () {
        ZX.state.goalDraft = null;
        ZX.state.planDraft = null;
        initialPlan = [];
        api = null;
        flow = null;
      }
    });
    api = flow.open();
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
