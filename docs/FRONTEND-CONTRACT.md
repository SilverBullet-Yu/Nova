# 前端能力补齐 · 协作契约（FRONTEND CONTRACT）

> 本文件是「管理者」与「执行者」之间的唯一接口依据。
> 执行者只在自己的文件边界内工作，契约变更须先改本文件再改代码。
> 依据：`产品需求文档（PRD）`（V1.0）与 `docs/ARCHITECTURE.md`。

---

## 1. 阶段划分与验收

| 阶段 | 主题 | 覆盖需求 | 验收口径 |
|---|---|---|---|
| A | 目标落地 | F-1.1 / F-1.2 / F-2.1 / F-2.2 / F-2.3 | 新建目标 → 可行性判定 → R<0.7 校准 → 草案编辑（改工时 / 增删 / 拖动排序 / 超载提示）→ 确认后进入计划页 |
| B | 中断挽救 | F-7.1 / F-7.2 / F-7.3 | 连续 ≥3 天无记录可识别 → 缺口量化 → 压缩 / 顺延 / 降级三选一 → 一键生效 → 零惩罚文案 |
| C | 执行与计划交互 | F-4.1 / F-4.2 / F-4.3 / F-3.2 / F-3.3 / F-3.5 / F-5.2 | 暂停/继续、部分完成、跳过、补录；周视图拖动改期 + 日上限校验 + 锁定；重排显性入口与逐条否决 |
| D | 设置与适配 | F-8.1 / F-8.3 / F-8.4 / 移动端 | 可用时段编辑与批量复制、真实导出文件、删除全部数据；≤860px 单列 + 底部导航 |

阶段**串行**执行：同一时间只允许一个执行者改动仓库。

> Stage C 拆分：**C-1 执行记录**（暂停 / 部分完成 / 跳过 / 补录，样式前缀 `.sc-`，主改 `views/today.js` 与 `flows/exec.js`）；**C-2 计划交互**（拖拽改期 / 锁定 / 重排入口 / 逐条否决，样式前缀 `.sc2-`，主改 `views/plan.js` 与 `assistant.js`）。两者串行，C-1 先交付。

---

## 2. 架构约定（不可违反）

1. **零依赖**：只用原生 DOM 与 `node:` 内置模块；禁止 ESM、构建工具、CDN、第三方库。
2. **经典 script**：新增 JS 用 IIFE 挂到 `window.ZX`，必须支持 `file://` 双击。
3. **视图即字符串**：新增视图仍以 `ZX.views.<id>()` 返回 HTML；事件通过 `data-act` 委托，不内联 `onclick`。
4. **状态单一来源**：业务状态只放在 `ZX.state`。新增字段必须写注释；**不得重命名或删除既有字段**。
5. **引擎纯函数**：`shared/engine/*` 不得改动；前端不得复制排程/可行性算法。
6. **不写后端**：`server/**`、`test/**` 不属本阶段范围（除非新增纯前端测试）。
7. **降级**：所有新交互在无后端时必须可用（本地引擎 + localStorage）。
8. **转义**：凡从 `ZX.state` 或用户输入拼入 HTML 的动态字符串一律过 `ZX.util.esc`（含单引号）；仅数字与内部 token 可豁免。

## 3. 共享 UI 原语（已由管理者实现）

脚本：`assets/js/ui.js`（`index.html` 中位于 `util.js` 之后）。

```js
ZX.ui.sheet({
  eyebrow: 'GOAL / 新建',
  title: '设定你的目标',
  sub: '一句话说明',
  body: '<div class="field">…</div>',   // HTML 字符串
  footer: '<button class="btn ghost" data-close>取消</button><button class="btn pri" id="ok">下一步</button>',
  wide: false,                           // true → 820px 宽
  onClose: function (result) {}          // 关闭回调（含 ESC / 遮罩）
}) // → { root, $, close(result), setBody(html) }

ZX.ui.confirm({ title:'删除全部数据？', text:'…', okText:'删除', danger:true })
  // → Promise<boolean>

ZX.ui.toast('已保存', 'ok' | 'warn' | 'bad')
```

配套样式类（`app.css` 末尾「共享 UI 原语」区块）：
`.ovl` `.sheet` `.sheet-h` `.sheet-b` `.sheet-f` `.field` `.input` `.hint` `.seg` `.notice` `.notice.warn` `.banner` `.empty` `.toast` `.btn.danger`。

## 4. 状态字段预留（防止撞名）

| 字段 | 归属 | 语义 |
|---|---|---|
| `goalDraft` | A | 目标创建中的临时草稿 `{ type, name, deadline, weeklyH, weeks, base, demand }` |
| `planDraft` | A | 拆解后的计划项数组 `[{ id, s, title, est, weight, order }]` |
| `consecutiveZeroDays` | B | 连续无记录天数（种子为 0） |
| `interrupted` | B | 是否处于中断态；`null` 表示未判定 |
| `rescueRecord` | B | 挽救决策 `{ strategy, at, deltaMin }` |
| `sessions` | C | 执行记录 `[{ id, taskId, startAt, endAt, minutes, completion, status }]`，`status ∈ done / partial / skip / backfill` |
| `pausedAt` | C | 暂停时刻（毫秒）；`null` 表示未暂停 |
| `locks` | C | `{ [taskId]: true }` 锁定标记；重排跳过 |
| `avail` | D | 7×4 可用时段布尔网格（周一到周日 × 08–12 / 12–18 / 18–22 / 22–24） |
| `exportLog` | D | 最近一次导出 `{ at, rows, filename }` |

## 5. 样式规范

- 颜色、间距、动效只取 `app.css` 顶部 token：`--ac` `--txt*` `--line*` `--dur` `--ease`。
- 直角优先（`--r: 2px`），1px 发丝线，数字用 `--mono` / `--display`。
- 新增选择器统一加阶段前缀：`.sa-`（A）、`.sb-`（B）、`.sc-`（C）、`.sd-`（D），避免与既有类冲突。
- 新样式**追加**到 `app.css` 末尾对应阶段区块，不重排既有规则。
- 所有动效必须可被 `html[data-motion="off"]` 与 `prefers-reduced-motion` 关闭。

## 6. 文案规范

- 面向学生，第二人称，克制、不施压；禁止「仅剩 X 天」「你已落后 X%」类表达。
- 不得承诺未实现的能力（例如没有拖拽就不能写「拖动调整」）。
- 数值必须来自 `ZX.state` 或引擎结果，不得写死与状态矛盾的文案。

## 7. 验证协议（每个阶段必须执行）

```bash
node --check assets/js/<改动文件>.js
npm test
```

- 浏览器：`PORT=8788 HOST=127.0.0.1 node server/main.js`，Playwright 截图 1440×900；
  新增移动端布局的阶段需补 390×844。
- 检查项：无横向溢出、无文字截断、无 console 报错、`file://` 可打开、关闭动效后不破版。
- 验收截图存放 `.tmp/ui/`，不入库。

## 8. 交接日志

每阶段完成后在此追加，格式固定：`### Stage X · 交付` → 变更文件 / 新增状态 / 交互路径 / 验证结果 / 遗留。

### Stage A · 交付

**变更文件**

- 新增 `assets/js/flows/goal.js`：IIFE 挂 `ZX.flows.goal`，四步流程全部在此
- 修改 `index.html`：仅在 `assistant.js` 之后加一行 `assets/js/flows/goal.js`
- 修改 `assets/js/views/plan.js`：头部加「新建目标」按钮（`[data-goal-new]`），未改既有布局
- 修改 `assets/js/assistant.js`：INTENTS 首条 `新建目标 / 定目标 / 改目标` + `goalFlow()` + 导出
- 修改 `assets/css/app.css`：末尾追加 Stage A 区块（选择器全部 `.sa-` 前缀，只用顶部 token）

**新增状态与接口**

- `ZX.state.goalDraft = { type, name, deadline, weeklyH, weeks, base, demand, discount }`
- `ZX.state.planDraft = [{ id, s, title, est, weight, order }]`
- 两者由 `ZX.flows.goal.open()` 初始化，确认生效或关闭时置 `null`
- `ZX.flows.goal.open()`、`ZX.flows.goal.apply()`
- 演示常量：`BASE_HOURS` 考研 913 / 考公 660 / 项目导学 520；`BASE_COEF` 1.30 / 1.00 / 0.75 / 0.60；
  `DISCOUNT 0.85`、`GATE 0.70`、`TARGET_R 0.90`；可行性一律走 `ZX.engine.feasibilityNow`

**交互路径**

1. 计划页「新建目标」或对话「新建目标 / 定目标 / 改目标」→ 第 1 步表单（类型 / 名称 / 截止 / 周时长 / 基础），实时预览 D 与周期
2. 下一步 → 可行性：R 大字、判定、T / D / 缓冲 / 缺口；R < 0.70 在同一弹层切校准，三条路径（提高周投入 / 延长周期 / 缩小范围）各自可应用并立即重算，「进入拆解」禁用
3. R ≥ 0.70 → 拆解草案（弹层切 `wide`）：7 项模板，±15 分钟（15–240）、删除、拖动排序、添加；顶部总时长 / 周容量 / 负载比 / 当前 R；>1.15 倍容量提示超载并可一键压缩；修改幅度 >30% 提示
4. 确认生效 → 写回 `goal` / `feas` / `tasks`（前 4 项 09:00 起、`done:false`、`weight` 沿用）→ 清草稿、关弹层、`toast('目标已生效')`、`render()`、切「计划」

**验证**

- `node --check` 三个 JS 文件通过；`npm test` 50/50 通过
- 1440×900 截图（`.tmp/ui/`）：`sa-1-form`、`sa-2-calibrate`（周 5 h → R 0.27，按钮禁用）、`sa-3-draft`、`sa-4-plan-after`；补充 `sa-0-plan-head`、`sa-1b-errors`、`sa-2b-pass`、`sa-2c-demand`、`sa-2d-cap`、`sa-3-overload`、`sa-3-compressed`、`sa-3-rows-zoom`、`sa-4b-today`、`sa-5-motion-off`、`sa-6-file-protocol`、`sa-7-mobile-form`
- 溢出审计：`documentElement` / `.sheet` / `.sheet-b` 的 `scrollWidth-clientWidth` 均为 0，无文本截断
- console 0 报错；`file://` 下仅 `/api` 探测 `ERR_CONNECTION_REFUSED`（离线降级预期），流程可用
- R < 0.70 时 ESC 关闭：`goalDraft/planDraft` 归 null，`goal` / `tasks` 未变
- `html[data-motion="off"]` 下弹层 560×373、`opacity 1`，不破版
- 键盘：打开聚焦名称输入；换步后焦点留在弹层内；Tab / Shift+Tab 在弹层内循环；连续点 ± 焦点不丢失

**修掉的问题**

- 重绘导致焦点落回 `body` → 记录 `data-sa`/`data-id` 后重放，无匹配时聚焦弹层内首个可用控件
- 「添加计划项」已输入内容在 ± 重绘时被清空 → `render()` 前 `captureAdd()`
- 模板前 4 项同科重复 → 调整为「一天四科各一项」，确认后今日页四科齐全
- 求解到 520 周仍达不到 0.90 却仍提示改期 → 改为明示「已到上限，仍低于 0.90」
- R ≥ 0.70 文案「不低于 0.70」→「在可执行区间（≥ 0.70）」

**遗留**

- 计划页 `04 计划项`、`02 阶段结构` 仍是既有静态示例，不随新草案变化（本阶段只允许加按钮，未改）
- `03 未来 7 天负载` 取 `state.week`，新目标不重排周视图（属 Stage C）
- 仅支持单一 active 目标；「改目标」等同重新创建，不能编辑既有目标
- 排序只有指针拖拽（HTML5 DnD），键盘可达的是行内按钮，没有键盘排序快捷键
- 周容量按 `weeklyH × 60` 计，未接 `user.dailyCapMin` 与可用时段（Stage D）
- 未接后端：`/api/*` 无目标创建接口，刷新页面后回落到 seed，新目标不持久化

### Stage B · 交付

**变更文件**

- 新增 `assets/js/flows/rescue.js`：IIFE 挂 `ZX.flows.rescue`，识别 / 弹层三屏 / 生效全部在此
- 修改 `index.html`：仅在 `flows/goal.js` 之后加一行 `assets/js/flows/rescue.js`
- 修改 `assets/js/views/today.js`：`wrap` 顶部插入 `rescueBanner()`（`ZX.flows.rescue.banner()` 的薄封装，flows 缺失时返回空串），未改既有块
- 修改 `assets/js/assistant.js`：INTENTS 首条 `我断了四天 / 断了 / 中断 / 挽救 / 没打开` + `rescueFlow()` + 导出
- 修改 `assets/css/app.css`：末尾追加 Stage B 区块（选择器全部 `.sb-` 前缀，只用顶部 token）

**新增状态与函数签名**

- `ZX.state.consecutiveZeroDays = 0`、`ZX.state.interrupted = null`、`ZX.state.rescueRecord = null`（由 rescue.js 载入时补写，未改 state.js）
- `rescueRecord = { strategy, at, deltaMin, dropped: [{ id, title, subject, est, weight, abandoned }], gapBefore, gapAfter }`
  - `deltaMin` = 消除的缺口（`gapBefore − gapAfter`）
- `ZX.flows.rescue.detect()` → boolean；`open()`；`banner()` → HTML；`metrics()`；`optionOf(key)`；`apply()`；常量 `THRESHOLD = 3`、`DEMO_ZERO_DAYS = 4`
- 缺口口径（全部由 state 推导，不写死）：
  `原计划 = Σ state.week[].total`；`已投入 = state.workedMin()`；`每日可用 = state.feas.weeklyH × 60 / 7`；
  `剩余天数 = 3`（演示：中断 4 天后本周只剩 3 天）；`剩余可用 = 每日可用 × 剩余天数`；`缺口 = max(0, 计划 − 已投入 − 剩余可用)`
- 三种方式在同一公式下换输入：
  压缩 → 计划收敛为「已投入 + 压缩后未完成」（已流失的天不再补排）；顺延 → 计划不变、剩余天数 +7；降级 → 计划 = 扣除放弃项后的剩余

**交互路径**

1. 对话「我断了四天 / 断了 / 挽救 / 没打开」→ 写入演示天数 4（真实环境由执行记录计算）→ `detect()` → 今日页顶部 `.banner.sb-banner`（文案「这周还剩 3 天，落下的 5 小时 41 分可以重排」+「进入挽救」）→ 自动打开弹层
2. 第 1 屏「缺口四宫格」：本周原计划 15h15 / 已投入 1h / 剩余可用 8h34 / 缺口 5h41（341 min）；缺口为 0 时改述「本周没有硬缺口，可选择降载保节奏」
3. 第 2 屏三张单选卡（默认压缩，可 Tab 聚焦、Enter 选中）：压缩 90→54、75→45 / 顺延 截止 +7 天 2028-01-01、可用 8h34→28h34 / 降级 380→350 分、放弃 2 项；每张都给出「缺口 5h41 → 0m」与代价
4. 第 3 屏确认摘要 →「确认并恢复」→ 写 `tasks`（est / degraded / 被放弃项从列表移除并记入 `rescueRecord.dropped`）、`feas.weeks`、`goal.deadline` / `goal.target`、`consecutiveZeroDays = 0`、`interrupted = false` → `ZX.api.queueOp({ entity:'rescue', entityId:'w1', field:'applied', … })` → 关弹层 → `render()` → 零惩罚 banner「计划已接回…」→ `toast('已恢复')` → 对话追加一条小序说明
5. 关闭 / ESC / 取消：不写任何状态（`rescueRecord` 保持 null）；回归 banner 可「知道了」收起；再次触发演示入口可重走

**验证**

- `node --check` rescue.js / assistant.js / today.js 通过；`npm test` 50/50 通过
- 1440×900 截图（`.tmp/ui/`）：`sb-1-banner`、`sb-2-gap`、`sb-3-options`、`sb-4-confirm-compress`、`sb-4-confirm-defer`、`sb-4-confirm-downgrade`、`sb-5-today-after-compress`、`sb-5-today-after-defer`、`sb-5-today-after-downgrade`、`sb-6-mobile-banner`、`sb-7-mobile-gap`、`sb-7-mobile-options`、`sb-8-motion-off-banner`、`sb-8-motion-off-sheet`、`sb-9-file-banner`、`sb-9-file-options`、`sb-9-file-after`
- 关键数值（seed 状态）：周计划 915 min、已投入 60、剩余可用 514、缺口 341；压缩后 `plannedMin 270 → 159`（t2 54 / t3 45，t4 放弃），降级后 `plannedMin 150`、`target 350 分`，顺延后 `feas.weeks / goal.weeks 59`、`deadline 2028-01-01`；三者 `gapAfter = 0`、`deltaMin = 341`
- 溢出审计：`.sheet-b` / `.sb-opts` / `.sb-banner` 的 `scrollWidth − clientWidth` 均为 0（1440 与 390 弹层内均为 0）
- 关闭动效：`html[data-motion="off"]` 下弹层 840×507、`opacity 1`、banner 宽 925 且溢出 0，不破版
- `file://` 双击：`seedSource = shared`，识别 / 三屏 / 生效 / toast 全通，op 队列离线 `pending 1`；console 仅 `/api/health` `ERR_CONNECTION_REFUSED`（离线降级预期）
- 键盘：Tab 可达三张卡片，Enter 选中；ESC 关闭后 `rescueRecord` 仍为 null
- 重复进入：`知道了` 收起回归 banner；再输入「断了」→ banner 重现、`interrupted = true`

**遗留**

- 连续无记录天数目前由演示入口写入 4（真实环境应由执行记录算），`detect()` 只做 ≥3 判定
- 390×844 下外壳（rail 60 + copilot 330 + bench）本身横向溢出 84px（`documentElement.scrollWidth 474`），属 Stage D 移动端单列范围；Stage B 的 banner / 弹层自身未新增溢出
- 被放弃的任务从 `state.tasks` 移除（今日页不显示已放弃项），`abandoned: true` 只保留在 `rescueRecord.dropped` 与 op 队列里；若 Stage C 要展示「已放弃」列表，需在视图层补渲染
- 压缩 / 降级只改今日任务与目标，`state.week` 七天总量不变，因此缺口公式的「原计划」在恢复后仍显示 341（演示入口可重复触发，便于复看）
- 未接后端 `rescue` 实体：op 队列只上行 `field: 'applied'`，刷新页面回落到 seed

### Stage C-1 · 交付

**变更文件**

- 新增 `assets/js/flows/exec.js`：暂停 / 部分完成 / 跳过 / 补录全部在此，IIFE 挂 `ZX.flows.exec`
- 修改 `index.html`：仅在 `flows/rescue.js` 之后加一行 `assets/js/flows/exec.js`
- 修改 `assets/js/views/today.js`：任务行（暂停 / 跳过 / 部分完成标记）、`已跳过` 折叠区、区标题「补录」入口、统计区补录块、summary 补录一句；统计改为视图层口径（过滤 `skipped`）
- 修改 `assets/js/assistant.js`：仅 `startTask` / `tickTimer` / `finishTask` + 新增导出 `elapsedMs`；未改 replan / feasibility / undo 等 flow
- 修改 `assets/css/app.css`：末尾追加 Stage C-1 区块（选择器全部 `.sc-` 前缀，只用顶部 token）
- 修改 `docs/FRONTEND-CONTRACT.md`：本日志

**新增状态与字段**

- `ZX.state.pausedAt`（ms｜null）、`ZX.state.pausedTotal`（累计暂停毫秒，默认 0）
- `ZX.state.sessions`（契约预留字段，本阶段开始写入）：`[{ id, taskId, startAt, endAt, minutes, completion, status, isBackfill }]`
- `ZX.state.skippedOpen`（boolean，默认 false）：「已跳过」折叠区展开态；纯视图状态也放 state，保证 `render()` 后不丢
- 任务新增字段（不改 state.js）：`skipped`、`skipReason`、`skippedAt`、`partial`（最近一次部分完成度）、`completion`
- `status` 语义：正常记录取所选感受（顺利 / 吃力 / 分心 / 疲惫）；未选感受时按完成度落 `done` / `partial`；跳过固定 `skip`、补录固定 `backfill`。因此 `status` 不总是四枚举，读取方需容错（见遗留）

**新增函数（`ZX.flows.exec`）**

`metrics()`、`activeTasks()`、`backfillMin()`、`partialEst(est, pct)`、`elapsedMin()`、`record(o)`、`applyRecord(id, o)`、`togglePause(id)`、`openRecord(id)`、`commitRecord(...)`、`openSkip(id)`、`commitSkip(id, reason)`、`restoreTask(id)`、`toggleSkipped()`、`openBackfill()`、`commitBackfill(...)`；同时挂 `ZX.exec` 别名
`ZX.assistant.elapsedMs()`：`max(0, now − timerStart − pausedTotal − (pausedAt ? now − pausedAt : 0))`，`tickTimer` 与记录共用同一公式

**交互路径**

1. **暂停 / 继续**：开始 → 行内出现 `暂停`；暂停后 `pausedAt=now`、计时冻结（实测 `00:04` 两秒后仍 `00:04`）、按钮变 `继续`、行内出现 `.sc-paused`「已暂停」；继续时把 `Date.now() − pausedAt` 累加进 `pausedTotal`。暂停态在 `ZX.render()` 后保持（状态在 state，不在 DOM）
2. **部分完成**：`结束` → `ZX.ui.sheet`「记录这次执行」（EYEBROW `EXEC / 记录`）：本次计时、完成度 25/50/75/100（默认 100）、状态四项（可再点一次取消）、底部 `取消 / 记录`。`结束 → 记录` 共 2 次点击即可完成；关闭 / ESC 不写任何状态，计时继续
   - 100%：`done=true`、`actual=minutes`、`completion=100`，行内 `已记录 1m`
   - <100%：`done=false`、`actual=(actual||0)+minutes`、`est=max(15, round(est×(1−pct/100)))`、`partial=pct`，行内 `已完成 50% · 余 45m`，对话说明「剩余 45m 已顺延到弹性位」
   - `按预估记录` / 未开始行的 `完成`：直接 100%、`minutes=est`、不弹窗
3. **跳过**：未开始（未 done / 未 skipped / 未在计时）的行新增 `跳过` ghost → 弹层单选原因（临时有事 / 状态不好 / 任务过难 / 其他，默认第一项）→ `记入跳过`：写 `status:'skip', minutes:0` 的 session、`skipped=true`，任务从今日列表移出，末尾出现 `已跳过 N 项 · 恢复` 折叠区（默认收起，点开后每项 `恢复` → `skipped=false`）。不计入欠账、不计入剩余时长（视图层过滤 `skipped`，state.js 未改）。对话「开始」若命中已跳过项，`startTask` 会先恢复再计时，避免计时器落在不可见的行上
4. **补录**：「今日任务」区标题右侧 `补录` → 弹层（任务下拉 = 未完成任务 / 日期默认今天 / 实际分钟默认 30 / 完成度默认 100）→ 写 `status:'backfill', isBackfill:true` 的 session；不改任务 `done/est/actual`。统计区出现 `补录 30m / 不计入达成率`，summary 追加一句

**验证**

- `node --check` exec.js / today.js / assistant.js 通过；`npm test` 50/50 通过
- 服务：`PORT=8791 HOST=127.0.0.1 node server/main.js`，1440×900 全流程 Playwright 实测
- 截图（`.tmp/ui/`）：`sc-1-running`、`sc-2-paused`、`sc-3-record-sheet`、`sc-3b-record-50`、`sc-4-partial`、`sc-5-skip-sheet`、`sc-5b-skip-reason`、`sc-6-skipped-collapsed`、`sc-7-skipped-open`、`sc-8-backfill-sheet`、`sc-9-backfill-stat`、`sc-10-mobile`、`sc-11-mobile-skip`、`sc-12-motion-off-paused`、`sc-13-motion-off-sheet`、`sc-14-restored`、`sc-15-file-paused`、`sc-16-file-sheet`、`sc-17-file-partial`、`sc-18-record-100`、`sc-19-est-record`、`sc-20-backfill-filled`、`sc-21-feel-selected`
- 计时：开始 → 1.4s → 暂停 `00:04` → 等 2s 仍 `00:04` → 继续 `pausedTotal=8447`、`00:06` → 结束（分钟 = floor，最小 1）
- 部分完成：t2 90 min 记 50% → `est 45`、`actual 1`、`partial 50`、`planned 270→225`、`rate 22%→27%`，行内 `已完成 50% · 余 45m`
- 跳过：t3 75 min → `planned 225→150`、`rate 27%→40%`、`skipped:['t3']`，折叠区标题 `已跳过 1 项 · 恢复`，恢复后 `skipped:[]`、`planned` 回到 225
- 补录 30 min → `metrics.backfill=30`，统计区文本 `计划2h30 已投入1h 达成率40% 补录30m 不计入达成率 弹性位1 空闲`，达成率不变
- 100% 记录：`t4 done=true, actual=1, completion=100, status:'done'`，行内 `已记录 1m`，无 `.sc-part`；`按预估记录` 路径无弹层（`.ovl=false`）、`actual=90`、`rate=56%`
- 补录填表：`实际分钟=45`、`日期=2026-11-07`、完成度 50 → session `{ minutes:45, completion:50, startAt:11-07 00:00, endAt:+45m, status:'backfill' }`，任务 `est/done` 不变，`metrics.backfill=0`（非今日的补录不计入今日统计）
- 状态选择：点「吃力」→ 该条记录 `status:'吃力'`、`completion:100`，对话里带上状态；不选则落 `done` / `partial`
- 重复点击「记录」只写一条 session（连点两次后 `sessions` = `['t3:skip','t2:done']`）；`startTask('t3')` 命中已跳过项时 `skipped` 清空、行与计时器重新出现
- sessions 样例（实测输出原样摘录，前三条同一次运行，第四条为单独的 100% 路径）：
  ```json
  [{"id":"s_mw7gb4d4_1","taskId":"t2","startAt":1794119276276,"endAt":1794119293608,"minutes":1,"completion":50,"status":"partial","isBackfill":false},
   {"id":"s_mw7gbd06_2","taskId":"t3","startAt":1794119312022,"endAt":1794119312022,"minutes":0,"completion":0,"status":"skip","isBackfill":false},
   {"id":"s_mw7gbo1w_3","taskId":"t2","startAt":1794067200000,"endAt":1794069000000,"minutes":30,"completion":100,"status":"backfill","isBackfill":true},
   {"id":"s_mw7gj975_1","taskId":"t4","startAt":1794119675393,"endAt":1794119678392,"minutes":1,"completion":100,"status":"done","isBackfill":false}]
  ```
- op 队列：每条 session 都入一条 `{ entity:'session', field:'recorded', value:<session> }`（联机时 pending 转 false，seq 上行）
- 溢出审计 1440×900：`documentElement / .wrap / .sc-skips / [data-task]` 的 `scrollWidth−clientWidth` 均为 0
- 390×844：弹层宽 390、`.sheet-b` 溢出 0；`documentElement.scrollWidth` = 474（与 Stage B 记录的基线一致，外壳 60+392 固定列所致，属 Stage D）
- `html[data-motion="off"]`：`.ovl` / `.sheet` 计算 `opacity:1`，暂停标签与记录弹层均正常，不破版
- `file://`（`PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS=1`）：`seedSource=shared`、`online=false`，开始 / 暂停 / 结束 / 25% 记录全通，`sessions` 正常写入；console 仅 `/api/health` `ERR_CONNECTION_REFUSED`（离线降级预期）
- http 下 console 0 报错

**遗留风险**

- `status` 一字段两用（感受标签 / 记录类型枚举）。读取 `sessions` 的一方需按「`skip` / `backfill` / `done` / `partial` 或四个感受词」容错；后续若要严格枚举，应拆出 `feel` 字段
- 390×844 外壳本身横向溢出 84px（`scrollWidth 474`），Stage C-1 未新增页面级溢出，但也没有修（属 Stage D 单列改造）
- 部分完成后任务 `time`（如 `10:30–12:00`）未重排，只改 `est`，行内会出现「时段 90 分钟、预估 45m」的不一致；rescue.js 有 `retime` 但为私有实现，本阶段不复制
- 部分完成的 `actual` 不计入 `workedMin`（`done=false`），达成率按「完成项 / 剩余计划」计，未完成的那部分投入在数字上不可见（设计取舍，避免部分完成被重复计分）
- 跳过的任务仍留在 `state.tasks` 且 `est` 不变：`state.plannedMin()` / `state.rate()` / `state.replanInput()` 仍会算上它；今日页已在视图层过滤，计划页与数据页（C-2 / 后续）需自行过滤
- 记录统一走 op 队列（`entity:'session'`），不再额外 `POST /api/sessions`；后端该接口目前只被服务端测试覆盖
- 补录只写本地 `sessions`，刷新后回落 seed（未持久化）；后端无 `session` 实体的回读接口
- 同一时刻只支持一个任务计时；开始新任务会重置 `pausedAt/pausedTotal`，旧任务不计暂停

### Stage C-2 · 交付

**变更文件**

- 新增 `assets/js/flows/planedit.js`：日程块视图 / 拖拽改期 / 锁定 / 逐条否决的事件与状态全部在此，IIFE 挂 `ZX.flows.planedit`
- 修改 `index.html`：仅在 `flows/exec.js` 之后加一行 `assets/js/flows/planedit.js`
- 修改 `assets/js/views/plan.js`：头部加「重新安排」（`[data-replan-run]`）；周图下方插 `.sc2-board`；`weekChartData()` 拆成 `baseWeekData()` + 叠加 `weekDeltas()`；周图加 `.sc2-chart-note`；`04 计划项` 跳过已否决的压缩
- 修改 `assets/js/assistant.js`：`replanFlow` 下行 `locked` 字段；`renderReplanResult` 过滤命中锁定项的 diff、跳锁定项的压缩落盘、加「N 个锁定块未参与」与 diff 行「否决」按钮；未改 feasibility / undo 语义
- 修改 `assets/css/app.css`：末尾追加 Stage C-2 区块（选择器全部 `.sc2-` 前缀，只用顶部 token）
- 修改 `docs/FRONTEND-CONTRACT.md`：本日志

**新增状态与函数**

- `ZX.state.dayAssign`（新）：`{ [taskId]: '一'…'日' }` 稀疏表，缺省即「日」，只记被拖走的块
- `ZX.state.locks`（契约预留字段，首次写入）：`{ [taskId]: true }`
- `ZX.state.replanRecord.vetoed`（追加）：`[{ taskId, op, at }]`，`op ∈ compress / defer`
- `ZX.flows.planedit`：`board()`、`loads()`、`weekDeltas()`、`movedCount()`、`lockedCount()`、`assignOf()`、`probe()`、`moveTask()`、`toggleLock()`、`veto()`、`isVetoed()`、`vetoedSubjects()`、`CAP()`
- 负载口径：`total(d) = base(d) + 迁入(d) − 迁出(d)`，`base` 取 `state.week[].total`（不写回），迁出只从基线日「日」扣除
- 探针：`probe(taskId, day)` 返回 `{ ok, load, cap, day }`，`cap = state.user.dailyCapMin`（300）

**交互路径**

1. **日程块**：`03 未来 7 天负载` 周图下方 7 列（周一…周日），块来源 `state.tasks`（`!done && !skipped`），每块 = 科目色点 + 标题 + 分钟 + `◇` 锁按钮；列头显示 `当日/上限`（如 `240/300`）
2. **拖拽改期**：HTML5 DnD（`dragstart/dragover/dragleave/drop/dragend` 全部委托在 document）；源块 `.is-drag` 半透明、目标列 `.is-over` 高亮；松手写 `state.dayAssign` → `ZX.render()` → toast「已移到周三 · 当日 240 / 300 分钟」→ op `{entity:'plan',entityId:'dayAssign',field:'moved'}`
3. **日上限拒绝**：目标日 > 300 时不写状态、块留在原列（回弹），toast「周三将达 315 分钟，超过日上限 300」，源块加 `.is-rej` 抖动
4. **周图联动**：`weekChartData()` 按 `delta` 缩放当日色段，`日 270→180`、`三 150→240`；周图下方出现「含手工改期 1 项」（有锁定时追加「已锁定 N 项」）
5. **锁定**：块内 `◇/◆` 按钮（原生 button，`aria-pressed`、`aria-label`），写 `state.locks[taskId]`；锁定块 `draggable="false"`、`dragstart` 里再 `preventDefault` 兜底、块内显示「已锁定」；重绘后焦点按 `data-pe-lock` 回放到同一按钮
6. **重排入口**：计划页头部「重新安排」→ `ZX.assistant.replanFlow()`（不复制重排逻辑）；`replanFlow` 把 `locks[taskId]` 写进每条 input task 的 `locked` 字段后调引擎
7. **锁定项不参与**：引擎返回后过滤 `diff` 中命中锁定项的行（压缩与顺延都过滤），卡片「变更」下多一行「N 个锁定块未参与」，压缩落盘时再校验一次 `!locks[t.id]`
8. **逐条否决**：`顺延 / 压缩` 行右侧「否决」→ 压缩项从 `state.snapshot.tasks` 取回原 `est` 并清 `degraded / compressed`；顺延项只清可能的 `deferred` 标记；该行置灰 +「已否决」，其余行保留；op `{entity:'plan',entityId:'replan',field:'vetoed',value:{taskId}}`；全部否决后「撤销本次重排」仍可用

**验证**

- `node --check` planedit.js / plan.js / assistant.js 通过；`npm test` 50/50 通过
- 服务：`PORT=8792 HOST=127.0.0.1 node server/main.js`，1440×900 Playwright 实测（`open/resize/eval/screenshot` 同一条命令内完成）
- 截图（`.tmp/ui/`）：`sc2-0-baseline`、`sc2-0b-baseline-board`、`sc2-1-drag`、`sc2-1b-board`、`sc2-1c-chart`、`sc2-2-reject`、`sc2-2b-board`、`sc2-3-lock`、`sc2-3b-locked-board`、`sc2-4-replan-locked`、`sc2-4-replan-locked-card`、`sc2-5-veto`、`sc2-5-veto-card`、`sc2-5b-plan-items`、`sc2-5c-veto-all`、`sc2-6-mobile`、`sc2-6b-mobile-board`、`sc2-7-narrow`、`sc2-7b-narrow-board`、`sc2-8-motion-off`、`sc2-8-motion-off-board`、`sc2-9-file-board`、`sc2-9-file-card`
- 改期：t2（数学 90）日→三，`dayAssign {t2:'三'}`，三 `150→240`、日 `270→180`，toast「已移到周三 · 当日 240 / 300 分钟」，说明行「含手工改期 1 项」；`state.week` 前后完全一致（`一:105,二:90,三:150,四:45,五:105,六:150,日:270`）
- 拒绝：t2 已在周三后再拖 t3（75），预测 315 > 300 → toast「周三将达 315 分钟，超过日上限 300」，`dayAssign` 不变、t3 仍在「日」
- 锁定：t4 点击 → `locks {t4:true}`、块显示「已锁定」、toast「已锁定 · 重排不会改动」；`aria-pressed=true`
- 锁定 + 重排：卡片「延期 2 · 压缩 1 · 放弃 0 / 未来 7 天 +20% / 锁定 重排不会改动已锁定的块 · 1 个锁定块未参与」；引擎原始 diff 含 `compress:t4` 与 `defer:t4`（`.diff-line` 只有 3 行），`S.tasks` 为 `t2 90 / t3 66 / t4 45`（锁定项工时不变）
- locked 下行：包一层 `ZX.engine.replan` 捕获入参，`tasks = ["t1:-","t2:-","t3:-","t4:L"]`，每条都带 `locked` 键
- 否决：重排后点 `t4` 的压缩行「否决」→ `t4.est 45`（快照恢复）、`degraded=false`、`t3.est 66` 保留，行文本「压缩 政治 45 → 27 min · degraded 已否决」，`vetoed=[{taskId:'t4',op:'compress'}]`，`[data-act="undo"]` 未禁用；`04 计划项` 政治行变「45m · 已否决」
- 全部否决：两条压缩都否决后 `t3/t4` 均回 90/75，`vetoed.length=2`，撤销按钮仍可用，点撤销后 `t3 75 / t4 45`、`replanned=false`
- 键盘：聚焦 `[data-pe-lock="t2"]` → Enter 锁定（`aria-pressed=true`）→ 焦点仍在同一按钮 → Enter 解锁；聚焦 `[data-veto][data-vop="compress"]` → Enter 否决，焦点落到 `span.sc2-vetoed`「已否决」
- 溢出 1440×900：`html` 1440/1440、`.sc2-board` 926/926、`.sc2-days` 898/898、`.sc2-col` 120/120、`.sc2-blk` 105/105
- 溢出 390×844：`.sc2-board` / `.sc2-days` / `.sc2-col` 随外壳被压到 0～22px 宽；隐藏 `.sc2-board` 前后 `documentElement.scrollWidth` 均为 481（与外壳基线同值，C-2 未新增页面级溢出）；补测 720×900：`html` 720/720，`.sc2-days` 2 列 129.5+129.5，`.sc2-blk` 113/113
- `html[data-motion="off"]`：拖拽（t2→三）与锁定（t3）均生效，`.sc2-board` 926/926，不破版
- `file://`（`PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS=1`）：`seedSource=shared`、`online=false`、`replanned=false`；拖拽 / 锁定 / 重新安排 / 否决全通，卡片同样含「1 个锁定块未参与」，否决后 `t3 75`、`pending 4`；console 仅 `/api/health` `ERR_CONNECTION_REFUSED`
- http 下 console 0 报错

**遗留风险**

- **引擎不识别锁定**：`locked` 只作为下行字段 + 结果层过滤。引擎仍把锁定项当作可顺延 / 可压缩来算 `loadDelta` 与 `nextWeek`，因此卡片的「未来 7 天 +20%」与周图可能高估；被过滤的行不会落地，工时与落点保持原样。彻底解决需改 `shared/engine/replan.js`（本阶段禁改）
- 否决压缩后，同一任务在卡片上的「顺延」行仍是引擎给的压缩后分钟（例：「顺延 27 min 至 一」），本地 `est` 已恢复 45；逐条否决只改本行、不重算引擎输出，数字间的这一处不一致属结果层过滤的代价
- 顺延否决目前只做标记：`replanFlow` 本来就不把 defer 落到本地任务（无落点可回滚），因此「从已延期状态恢复」等价于清一个可能存在的 `deferred` 标记
- `dayAssign` 与重排叠加时会双重计数：周图 = 引擎 `nextWeek`（或 `state.week`）+ 手工 delta，两边都从 `state.week` 起算；产品化应把 `dayAssign` 并入 `replanInput.week` 或让引擎接收 locked / assign
- 迁出只从基线日「日」扣除：seed 的四项今日任务都在周日，因此硬编码 `ORIGIN='日'`；若任务分散到多日，需要给任务补 `origDay` 字段（本阶段不改 `state.js`）
- `04 计划项` 仍是静态示例，只有「政治」行与否决联动（工时 + 已否决标签），其余行不随 `state.tasks` 变化
- 改期 / 锁定只入 op 队列（`entity:'plan'` 的 `dayAssign` / `locked`），后端无对应实体，刷新回落 seed
- 触屏 DnD 未实现（按需求不做要求），移动端只能看不能拖

### Stage D · 交付

**变更文件**

- 新增 `assets/js/flows/settings.js`：IIFE 挂 `ZX.flows.settings`（别名 `ZX.settings`），可用时段 / 导出 / 删除恢复 / 字号全部在此
- 修改 `assets/js/views/me.js`：可用时段改为 `state.avail` 驱动的 7×4 `<button>` 网格（`aria-pressed`）；新增恢复 banner、上次导出行、删除全部数据危险区、字号三档
- 修改 `assets/js/main.js`：`renderMnav()`（复用 TABS 图标 / `data-act="tab"`）、`openCopilot()/closeCopilot()`、5 个 Stage D 事件委托分支、`boot()` 内 `settings.init()`
- 修改 `assets/js/util.js`：`prefs()` 增加 `font` 字段、新增 `setPref(k,v)`、`applyPrefs()` 写 `data-font`
- 修改 `index.html`：首帧脚本应用 `data-font`；`.cp-head` 增加 `.cp-close`；`.shell` 后增加 `#sdMnav` 与 `#sdFab`；引入 `flows/settings.js`
- 修改 `assets/css/app.css`：末尾 Stage D 区块（`.sd-` 前缀 + ≤860 媒体查询），未改既有桌面规则
- 修改 `docs/FRONTEND-CONTRACT.md`：本日志

**新增状态与函数**

- `ZX.state.avail`：7×4 布尔网格（周一…周日 × 08–12 / 12–18 / 18–22 / 22–24），由 `settings.ensure()` 补写（未改 `state.js`）；22–24 列恒为 `false`
- `ZX.state.exportLog = { at, rows, filename }`（契约预留字段，首次写入）
- `ZX.flows.settings`：`ensure()` `grid()` `metrics()` `summaryHtml()` `toggle(day,slot)` `bulk(kind)` `csv()` `exportCsv()` `confirmWipe()` `restoreInfo()` `restore()` `setFont(v)` `init()`
- 常量：`DAYS` / `SLOTS` / `SLOT_H = [4,6,4,0]` / `DEFAULT_GRID` / `TTL = 7 天`
- 本地键：`zx.trash = { at, snapshot:{ tasks, sessions, goal, feas, avail, week } }`、`zx.flash`（重载后提示）；清理 `zx.op_queue`；**不动** `zx.ui_prefs`
- `ZX.util.setPref('font', ''|'m'|'l')`：与既有布尔偏好合并写入同一 `zx.ui_prefs`
- 口径：`段 = 选中的时间带格数`，`可用窗口 = Σ SLOT_H`（种子 17 段 / 76 h，其中 08–12 与 18–22 各 4 h、12–18 为 6 h）。派发单写的「14 段」与种子格数不符，按 `state.avail` 实算

**交互路径**

1. **可用时段**：「我的 → 01」网格每格是原生 `<button>`，Tab 可达、Enter/Space 切换、`aria-pressed` 与 `aria-label` 同步；hover 边框提亮。22–24 列斜纹 + 右上「静默」标注，点击只提示「22:00–08:00 是静默时段，不参与排程」，状态不变
2. **批量**：`复制周一到工作日`（周二至周五 = 周一）→ `全部清空`（0 段 / 0 h）→ `恢复默认`（17 段 / 76 h）；每次写 `ZX.api.queueOp({entity:'avail', entityId:'grid', field:'toggle'|'copyMon'|'clear'|'reset'})`。改动只重建网格 + 计数，不整页 `render()`，焦点与滚动保持
3. **导出**：`数据` 面板「导出计划与记录」→ 本地生成 CSV（`\ufeff` BOM，逗号分隔，字段 `类型,任务ID,科目,标题,预估分钟,实际分钟,完成度,状态,日期`）→ `Blob` + `<a download>` 下载 `nova-export-YYYYMMDD.csv` → `toast('已导出 N 行')` → `state.exportLog` 落值 → 面板出现「上次导出：文件名 · N 行」。任务 4 行 + `sessions` 各 1 行，无后端同样可用
4. **删除全部数据**：「数据」面板底部 `.btn.danger` → `ZX.ui.confirm({danger:true})`（标题「删除全部数据？」，说明删除范围 + 7 天恢复窗口 + 不影响视觉偏好）→ 确认后写 `zx.trash`、清 `zx.op_queue`、内存置空、写 `zx.flash`、`location.reload()`（260ms）→ 首帧回到种子，`init()` 消费 flash 弹出「已删除，可在 7 天内恢复」
5. **恢复**：刷新后「我的」页顶部 banner「删除的数据还能恢复，剩 7 天」+ 按钮「恢复已删除数据（剩 7 天）」；点击写回 tasks/sessions/goal/feas/avail/week、清除 `zx.trash`、`queueOp({entity:'data',field:'restored'})`、`render()` + toast。`init()` 每次启动检查过期（>7 天）并静默删除
6. **字号**：「我的 → 03 字号」三档（标准 / 稍大 / 大）→ `html[data-font="m"|"l"]` 覆盖 `--fs-body` 14px / 15px 与 `--lh-body`；写入 `zx.ui_prefs.font`，`index.html` 首帧脚本同步应用，无闪烁
7. **移动端（≤860）**：`.rail` 隐藏、`.shell` 单列只留 `.bench`；`.sd-mnav` 固定底部 56px + `env(safe-area-inset-bottom)`，4 项复用 TABS 图标与 `data-act="tab"`，活性项顶部 2px 指示条；`.bench-body` 底部留 `calc(72px + safe-area)`；顶栏隐藏 `.ctx` / `.kbd` / `#syncPlanner` / `#syncSeq`，保留品牌与同步文案；右下 `.sd-fab`「序」→ `html.sd-cp-open` 使 `.copilot` 变 `position:fixed;inset:0;z-index:50` 全屏覆盖层，`.cp-close` 仅在移动端显示，打开锁 `html` 滚动、关闭恢复并回焦到 FAB，ESC 亦可关闭，窗口放大到 >860 自动收起
8. 桌面 >860 完全沿用原三栏：不写 `sd-cp-open` 时 `.copilot` 仍为普通栅格列，`#sdMnav` / `#sdFab` / `.cp-close` 均为 `display:none`

**验证**

- `node --check` settings.js / me.js / main.js / util.js 通过；`npm test` 50/50 通过
- 服务：`PORT=8793 HOST=127.0.0.1 node server/main.js`，Playwright 实测（同一 bash 命令内 `open` + `run-code`）
- 截图（`.tmp/ui/`）：`sd-1-me`、`sd-2-avail-edit`、`sd-3-export`、`sd-4-delete-confirm`、`sd-5-font-l`、`sd-6-mobile-today`、`sd-7-mobile-me`、`sd-7b-grid-zoom`、`sd-8-mobile-copilot`、`sd-9-mobile-sheet`、`sd-10-restore-banner`、`sd-11-restored`、`sd-12-expired`、`sd-13-motion-off-sheet`、`sd-14-motion-off-me`、`sd-15-file-me`、`sd-16-file-mobile-copilot`、`sd-17-mobile-data`、`sd-18-mobile-plan`、`sd-19-me-bottom`；CSV 样本 `sd-export.csv` / `sd-file-export.csv`
- 桌面 1440×900 三栏未变：`.rail 60` / `.copilot 392` / `.bench 988`，`scrollWidth 1440`；`.sd-mnav` `.sd-fab` `.cp-close` 计算值均为 `none`
- 断点：861 → `60px 330px 471px` 三栏；860 → `860px` 单列、`.sd-mnav` grid
- **390×844 溢出**：`documentElement.scrollWidth = 390`（今日 / 计划 / 数据 / 我的 四页均 390），全量元素扫描 `right > 390.6` 或 `left < 0` 的条目为 `[]`；`.sd-mnav` 390×56 @ y 788，`.bench-body` padding-bottom 72px
- 可用时段：种子 `17 段 / 76 h`（`presses = 17`）；点周四 08–12 与周二 12–18 → `19 段 / 86 h`；「复制周一到工作日」→ 周二至周五全 3 格，`21 段 / 98 h`；「全部清空」→ `0 段 / 0 h`；「恢复默认」→ `17 段 / 76 h`；op 队列 `["toggle","toggle","copyMon","clear","reset"]`
- 键盘：聚焦「周六 08–12」按 Enter → `aria-pressed` 由 true→false、`aria-label` 变「（不可排程）」、焦点留在原格；静默列点击 toast「22:00–08:00 是静默时段，不参与排程」且 `aria-pressed` 保持 false
- 导出：`nova-export-20261108.csv`，BOM + 表头 9 列，共 5 行数据（4 任务 + 1 session），首行 `任务,t1,英语,阅读真题 2019 Text 3–4 精读,60,60,100,已完成,2026-11-08`；`exportLog {rows:5, filename:'nova-export-20261108.csv'}`；面板文本「上次导出 nova-export-20261108.csv · 5 行」；toast「已导出 5 行」
- 删除→重载→恢复：删前 `tasks 4 / sessions 1 / 周一 [true,false,true,false]`；确认后 `zx.trash.at` 存在、快照含 `tasks 4 / sessions 1 / goal / avail / week`、`zx.op_queue = null`；重载后 `tasks 4（种子）/ sessions 0 / avail = DEFAULT_GRID`，flash toast「已删除，可在 7 天内恢复」；banner + 按钮「恢复已删除数据（剩 7 天）」；恢复后 `sessions 1`、`t3.done = true`、`周一 [true,false,true,false]`、`zx.trash = null`、banner 消失
- `zx.ui_prefs` 保留：删除前写入 `{"grid":false,...}`，重载后仍为原值且 `data-grid="off"`；`data-glow="on"` 未受影响
- 过期清理：把 `zx.trash.at` 改为 8 天前 → `restoreInfo() === null`、键被删除、「我的」页无 banner / 无恢复按钮
- 动效关闭：`data-motion="off"` 下 `.wrap > *` `animationDuration = 0s`，弹层 `opacity 1`、560×567、`.sheet-b` 溢出 0，可用时段仍可编辑（16 段 / 72 h）
- `file://`（`PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS=1`）：`seedSource=shared`、`online=false`、`settings` 已加载；时段编辑 / 导出（`nova-export-20261108.csv`，4 行）/ 390 单列（`scrollWidth 390`）/ 覆盖层 390×844 全通；console 仅 `/api` `ERR_CONNECTION_REFUSED`（离线降级预期）
- http 下 console / pageerror 均为 0

**遗留风险**

- 无后端持久化：刷新即回种子，因此「删除后重载」看到的是种子态而非严格空态；恢复写回的是内存，**再刷新一次仍回种子**，恢复不跨刷新
- `state.exportLog` 只在内存，刷新丢失；CSV 的「日期」列对任务取当天、对 session 取 `startAt` 自然日
- 「已选 N 段」按实际格数计（17），与派发单文案「14 段」不一致；若产品坚持 14，需要改口径而非改数字
- 字号只缩放 `body` 继承字号，组件内写死的 px（如 `.tk-line h3` 13.5px、KPI 24px）不随之放大，属最小实现
- 删除快照只含 tasks/sessions/goal/feas/avail/week，不含 `locks` / `dayAssign` / `replanRecord` 等 C 阶段视图状态（恢复后锁定与手工改期不还原）
- 移动端覆盖层未做焦点陷阱：抽屉（z60）盖在覆盖层（z50）之上可正常使用，关闭后回到覆盖层；ESC 在存在 `.ovl` 时只关抽屉，否则关覆盖层
- 底部导航固定 56px，横向仍为 4 页签；若后续新增页签需同步 `TABS` 与 `grid-template-columns`
- 触屏拖拽改期仍未支持（与 C-2 一致）
- `.avail` / `.avail-h` 旧样式已无元素引用，保留未删（避免改动桌面既有规则）

### 管理者补丁（四阶段验收后）

以下为管理者在逐阶段验收中直接修正的问题，均不改变执行者交付的接口与数据结构：

| 阶段 | 问题 | 修正 |
|---|---|---|
| C-1 | 记录弹层显示「1m 1 min」重复 | 改为「1 min 实测 · 已扣除暂停」 |
| C-1 | 部分完成后工时变为 45m，时段仍写 10:30–12:00 | 新增 `retime()`，按剩余工时重算为 10:30–11:15 |
| C-2 | 日程块列被最高列撑到 230px，单块列大量留白 | 列高上限 216px，标题单行省略，内容不触发列内滚动 |
| C-2 | 计划页头部静态提示「设定 → 可行性 → 拆解 → 生效」易被误读为进度 | 移除该提示，保留两个动作按钮 |
| D | 移动端浮动「序」按钮遮挡弹性位「占用」 | 改为顶栏 30px「序」入口，隐藏浮动按钮 |
| D | 22–24 静默列斜纹过重，成为页面视觉主体 | 改为 2.8% 平涂 + 弱边框 |
| D | 顶栏初始文案仍为 `planner 在线` | 统一为「日程引擎 在线」 |
| 文档 | README 仍只描述旧四视图 | 补充目标落地 / 挽救 / 执行记录 / 计划交互 / 设置 / 移动端与已知边界 |

回归：`npm test` 50/50；桌面 1440×900、移动 390×844（`scrollWidth 390`）截图均通过。

### 界面结构调整（管理者，四阶段之后）

**导航位置**：移除 60px 左侧竖栏，主导航移入顶栏（`.tnav`，图标 + 文字 + 底部活性条）。工作台因此获得 60px 额外宽度；顶栏同时移除 `seq` 等技术细节，目标 / 阶段 / `R` 值下移到工作台头部 `.ctx-bench`（≤1040px 隐藏）。移动端仍用底部导航，顶栏导航在 ≤860px 隐藏。

**信息分层**：新增 `ZX.ui.fold(key,{title,meta,body})` 与 `.fold` 组件，默认收起、点击标题行展开，展开态存入 `ZX.state.folds` 并持久化到 localStorage 的 `zx.folds`（只写展开项），跨 Tab 与刷新均保持；提供 `aria-expanded` 与 `hidden` 同步。删除全部数据不影响该偏好（与 `zx.ui_prefs` 同属视觉偏好）。

| 页面 | 首屏保留 | 默认收起 |
|---|---|---|
| 今日 | 任务卡、弹性位、今日总结 | 偏差信号 |
| 计划 | 目标、可行性 R、本周日程块（可拖拽）、7 天负载 | 阶段结构 + 计划项 |
| 数据 | 本周概览、周报与预置动作 | 达成率趋势、科目结构、归因 |
| 我的 | 可用时段、通知策略 | 数据与隐私（导出 / 删除）、显示与动效 |

**取舍**：计划页把「本周日程块」前移到负载图之前，先给可操作项、再给统计图；「我的」页把稳定低频的导出/删除/主题收进折叠区，但折叠标题保留「导出 · 删除 · 7 天恢复」提示，避免隐私能力被藏没。
