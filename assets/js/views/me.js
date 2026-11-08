/* =========================================================
   诺瓦 Nova · 我的视图
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var U = ZX.util;

  function me() {
    var S = ZX.state;
    var rows = [
      ['周一', [1, 1, 1, 0]], ['周二', [1, 0, 1, 0]], ['周三', [1, 1, 1, 0]], ['周四', [0, 0, 1, 0]],
      ['周五', [1, 0, 1, 0]], ['周六', [1, 1, 1, 0]], ['周日', [1, 1, 1, 0]]
    ];
    return '<div class="wrap">' +
      '<div class="vhead"><div>' +
        '<div class="eyebrow">IDENTITY · ' + S.user.name + '</div>' +
        '<h1>我的<span class="sub">可用时段与通知策略</span></h1>' +
        '<p class="vlede">可用时段是排程的输入，不是结果。修改后 24 小时内自动重算拆解并提示影响范围。</p>' +
      '</div><div class="vstats">' +
        '<div class="vs"><span>周可用</span><b>' + S.user.weeklyH + ' h</b></div>' +
        '<div class="vs"><span>每日上限</span><b>' + S.user.dailyCapMin + ' min</b></div>' +
        '<div class="vs"><span>高效时段</span><b>19–22</b></div>' +
      '</div></div>' +

      '<div class="sec-h"><span class="n">01</span><span class="t">可用时段</span><span class="rule"></span><span class="r">周网格 · 30 min 粒度</span></div>' +
      '<div class="panel"><div class="panel-b">' +
        '<div class="avail-h"><span></span><span>08–12</span><span>12–18</span><span>18–22</span><span>22–24</span></div>' +
        rows.map(function (r) {
          return '<div class="avail"><span class="d">' + r[0] + '</span>' +
            r[1].map(function (v) { return '<span class="c ' + (v ? 'on' : '') + '"></span>'; }).join('') + '</div>';
        }).join('') +
        '<p style="margin:12px 0 0;font-size:10px;color:var(--txt3)">高亮 = 可排程。22:00–08:00 为静默时段，服务端强制，客户端不可绕过。</p>' +
      '</div></div>' +

      '<div class="sec-h"><span class="n">02</span><span class="t">通知与数据</span><span class="rule"></span></div>' +
      '<div class="grid2">' +
        '<div class="panel"><div class="panel-h">通知策略<span>分级可关</span></div><div class="panel-b">' +
          swRow('每日提醒', '19:00 · 今日 3 项', 'daily') +
          swRow('周报', '周日 20:00 · 最少打扰', 'weekly') +
          swRow('进度预警', '必须附带补救方案', 'alert') +
          swRow('中断挽救', '连续 3 天无记录时触发', 'rescue') +
          '<div class="sw"><div><span class="n">夜间静默</span><small>22:00–08:00 · 服务端裁决</small></div><span class="spacer"></span><span class="tg on lock"></span></div>' +
        '</div></div>' +
        '<div class="panel"><div class="panel-h">数据<span>local-first</span></div><div class="panel-b">' +
          '<div class="row2"><span class="k">待上行 op</span><span class="v" id="opPending">' + ZX.api.pendingCount() + '</span></div>' +
          '<div class="row2"><span class="k">当前 server_seq</span><span class="v">' + S.serverSeq + '</span></div>' +
          '<div class="row2"><span class="k">上次同步</span><span class="v">' + U.nowStr() + '</span></div>' +
          '<div class="row2"><span class="k">冲突待裁决</span><span class="v">0</span></div>' +
          '<div class="row2"><span class="k">离线可用</span><span class="v">读 / 写 / 计时</span></div>' +
          '<div style="margin-top:12px"><button class="btn" data-act="export">导出计划与记录</button></div>' +
        '</div></div>' +
      '</div>' +
      '<div class="foot-note"><span>identity</span><span>tz ' + S.user.tz + '</span><span>软删 7 天可撤回</span></div>' +
    '</div>';
  }

  function swRow(n, sub, key) {
    var S = ZX.state;
    return '<div class="sw"><div><span class="n">' + n + '</span><small>' + sub + '</small></div>' +
      '<span class="spacer"></span><span class="tg ' + (S.notif[key] ? 'on' : '') + '" data-act="tg" data-key="' + key + '"></span></div>';
  }

  ZX.views = ZX.views || {};
  ZX.views.me = me;

})(window.ZX);
