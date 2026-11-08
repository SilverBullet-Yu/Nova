/* 诺瓦 Nova · 共享种子数据
 *
 * 契约：docs/HANDOFF.md §4 / §2（UMD 双模）
 * 依赖：无（不读时钟、不读随机数、不做 I/O、不依赖 shared/ 之外的模块）
 *
 * 数值与现有 index.html 的 S 对象逐项一致（4 条任务 / 7 天 week / weekShift /
 * notif / weekStats.WEEKS / feas），不得擅自改动。
 *
 * 浏览器：window.Rhythm.seed.seed
 * Node   ：require('./seed.js').seed
 *
 * seed 为深度冻结的只读对象。需要修改的一方请先自行深拷贝
 * （例：JSON.parse(JSON.stringify(seed))），不要直接写入。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.Rhythm = root.Rhythm || {}; root.Rhythm.seed = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
    }
    return o;
  }

  var seed = {
    user: {
      id: 'u_demo',
      name: '林清',
      tz: 'Asia/Shanghai',
      dailyCapMin: 300,
      weeklyH: 20
    },

    goal: {
      id: 'g_2027',
      name: '2027 考研 · 计算机',
      target: '380 分',
      deadline: '2027-12-25',
      weeks: 58
    },

    feas: {
      weeklyH: 20,
      weeks: 58,
      discount: 0.85,
      demand: 913
    },

    tasks: [
      {
        id: 't1',
        subject: '英语',
        title: '阅读真题 2019 Text 3–4 精读',
        est: 60,
        time: '09:00–10:00',
        weight: 0.78,
        done: true,
        actual: 60
      },
      {
        id: 't2',
        subject: '数学',
        title: '高数 · 第 3 章 极限 40 题',
        est: 90,
        time: '10:30–12:00',
        weight: 0.92,
        done: false,
        why: '考频权重 0.92 · 匹配历史高效时段'
      },
      {
        id: 't3',
        subject: '408',
        title: '数据结构 · 树与二叉树 应用',
        est: 75,
        time: '14:00–15:15',
        weight: 0.86,
        done: false
      },
      {
        id: 't4',
        subject: '政治',
        title: '马原 第 2 章 多选 60 题',
        est: 45,
        time: '17:00–17:45',
        weight: 0.41,
        done: false
      }
    ],

    buffer: {
      time: '20:30–21:30',
      free: true
    },

    week: [
      { d: '一', segs: [['数学', 60], ['408', 45]], buf: 60, total: 105 },
      { d: '二', segs: [['英语', 60], ['政治', 30]], buf: 60, total: 90 },
      { d: '三', segs: [['数学', 90], ['408', 60]], buf: 60, total: 150 },
      { d: '四', segs: [['英语', 45]], buf: 60, total: 45 },
      { d: '五', segs: [['数学', 60], ['政治', 45]], buf: 60, total: 105 },
      { d: '六', segs: [['408', 90], ['数学', 60]], buf: 60, total: 150 },
      { d: '日', segs: [['数学', 90], ['408', 75], ['政治', 45], ['英语', 60]], buf: 60, total: 270, today: true }
    ],

    weekShift: [
      { d: '一', segs: [['数学', 60], ['408', 45]], buf: 60, total: 105 },
      { d: '二', segs: [['英语', 60], ['政治', 30], ['数学', 30]], buf: 60, total: 120 },
      { d: '三', segs: [['数学', 90], ['408', 60]], buf: 60, total: 150 },
      { d: '四', segs: [['英语', 45], ['408', 45]], buf: 60, total: 90 },
      { d: '五', segs: [['数学', 60], ['政治', 30]], buf: 60, total: 90 },
      { d: '六', segs: [['408', 90], ['数学', 60], ['数学', 45]], buf: 60, total: 195 },
      { d: '日', segs: [['数学', 90], ['408', 75], ['英语', 60]], buf: 60, total: 225, today: true }
    ],

    notif: {
      daily: true,
      weekly: true,
      alert: true,
      rescue: true
    },

    weekStats: {
      WEEKS: [52, 61, 58, 66, 71, 74, 72, 68],
      kpis: {
        effectiveHours: 11.2,
        targetHours: 15,
        achievementRate: 68,
        achievementDeltaPt: -6,
        replanAdopted: 3,
        replanTotal: 4,
        replanRate: 75,
        recordedDays: 5,
        totalDays: 7
      },
      subjectMix: { '数学': 45, '专业课': 30, '英语': 20, '政治': 5 },
      attribution: { '计划过载': 40, '执行中断': 35, '效率不足': 25 },
      actions: [
        '周日上午 08:00–10:00 固定为政治时段',
        '周三晚弹性位扩容 30 分钟'
      ]
    },

    /* 科目色值：沿用现有 CSS 变量名，前端可直接取用 */
    subjectColors: {
      '数学': 'var(--m-math)',
      '英语': 'var(--m-en)',
      '408': 'var(--m-408)',
      '政治': 'var(--m-pol)'
    }
  };

  deepFreeze(seed);

  return { seed: seed };
}));
