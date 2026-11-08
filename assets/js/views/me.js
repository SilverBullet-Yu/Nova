/* =========================================================
   诺瓦 Nova · 我的视图
   ========================================================= */
window.ZX = window.ZX || {};

(function (ZX) {
  'use strict';

  var U = ZX.util;

  var DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  var SLOTS = ['08–12', '12–18', '18–22', '22–24'];
  var DEF_GRID = [
    [1, 1, 1, 0], [1, 0, 1, 0], [1, 1, 1, 0], [0, 0, 1, 0],
    [1, 0, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0]
  ];

  function me() {
    var S = ZX.state;
    var SET = ZX.flows && ZX.flows.settings;
    var grid = SET ? SET.grid() : DEF_GRID;
    var sum = SET ? SET.summaryHtml() : '已选 17 段 · 可用窗口 76 h';
    var trash = SET ? SET.restoreInfo() : null;

    return '<div class="wrap">' +
      '<div class="vhead"><div>' +
        '<div class="eyebrow">ABOUT · ' + U.esc(S.user.name) + '</div>' +
        '<h1>我的<span class="sub">可用时段与通知策略</span></h1>' +
        '<p class="vlede">可用时段是排程的输入，不是结果。修改后 24 小时内自动重算拆解并提示影响范围。</p>' +
      '</div><div class="vstats">' +
        '<div class="vs"><span>周可用</span><b>' + S.user.weeklyH + ' h</b></div>' +
        '<div class="vs"><span>每日上限</span><b>' + S.user.dailyCapMin + ' min</b></div>' +
        '<div class="vs"><span>高效时段</span><b>19–22</b></div>' +
      '</div></div>' +

      (trash ? '<div class="banner sd-restore">' +
        '<div><div class="bt">删除的数据还能恢复，剩 ' + trash.daysLeft + ' 天</div>' +
        '<div class="bs">计划 / 记录 / 目标 / 可用时段 · 超过 7 天自动清除</div></div>' +
        '<span class="spacer"></span>' +
        '<button class="btn sd-restore-btn" data-act="trash-restore">恢复已删除数据（剩 ' + trash.daysLeft + ' 天）</button>' +
      '</div>' : '') +

      '<div class="sec-h"><span class="n">01</span><span class="t">可用时段</span><span class="rule"></span><span class="r">7 × 4 时间带</span></div>' +
      '<div class="panel"><div class="panel-b">' +
        '<div class="sd-avail-top"><span class="sd-avail-sum">' + sum + '</span>' +
          '<span class="sd-avail-tag">22–24 静默</span></div>' +
        '<div class="sd-avail-grid" role="group" aria-label="每周可用时段">' +
          '<span class="sd-hd"></span>' +
          SLOTS.map(function (s, i) {
            return '<span class="sd-hd' + (i === 3 ? ' silent' : '') + '">' + s + (i === 3 ? '<em>静默</em>' : '') + '</span>';
          }).join('') +
          grid.map(function (row, d) {
            return '<span class="sd-row-d">' + DAYS[d] + '</span>' +
              row.map(function (on, s) { return cell(d, s, on); }).join('');
          }).join('') +
        '</div>' +
        '<div class="sd-avail-ops">' +
          '<button class="btn" data-act="avail-bulk" data-kind="copy">复制周一到工作日</button>' +
          '<button class="btn" data-act="avail-bulk" data-kind="clear">全部清空</button>' +
          '<button class="btn" data-act="avail-bulk" data-kind="reset">恢复默认</button>' +
        '</div>' +
        '<p class="sd-avail-note">可用窗口是能排程的时间带，实际投入仍以每周可用小时 ' + S.user.weeklyH +
          ' h 为准。22:00–08:00 为夜间静默，不可开启。</p>' +
      '</div></div>' +

      '<div class="sec-h"><span class="n">02</span><span class="t">通知策略</span><span class="rule"></span><span class="r">分级可关</span></div>' +
      '<div class="panel"><div class="panel-b">' +
        swRow('每日提醒', '19:00 · 今日 3 项', 'daily') +
        swRow('周报', '周日 20:00 · 最少打扰', 'weekly') +
        swRow('进度预警', '必须附带补救方案', 'alert') +
        swRow('中断挽救', '连续 3 天无记录时触发', 'rescue') +
        '<div class="sw"><div><span class="n">夜间静默</span><small>22:00–08:00 · 服务端裁决</small></div><span class="spacer"></span><span class="tg on lock"></span></div>' +
      '</div></div>' +

      ZX.ui.fold('me:data', {
        title: '数据与隐私',
        meta: S.exportLog ? '上次导出 ' + S.exportLog.rows + ' 行' : '导出 · 删除 · 7 天恢复',
        body:
          '<div class="row2"><span class="k">待同步</span><span class="v" id="opPending">' + ZX.api.pendingCount() + '</span></div>' +
          '<div class="row2"><span class="k">同步序号</span><span class="v">' + S.serverSeq + '</span></div>' +
          '<div class="row2"><span class="k">上次同步</span><span class="v">' + U.nowStr() + '</span></div>' +
          '<div class="row2"><span class="k">待确认冲突</span><span class="v">0</span></div>' +
          '<div class="row2"><span class="k">离线可用</span><span class="v">读 / 写 / 计时</span></div>' +
          (S.exportLog
            ? '<div class="row2"><span class="k">上次导出</span><span class="v">' +
              U.esc(S.exportLog.filename) + ' · ' + S.exportLog.rows + ' 行</span></div>'
            : '') +
          '<div class="sd-data-act"><button class="btn" data-act="export">导出计划与记录</button>' +
            '<span class="sd-data-n">生成 CSV · 本机下载</span></div>' +
          '<div class="sd-danger">' +
            '<button class="btn danger" data-act="wipe">删除全部数据</button>' +
            '<span class="sd-danger-n">本机计划与记录 · 7 天内可恢复</span>' +
          '</div>'
      }) +

      ZX.ui.fold('me:display', {
        title: '显示与动效',
        meta: '网格 · 辉光 · 字号',
        body:
          fontRow() +
          prefRow('科技网格', '背景坐标网格 · 低频漂移', 'grid') +
          prefRow('辉光与扫描', '顶部扫光 · 运行时高亮', 'glow') +
          prefRow('界面动效', '入场级联 · 图表绘制 · 进度增长', 'motion') +
          '<p class="pref-note">偏好写入浏览器本地（localStorage），仅影响本机视觉；系统开启「减少动态效果」时动效始终关闭。</p>'
      }) +
      '<div class="foot-note"><span>identity</span><span>tz ' + S.user.tz + '</span><span>软删 7 天可撤回</span></div>' +
    '</div>';
  }

  function cell(d, s, on) {
    var silent = s === 3;
    return '<button type="button" class="sd-cell' + (silent ? ' silent' : '') + '"' +
      ' data-act="avail" data-day="' + d + '" data-slot="' + s + '"' +
      ' aria-pressed="' + (on ? 'true' : 'false') + '"' +
      (silent ? ' title="夜间静默，不可排程"' : '') +
      ' aria-label="' + DAYS[d] + ' ' + SLOTS[s] +
      (silent ? '（夜间静默，不可排程）' : (on ? '（可排程）' : '（不可排程）')) + '"></button>';
  }

  function fontRow() {
    var f = ZX.util.prefs().font || '';
    var opts = [['', '标准'], ['m', '稍大'], ['l', '大']];
    return '<div class="sw"><div><span class="n">字号</span><small>正文字号 · 13 / 14 / 15 px</small></div>' +
      '<span class="spacer"></span>' +
      '<span class="seg sd-font" role="group" aria-label="字号">' +
        opts.map(function (o) {
          return '<button type="button" data-act="font" data-v="' + o[0] + '"' +
            ' class="' + (f === o[0] ? 'on' : '') + '"' +
            ' aria-pressed="' + (f === o[0] ? 'true' : 'false') + '">' + o[1] + '</button>';
        }).join('') +
      '</span></div>';
  }

  function prefRow(n, sub, key) {
    var p = ZX.util.prefs();
    return '<div class="sw"><div><span class="n">' + n + '</span><small>' + sub + '</small></div>' +
      '<span class="spacer"></span><span class="tg ' + (p[key] ? 'on' : '') + '" data-act="pref" data-key="' + key + '"></span></div>';
  }

  function swRow(n, sub, key) {
    var S = ZX.state;
    return '<div class="sw"><div><span class="n">' + n + '</span><small>' + sub + '</small></div>' +
      '<span class="spacer"></span><span class="tg ' + (S.notif[key] ? 'on' : '') + '" data-act="tg" data-key="' + key + '"></span></div>';
  }

  ZX.views = ZX.views || {};
  ZX.views.me = me;

})(window.ZX);
