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
| D | 设置与适配 | F-8.1 / F-8.3 / F-8.4 / 移动端 | 可用时段编辑与批量复制、真实导出文件、删除全部数据；≤860px 单列（导航布局后经「界面结构调整（二）」改为**所有尺寸顶端**，底部导航退役，见 §8 交接日志） |

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
- 圆润体系（`--r: 10px`）+ 2px 实墨线全框（2026-11-14 日漫清晰线起；早先「直角 2px + 1px 发丝线」已随换肤退役），数字用 `--mono` / `--display`。
- 新增选择器统一加阶段前缀：`.sa-`（A）、`.sb-`（B）、`.sc-`（C）、`.sd-`（D），避免与既有类冲突。
- 新样式**追加**到 `app.css` 末尾对应阶段区块，不重排既有规则。
- 所有动效必须可被 `html[data-motion="off"]` 关闭（唯一总闸；2026-11-15 起：用户在「我的」里对动效的显式选择优先于系统 `prefers-reduced-motion`，后者仅在从未选择时经首帧脚本折算为 `data-motion="off"`）。

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
- 验收截图存放 `.tmp/ui/`，不入库（后续轮次的对外留档截图改存 `过程产物/UI验证截图/`，见 §8 交接日志）。

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
4. 第 3 屏确认摘要 →「确认并恢复」→ 写 `tasks`（est / degraded / 被放弃项从列表移除并记入 `rescueRecord.dropped`）、`feas.weeks`、`goal.deadline` / `goal.target`、`consecutiveZeroDays = 0`、`interrupted = false` → `ZX.api.queueOp({ entity:'rescue', entityId:'w1', field:'applied', … })` → 关弹层 → `render()` → 零惩罚 banner「计划已接回…」→ `toast('已恢复')` → 对话追加一条诺瓦说明
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

- `status` 一字段两用（感受标签 / 记录类型枚举）。~~读取 `sessions` 的一方需按「`skip` / `backfill` / `done` / `partial` 或四个感受词」容错；后续若要严格枚举，应拆出 `feel` 字段~~ **已拆分（2026-11-14 精修十二）**：`status` 只承载记录类型（`done` / `partial` / `skip` / `backfill`），感受词独立存 `feel`（可空）；历史混合记录建议保留容错读取。
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

- **锁定已进入引擎**：`locks` 以 `{ taskId: true }` 作为重排入参，是硬约束——锁定任务不参与顺延装载、不被压缩 / 替代 / 放弃，`diff` 与 `nextWeek` 都不会包含它们的变更；前端不再做结果层过滤（见 `shared/engine/replan.js`）
- 否决压缩后，同一任务在卡片上的「顺延」行仍是引擎给的压缩后分钟（例：「顺延 27 min 至 一」），本地 `est` 已恢复 45；逐条否决只改本行、不重算引擎输出，数字间的这一处不一致属结果层过滤的代价
- 顺延否决目前只做标记：`replanFlow` 本来就不把 defer 落到本地任务（无落点可回滚），因此「从已延期状态恢复」等价于清一个可能存在的 `deferred` 标记
- `dayAssign` 与重排叠加时会双重计数：周图 = 引擎 `nextWeek`（或 `state.week`）+ 手工 delta，两边都从 `state.week` 起算；产品化应把 `dayAssign` 并入 `replanInput.week`（`locks` 已作为硬约束进入引擎入参）
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

### 界面结构调整（二）：对话升为主页面签

主导航改为五项：**对话 / 今日 / 计划 / 数据 / 我的**。「对话」为默认页签与首屏主页面，其余四页为菜单子页。

实现口径：聊天 DOM（`#chat`、快捷语句、输入框）保持持久节点，**不进入 `ZX.views` 重绘**——`html[data-tab]` 驱动 `.copilot` 与 `.bench` 互斥显示，切页不丢消息历史。

移动端同步调整：底部导航 5 项、对话即首页；原「对话覆盖层（`sd-cp-open`）」、顶栏关闭按钮整体退役，顶栏「序」按钮与 `/` 快捷键行为改为切换到对话页签。

**导航位置统一（其后追加）**：导航条在**所有屏幕尺寸下都位于顶端**——桌面在顶栏内（`.tnav`），≤860px 为顶栏下方的横向导航条（`#sdMnav`，DOM 移入 header 之后、静态定位随页滚动），原固定底部导航与内容区底部让位高度一并退役。

### IP 形象接入（v4 · 诺瓦九态）

助理人格「诺瓦」的 v4 形象（`assets/img/`，由 `scripts/build-mascot-v4.js` 生成）接入产品界面，**九态全部落地**：

| 态 | 素材 | 接入点 | 实现位置 |
|---|---|---|---|
| ① 待机 | `mascot-v4.svg` | 欢迎语主形象（132×116） | `main.js` `greetingHtml()` |
| ② 聆听 | `avatar-v4-listen.svg` | ~~对话栏头像（34×34）~~ **已撤除**（随对话页头部） | 素材保留供表情包 / 周边；原实现 `main.js` focus/blur 已移除 |
| ③ 计算中 | `mascot-v4-calc.svg` | 对话「处理中」等待消息（24×21） | `assistant.js` `typing()` |
| ④ 专注 | `mascot-v4-focus.svg` | 计时中的任务行（24×30） | `views/today.js` `taskRow()` |
| ⑤ 达成 | `mascot-v4-done.svg` | 任务完成消息 / 挽救完成横幅（32×28） | `flows/exec.js` `commitRecord()`、`assistant.js`、`flows/rescue.js` |
| ⑥ 挽救 | `mascot-v4-rescue.svg` | 今日页中断横幅（32×28） | `flows/rescue.js` `banner()` |
| ⑦ 提醒 | `mascot-v4-warn.svg` | 数据页「偏差归因」面板（22×19）；计划页负载预警旗标 | `views/data.js`、`views/plan.js` `loadWarnFlag()` |
| ⑧ 离线 | `avatar-v4-offline.svg` | ~~无后端时对话头像褪色~~ **已撤除**（随对话页头部） | 离线指示由顶栏 `updateSync()` 文案承担 |
| ⑨ 兜底 | `mascot-v4-unknown.svg` | 关键词未命中的兜底回复（32×28） | `assistant.js` `fallback()` |
| 应用图标 | `favicon-v4.svg` | 16×16 · 奶油纸底「脸」形（标签页 / 手机桌面） | `index.html` `link rel=icon`；`theme-color` 同为 `#FBF7EF`（随日漫化换肤同步） |

实现口径：

- 头像三态（待机 / 聆听 / 离线）互斥，**离线优先级最高**；聆听态的主机制是 CSS `:has(.composer:focus-within)` 直读焦点态，JS `focus`/`blur` 仅作兜底（headless 下 `.focus()` 会设置 `activeElement` 却不派发 focus 事件）。
- ⑦ 的负载预警旗标阈值取引擎防雪崩断言同值（未来 7 天负载增幅 ≤ 20%），**超过才亮**；归因面板的图标是常驻标识，不代表已超阈值。
- 素材只走本地文件（页面不加载第三方资源）；不改动既有布局与网格，形象以「替换既有字块 / 行内小图」的方式接入。
- 设定、几何参数与版权边界见 `docs/IP-DESIGN.md`。

### 主题换肤：纸白 + 墨蓝

视觉主题从「暖纸 + 暖琥珀金」整体换为「**纸白 + 墨蓝**」，换肤只改 `assets/css/app.css` 的 `:root` 基础值——所有衍生层（`--ac-a02`…`--ac-a72`、`--warn-a*`、`--bad-a*`、`--ok-a*`）都由 `color-mix()` 从基础色派生，自动跟随。

| 角色 | 旧 | 新 |
|---|---|---|
| 页面底 `--bg` | `#F7F2E7` 暖米黄 | `#F5F6F8` 冷静白 |
| 卡片面 `--panel` | `#FCF9F1` 暖纸白 | `#FFFFFF` 纯白 |
| 正文 `--txt` | `#241E16` 暖墨 | `#141922` 墨蓝黑 |
| 主色 `--ac` | `#8A5716` 暖琥珀金 | `#2C5A9E` 墨蓝 |
| 朱砂 `--cinnabar` | `#9C3B2B` | `#A03B2C`（语义不变，仅微调） |

配套改动：

- `index.html` 的 `<meta name="theme-color">` 同步为 `#F5F6F8`（浏览器地址栏与移动端标签栏）；
- 形象素材整套换色为墨蓝涂装（`scripts/build-mascot-v4.js` 的 `BLUE` 色板）；
- **章式头像（墨底方章）退役**，改为「脸形头像」：透明底 + 深色面罩 + 主色竖眼 + 双耳尖，与应用图标同一套语言——墨底方块在纸白主题里是一块突兀的黑砖；
- 可行性 R 刻度条 `.z1`/`.z2` 两档暖色压低饱和（`--bad-a20` / `--warn-a26`），避免整条刻度一半暖一半冷；
- 纸张纤维纹理、网格底纹、`--corner` 等硬编码暖色一并改为冷灰。

回归：`npm test` 57/57；桌面 1440×900 五页签 + 移动 390×844 截图核验，控制台无报错、移动端无横向溢出。

### 前端精修（换肤之后）

换肤后对全站做了一轮细节精修，均为可核实的缺陷修正，不改信息架构与交互流程：

| # | 问题 | 修正 |
|---|---|---|
| 1 | 移动端快捷指令横向滚动无任何提示，末项被硬裁，看起来像内容被截断 | `.chips` 加右侧渐隐遮罩（`mask-image`），按下时取消遮罩露出全部 |
| 2 | 任务行「引擎给的依据」用主色蓝，视觉上像可点链接但不可点 | 改为次级文字 `--txt2`，前面加主色方块 `▪` 表示这是引擎判断而非链接 |
| 3 | 输入框字号 13px，与正文 15px 不同节奏 | `.composer input` / `.input` 统一 14px（移动端媒体查询仍为 16px，防 iOS 聚焦缩放） |
| 4 | 任务行 hover 只有背景色变化，缺少「这行可操作」的暗示 | hover 时补左侧 3px 主色竖条（复用既有 `.task::before`） |
| 5 | 顶栏 `/` 键位提示没有说明 | 补 `title` 与 `aria-label`：按斜杠键聚焦输入框 |
| 6 | 元信息字号存在 10px，低于项目自定的可读下限 | 正文流 8 处 10px → 11px；保留图表坐标轴（10px）与移动端品牌副标（10px），CSS 注释中的声明同步改为「元信息最低 11px（图表轴与移动端品牌副标除外）」 |

核对后**未改动**的项：移动端顶栏的「打开诺瓦」入口（对话已是首页，但它是切回对话的快捷入口，保留）；顶栏两个状态点（绿=同步、蓝=引擎，在 1440 宽下不挤，≤860px 已隐藏引擎状态）；对话消息 820px 行宽（可读性设计，契约已记录）。

回归：`npm test` 57/57；桌面五页签 + 移动 390×844 截图核验；hover 竖条与键盘 `:focus-visible` 均经 CDP 实测（outline 2px 主色），控制台无报错。

### 界面精修（三）· 一致性修复与活性色统一

本轮只改 `assets/css/app.css`，不触碰 HTML / JS / 引擎。目标：清除换肤遗留的不一致，把「墨黑 = 结构线、墨蓝 = 交互活性」的语义贯穿全部控件，并收敛阴影层级。

| # | 问题 | 修正 |
|---|---|---|
| 1 | `.cp-body::-webkit-4px` / `.bench-body::-webkit-4px` 两处破损 CSS 片段（历史编辑事故，属无效规则） | 清除 |
| 2 | `--bad-a20` / `--warn-a26` 在 `:root` 未定义，R 刻度条 0–0.9 两档（z1/z2）实际渲染为透明 | 补齐两个 token（`color-mix` 派生，与既有 alpha 阶梯同构） |
| 3 | 助理回答块 `background:#FDFAF3` 暖乳色，与纸白+墨蓝主题色温冲突（换肤遗漏） | 改为 `color-mix(in srgb,var(--ac) 3%,var(--panel))` 一缕墨蓝洗底 |
| 4 | `:root` 头部注释仍描述「暖纸日色 / 深琥珀金主色」 | 更正为「冷静纸白 / 墨蓝主色」，与实际主题一致 |
| 5 | 「诺」印文字 `#F8F1E4` 暖象牙硬编码 | token 化为 `var(--ac-ink)`（朱砂底白文不变） |
| 6 | 发送按钮 / 开关 ON / 分段选中为墨黑底，与 `.btn.pri` 墨蓝底形成两套「确认态」 | 统一为墨蓝底（hover 沉入墨色、按下落朱砂的盖章语义保留） |
| 7 | 阴影散装 5 处（composer / sheet / toast / 消息块 / 卡片组），值不统一 | 新增 `--shadow-card` / `--shadow-pop` 两级 token 并全部归一；`.ecard` 纳入卡片阴影组 |
| 8 | 工作台头部左下一条无锚点的 40px 蓝短线（`.bench-head::after`），视觉噪音 | 撤除（`content:none` 并注释缘由） |
| 9 | 欢迎语主立绘块级独占一行，图文关系松散 | 立绘左置文字环绕（`float` + `.txt::after` 收拢），≤640px 缩至 96px；手册开篇的图文关系 |
| 10 | 开关旋钮直角毛边（方章语义保留但过于锐利） | `.tg::after` 加 2px 圆角 |

核对后**未改动**：朱砂「诺」印（身份锚点，保留 -2.5° 旋转）；周图科目堆叠色（降饱和语义色体系未动）；用户气泡右侧墨蓝竖线（与助理左缘墨线形成方向对偶）；KPI hover 反馈（弱背景变化，无误导性）。

**验证**：`npm test` 57/57；1440×900 与 390×844 五页签 `scrollWidth−clientWidth` 均为 0；新建目标弹层（分段选中 / 主按钮墨蓝）、我的页开关 ON 态、R 刻度条四档可辨、欢迎语环绕排版均经截图核验；重载后 error / unhandledrejection 捕获为空。`file://` 模式无资源路径改动，不受影响。

### 界面精修（四）· 纯移动端容量与阅读优化

**前提变更**：应用按**纯移动端**预设（390–430 为主视口）——≤860 是唯一优化目标，桌面 (>860) 布局仅保留可用性、不再演进。本轮只在 `app.css` 末尾追加「纯移动端优化」区块（一个 ≤860 块 + 一个 ≤640 块），不回改任何既有规则。

| 类别 | 内容 |
|---|---|
| 阅读字号 | 移动端正文基准 15px→**16px**（`:root` 覆盖，「我的→字号」三档随之上移为 16/17/18，设置语义不变）；聊天正文、任务标题显式 16px；周报三段式长文 12.5→14px、对话引擎数据卡 13px；任务元行 / 弹层提示 11.5→12px；消息 meta 12px；表单标签 11px |
| 内容容量 | 顶栏 54→50px、导航条 54→48px（+10px 内容高度）；工作台内距 20/14→14/12、区块间距 24→18、vhead 标题 28→24px；KPI 24px 字号、统计格 min-width 88→78（390 宽四格不再横向滚动）；气泡/消息间距收紧；弹层底部抽屉 `max-height` 92→94vh，页脚加 `env(safe-area-inset-bottom)` |
| 按钮分级 | 「行内次要动作」（新建目标 / 重新安排 / 进入挽救 / 批量操作等原 26px 定义被全局 44px 抬高的按钮）回归 **36px** 紧凑档；任务行动作 38px；主操作与快捷指令保持 ≥44px 触控标准 |
| 窄屏图表 | ≤640：周图 168→150px、时间带 32→30px、节律带 42→40px，图表少占一档高度 |

**验证**：`npm test` 57/57；390×844 五页签与 600×900 溢出均为 0；1440×900 桌面截图逐像素级核对与改前一致（本轮规则全部限定在 ≤860/≤640）；改后 390 一屏可容纳 3 个任务 + 弹性位（改前 2 个），计划页可行性卡提前约 90px 进入首屏，周报 14px 长文实测可读；新建目标弹层表单/页脚正常。截图见 `过程产物/UI验证截图/诺瓦 Nova设计迭代/unify/`（`m0-*` 改前、`m1-*` 改后）。

**遗留**：`file://` 双击模式本轮未单独回归（纯 CSS 追加，无资源路径变化）；「我的→字号」三档在移动端的上移（16/17/18）逻辑经 token 覆盖关系确认，未逐档实测。

### 界面精修（五）· 全宽度频谱响应修复

**目标**：窗口尺寸在 320–1920+ 全频谱内均正确响应（滚动与缩放不破版）。纯 CSS 追加「响应式补全」区块（≤1080 一块 + ≤360 两块），不动上文任何规则。

| 断点 | 问题 | 修正 |
|---|---|---|
| 861–1080 | 顶栏 7 个元素（品牌/导航/双状态/键位提示）在 <1000px 被 flex 压缩：两个状态文字**折行成两行**、导航拥挤 | ≤1080：隐藏 `#syncPlanner` 与 `.kbd`、`.sync` 禁止折行、导航按钮内距 15→9px、品牌释放 min-width、间距收紧；1024/900 目检单行整洁 |
| ≤360 | 统计条四格横滚裁切（「1 空闲」被切）；品牌副标「大学生日常助理」折行（内容区只差 1px） | 统计条改 **2×2 网格**（分隔线相应补齐）；隐藏品牌副标、主名 nowrap；375/390 宽不受影响（横滚仍可完整容纳） |
| >1080 | 无改动 | — |

**验证**：全频谱复扫——5 页签 × 10 宽度（320/390/480/720/860/900/1024/1080/1280/1920）共 50 组 `scrollWidth−clientWidth` **全部为 0**；`npm test` 57/57；目检 320 / 900 / 1024 / 1920 关键宽度截图，移动端压缩规则与桌面布局互不影响。截图见 `unify/`（`r0-*` 改前、`r1-*` 改后）。

**遗留**：861–1080 档仍为桌面式布局（大标题+表格），未做平板专属密度——若该档是真实使用场景，需单独评估；flex 收缩类挤压问题 `scrollWidth` 测不出，本轮以目检补充覆盖了 861–1024。

### 界面精修（六）· 边缘距离（窄屏 / 宽屏）

**问题**：>1080 时工作台头部信息带（目标 / R 值 · 本机计算）贴屏幕两缘，与居中的 1080 内容列错位，越宽越明显；861–1080 该信息带只剩一行元信息仍占 70px；744–860（横屏手机 / 小平板）内容从边到边拉满、行长超读；≤860 对话输入区左右 10px / 底部 8px 与正文页边 12px 不一致。纯 CSS 追加「响应式补全（二）」区块。

| 断点 | 修正 |
|---|---|
| >1080 | `.bench-head` 改为 `padding:0 calc(40px + max(0px,(100% − 1160px)/2))`，与 `.bench-body` 40px 内距 + `.wrap` 1080 居中列**逐像素对齐**（1680 实测信息带左缘 = 内容列左缘 = x300） |
| ≤1080 | `.bench-head` 整条撤除（该档上下文已在各视图内，撤除另获 +70px 内容高度；≤860 原本就隐藏） |
| ≤860 | `.wrap` 定宽 720px 居中——844 横屏 / 744–860 内容不再顶满，CJK 行长回到约 45 字；390 及以下为自然宽度不受影响 |
| ≤860 | `.cp-foot` 左右 10→12px、底部 8→12px（+safe-area），与 `.cp-body` 页边统一 |

**验证**：全频谱复扫 50 组（5 页签 × 10 宽度）溢出仍全 0；`npm test` 57/57；1680 对齐 / 900 撤带 / 844 横屏居中 / 390 页边统一（`getComputedStyle` 实测 foot=body=12px）四处截图核验，见 `unify/`（`e0-*` 改前、`e1-*` 改后）。

**遗留**：顶栏与导航条仍为全宽 chrome（贴边）——这是应用外壳的标准形态，与内容列对齐是有意区分；对话页消息在 744–860 横屏仍为全宽（未随 wrap 定宽），如需同一步到位可再收。

### 工程审视 · 五步流程（质疑要求 → 删除冗余 → 简化优化 → 加速周转 → 自动化）

**① 质疑每一项要求（处置清单）**

| 被质疑项 | 处置 |
|---|---|
| 「辉光/暖光氛围」开关 | 换肤后唯一实际效果是开关纸纤维纹理，**名实不符** → 保留功能（可访问性面板完整性），文案改为「纸面纹理」；与「日程底纹」合并属产品决策，暂不合并 |
| 「界面动效」开关描述 | 描述里的「入场级联 / 图表绘制」动画已在精修轮退役 → 文案改为实际管到的「弹层过渡 · 打字指示 · 计时刷新」 |
| 零依赖 / 经典 script / file:// 双击 / 引擎 UMD 双模 | 质疑后**保留**——离线兜底与"双击即用"是产品核心主张 |
| 861–1080 平板档沿用桌面布局 | 质疑后**维持**——该档非当前主要使用场景（上轮已记录） |
| 仓库完整性 | 发现 `scripts/`（含 build-engine 等生产脚本）、`assets/img/`、`docs/IP-DESIGN.md`、`deploy/`、`server/auth.js`、`rhythm.build.js` 均未纳入 git 跟踪，存在丢失风险 → **建议 `git add` 并提交**（涉及版本控制决策，未擅自执行） |

**② 删除冗余**

- 死 token ×9：`--acglow` `--scan-opacity` `--corner` `--bg2` `--cp-bg2` `--cp-line` `--ac-a72` `--bad-a30` `--ok-a10`（CSS 与 JS/HTML 零 var() 引用；科目色 `--m-*` 经甄别为 JS 行内引用，保留并让审计脚本纳入 JS 引用源以消除误报）
- 死 keyframes ×6 及关联规则：`pulse` `ring`（状态点呼吸灯退役）、`msgIn` `lineIn`（消息级联退役，连带 3 条无效 `nth-child` delay）、`riseIn`（视图级联退役）、`draw`（图表绘制退役，连带 reduced-motion 内 `.line` 兜底）；删除恒无效果的 `.app::after`（box-shadow:none 残骸）
- 死类：`.sig` / `.sig-row`（偏差信号视图已删，CSS 残留）
- 死文件 ×9（**已移入回收站**）：`scripts/_t.js`（测试垃圾）、`design-preview/` 根目录 8 个换肤对比稿（app.css.orig / compare*.html / preview-a.* / preview-d.*）；`design-preview/mascot/` 与 `preview-v4.html` 因 IP-DESIGN.md 点名引用**保留**

**③ 简化优化**

- `index.html` viewport 补 `viewport-fit=cover`——此前 `env(safe-area-inset-*)` 在刘海屏全为 0，底部页脚避让形同虚设
- CSS 头注释与设置面板文案同步（见①）

**④ 加速周转**

- 新增 `npm run dev` = `node --watch server/main.js`（Node 22 内置 watch，零依赖热重启；冒烟通过）
- 核实 `pretest` 引擎产物同步已存在，保留

**⑤ 自动化**

- 新增 `scripts/css-audit.mjs` + `npm run audit`（零依赖）：括号平衡 / var() 未定义 token / 死 token / `:root` 外硬编码色（换肤残留防线）/ 破损选择器（`::-webkit-4px` 事故形态）/ 死类候选；有 error 退码 1，可挂 CI。当前 **0 error 0 warn**
- 首轮运行即复捕 6 个死 token（人工审计遗漏），验证了脚本价值

**验证**：`npm run audit` 0 error 0 warn；`npm test` 57/57；`node --check` me.js；1440 计划页 + 390 设置面板回归截图与改前一致（删除均为死代码）；`npm run dev` 冒烟 8799 端口 health OK。

### 视觉改版：清晰线分格（Ligne claire · 2026-11-14）

**目标**：在保留产品识别与操作流程的前提下，把视觉语言整体切换为「清晰线分格」——界面是漫画分镜画框，诺瓦与内容住在格子里。追求前卫审美、强表现力与锋利边界感；沿用「替换字块」纪律，只改 `assets/css/app.css`，不触碰 HTML / JS / 引擎。

**设计语言要点**（token 层一次翻转，全站跟随）：

| 维度 | 旧（冷静治学伙伴） | 新（清晰线分格） |
|---|---|---|
| 边界线 | 1px 发丝线 + 2px 上规则 | 主容器 **2px 实墨线全框**（`border:2px solid var(--txt)`），行分隔实线（`--line`/`--line2` = `#141922`，卡内行线 42% 墨） |
| 形状 | 轻圆角 `--r:8px` | **全直角** `--r:0`（气泡亦直角，尾巴承担方向语义） |
| 阴影 | 两级弥散阴影 | **阴影退场**（`--shadow-card/pop: none`），弹层靠 2px 墨框 + 遮罩压暗分层 |
| 标题字体 | 旧式衬线（`--display` 宋体系） | **超重黑体**（`--display` 换黑体族，h1/brand/弹层标题 weight 800） |
| 对话 | 回答块 = 左缘墨线洗色底 | **对话即漫画**：助理 = 纸白 2px 墨框气泡 + 上缘尾巴（`::before/::after` 双三角）；用户 = 墨蓝平涂反白 + 镜像尾巴 + `fit-content` 收缩 |
| 导航 | 文字 + 下缘指示条 | 当前页签 = **墨蓝平涂块反白**（分镜章节标签） |
| 强调 | 墨蓝 alpha 洗色 | 新增**荧光笔** `--hlbg`（划重点底色）：今日/挽救 banner 底、快捷指令与选项卡 hover；不承载语义，朱砂纪律不变 |
| 表格/名牌 | 表头纸灰、科目标签描边 | 任务表头**墨蓝平涂反白**；科目标签平涂色块 + 墨框 |

**配套修正**：`--ac-a18` 死 token 清除（banner/fold 弃用）；精修轮对气泡的阴影/右边线覆盖移除；`.sa-path` / `.sb-opt` / `.sc-opt` 弱左条改为黑框 + 荧光笔 hover + 墨蓝 on 态；`.fold.open` 边框转墨蓝；顶栏底线恢复 2px；底纹透明度 .4→.28；SVG 图标描边 1.35→1.6。

**未改动**：诺瓦九态素材与生成器（IP 纪律：机身不加粗勾线，柔和淡影与硬边分格形成「画框里的诺瓦」叙事）；R 刻度条/周图/时间带的语义色体系；全部 `data-act`、渲染接口与业务流程。

**验证**：`npm test` 57/57；`npm run audit` 0 error 0 warn；桌面 1280×800 五页签 + 新建目标弹层 + 390×844 移动端（对话/今日）截图核验，`scrollWidth−clientWidth` 均为 0；`file://` 双击模式 headless 截图正常（素材、气泡、输入台完整）。截图见 `过程产物/UI验证截图/诺瓦 Nova设计迭代/清晰线分格/`。

**遗留**：荧光笔目前仅出现在 hover 与 banner 底，尚无「划重点标记关键数字」的静态用法（留作后续增强）；弹层进出场动效仍为淡入位移，未做分格式硬切（可探讨）。

### 视觉微调：日漫化（2026-11-14 · 同日第二轮）

**目标**：在清晰线骨架上把语言整体推向二次元日漫——描边与边界纪律不变，形状与色板圆润化、暖化。仍只改 `assets/css/app.css` + `index.html` 的 `theme-color` 一行，不触碰业务。

| 维度 | 清晰线分格（同日上午） | 日漫清晰线（本轮） |
|---|---|---|
| 形状 | 全直角 `--r:0` | **圆润体系** `--r:10px` / `--r-xs:4px`；气泡 16px 云朵圆角；开关药丸 11px + 圆点旋钮 |
| 气泡尾巴 | 直角双三角 | **圆月牙尾巴**：黑圆负 z 沉到气泡背景之下只露顶缘 + 同心圆内芯（用户侧内芯天空蓝） |
| 色板 | 冷灰纸白 `#F5F6F8` + 墨蓝 `#2C5A9E` | **奶油漫画纸** `#FBF7EF`（panel2 随暖 `#F7F4EC`）+ **天空蓝** `#3161C1`（白字 4.9:1）；新增**樱花粉** `--pink` 仅做用户侧说话人圆点（「你 = 粉、诺瓦 = 蓝」） |
| 底纹 | 方格底纹 | **网点 halftone**（radial-gradient 圆点平铺，`data-grid` 开关语义不变） |
| 装饰 | 无 | banner 右上角 **repeating-conic 集中线**（透明度 .09，pointer-events:none，banner 加 overflow:hidden） |
| 标记 | 方点体系（状态点/步骤点/eyebrow 方块） | **圆点体系**（`.dot`、`.step .sk`、`.sc-dot`、`.sd-cell` 选中点、`.wk.on` 指示点、说话人圆点全部 50% 圆化） |
| 手感 | hover 平移 1px | **果冻手感**：`.btn:active` 下压回弹 `translateY(1px) scale(.98)`；滚动条圆角化 |

**配套修正**：`theme-color` 同步 `#FBF7EF`；死 token 清理——`--ac-a18`（上轮已清）之外本轮新增 `--pinkbg` 定义即删、`--pink` 落地为用户说话人圆点后才过审计；顶栏状态点由方章点改圆点（IP-DESIGN 同步）。

**未改动**：朱砂纪律（仅「正在进行」与「诺」印）；诺瓦九态素材；荧光笔语义边界；全部业务接口。

**验证**：`npm test` 57/57；`npm run audit` 0 error 0 warn；桌面 1280 对话/今日/计划/我的 + 390×844 移动对话页截图核验（云朵尾巴、药丸开关、圆点标记、集中线均确认），移动端 `scrollWidth−clientWidth` 为 0。

**遗留**：日漫粉目前仅一处（用户说话人圆点），如需扩展（收藏、亲切提示底色）须先定义语义边界；圆尾巴依赖负 z-index 与 stacking context 的绘制顺序，已在当前 DOM 层级（`.copilot` isolation）下验证，后续若重排对话 DOM 需复查。

### IP 形象优化：协调 / 自然 / 灵动（2026-11-14 · 第三轮）

只改 `scripts/build-mascot-v4.js` + 重新生成 `assets/img/*` + `app.css` 末尾「诺瓦灵动」区块 + `docs/IP-DESIGN.md` 同步。不改造型语言（轮廓类别、面罩、朱砂印、双涂装纪律全部保留），不触碰 HTML / JS / 引擎。

**协调（几何与色板统一）**

| # | 问题 | 修正 |
|---|---|---|
| 1 | 耳根簇（根段 + 透镜 + 关节盘）悬空在球体轮廓外上方，左耳根 (88,92) 距球面边缘约 15px，读感「耳朵漂浮脱节」 | 耳根扎入球体轮廓内：左根 (88,92)→(98,108)、右根 (126,92)→(128,100)，光柱自球面探出；倾角左约 48° / 右约 16°（自竖直） |
| 2 | 左耳透镜长轴垂直于杆轴（rotate −45°，杆向 48°），读感像横在杆上的「结」；右耳透镜偏离杆轴 6.9px | 透镜中心放到各自杆轴上、长轴沿杆方向：左 (91,100.2) rotate 48°、右 (131.4,88.2) rotate −74° |
| 3 | 关节盘位置与球面脱接（左盘 (89,95) 悬空 15px） | 关节盘落在光柱穿出球面的交点：左 (95.5,105.5) r5.5、右 (129.5,95.5) r5，均贴球面 |
| 4 | 旧主题色残留：classic 印 `#9C3B2B`、专注态耳/环 `#9C3B2B` 系、提醒态耳旧主题墨蓝 `rgba(44,90,158)`（= 旧 `#2C5A9E`）、闪线旧暖琥珀 `#F1C97F`、favicon 底旧冷白 `#F5F6F8` | 全部统一进现行色板：朱砂 `#A03B2C`、提醒耳现行深墨蓝 `#274B94` 系、闪线警示金 `#B98A3C`（`--warn` 同族亮阶）、favicon 底奶油纸 `#FBF7EF`（与 theme-color 同源） |
| 5 | warn / calc 双眼等高，与待机态「右眼略高」的脸部语言不一致 | 两态右眼 / 右列抬高 2px |

**自然（造型细节）**

| # | 问题 | 修正 |
|---|---|---|
| 6 | 耳杆三段透明度 .94/.40/.18 落差过大，根段→中段明度跳变读作「断成两截」 | 阶梯放缓为 .94/.55/.28（warn 态同步 .58/.30/.96），由实到淡的读感保留 |
| 7 | 飞溅碎片倾角随机（−8°~−44° 散布），小尺寸读作污点 | 按漂离方向分组统一：左下组 −18°~−26°、右侧组 +24°~+28°，读作悬浮气流 |

**灵动（产品侧动效，全部受既有总闸约束）**

- 新增 keyframes `novaFloat`（translateY 0→−3px）/ `novaBreathe`（scale 1→1.06），只作用于 img 元素：欢迎立绘 `.msg-mascot`（3.6s 漂浮）、计算中 `.msg-state.state-calc`（2.6s 漂浮）、计时专注 `.tk-mascot`（2.4s 呼吸）。
- 素材保持静态：SVG 经 `<img>` 引用读不到 `data-motion`，SVG 内不做动画；`html[data-motion="off"]` 与 `prefers-reduced-motion:reduce` 的既有 `animation:none!important` 总闸自动覆盖本区块，动效可关。
- 无发光、无渐变，情绪上限仍为「平静—关切—欣喜」。

**验证**：`node --check` 生成器通过；素材重新生成后与磁盘同步（`git status` 干净基线）；特写对比（240px 与 520px 渲染）确认耳根贴球、透镜沿杆、三段过渡平滑；`npm test` 57/57；`npm run audit` 0 error 0 warn。**遗留**：荧光笔 / 圆尾巴等既有遗留项不变；预览页 `preview-v4.html` 随素材自动更新，未单独改版。

### 查漏补缺（线A · 2026-11-14 同日）

清理契约遗留与视觉盘点发现的缺口；改动 `assets/js/main.js`、`assets/js/assistant.js`、`assets/js/views/data.js`、`app.css` 末尾「查漏补缺」区块、三份文档。

| # | 类别 | 问题 | 修正 |
|---|---|---|---|
| 1 | 荧光笔静态用法（清晰线遗留） | `--hlbg` 只出现在 hover 与 banner 底，无「划重点」静态用法 | 周报结论行三个关键数字（达成率 / 有效学习 / 缺口小时）加 `.hl` 荧光笔底；CSS 新增 `.hl`（平涂 + `box-decoration-break:clone`），仅装饰、不承载语义 |
| 2 | 跳过任务口径（C-1 遗留收尾） | 今日页 KPI 已过滤 skipped，但对话流四处文案仍用未过滤的 `remainMin()/plannedMin()`：开场问候「还剩 X 项 Y」、重排步骤 0、降载建议「今日计划 X→Y」、今日安排「还剩 X 项共 Y」——跳过越多数字越矛盾，违反零惩罚 | 四处统一改走 `ZX.flows.exec.metrics()`（与今日页 KPI 同源，过滤 skipped），flows 未加载时退回原派生函数；`todayFlow` 行列表同步排除 skipped；`state.js` 派生函数语义不动（沿用执行者「视图层过滤」的决策） |
| 3 | 744–860 横屏对话行长（精修六遗留） | 对话消息列随 `.cp-body` 全宽拉满，CJK 行长超读 | ≤860 时 `.cp-body .msg` 收拢为 720px 居中，与内容页 `.wrap` 同列宽 |
| 4 | 文档漂移 | `IP-DESIGN.md` 仍记载已删除的 `--bg2` token 与「输入聚焦头像」等已撤除接入；`FRONTEND-CONTRACT.md` IP 接入表 favicon 行 `theme-color` 停在三代前的 `#F7F2E7`；`HANDOFF.md` §7.2 视觉条款仍写「深色 HUD + 电光绿」 | 三处全部对齐现行状态（日漫清晰线 + 诺瓦 v4 九态现行接入面），HANDOFF 视觉条款改为引用 `app.css` 头注释与 `IP-DESIGN.md` |

**验证**：`node --check` 三个 JS 通过；`npm test` 57/57；`npm run audit` 0 error 0 warn；五页签 ×（1280/390）截图无溢出、console 干净。**遗留**：`status` 一字段两用、新目标 / 补录不持久化（属后端范围）、861–1080 平板档等既有遗留项不变。

### 界面精修（七）· 消息组件与提示层（2026-11-14 第三轮 · 用户反馈驱动）

用户反馈「组件层级显示有问题」（气泡月牙尾巴顶进 meta 行）引发的组件家族排查与修复：

| # | 问题 | 修正 |
|---|---|---|
| 1 | 气泡圆月牙尾巴露出 11px > meta 下边距 8px，顶进「诺瓦/你 + 时间」字幕栏文字区；负 z 又画在文字层之下，观感为层级压线 | 黑圆/内圆 18/12→16/10px，露出收到 6px（环宽 3px 不变），月牙完整落在 meta 与气泡之间的空白带；两侧镜像同步 |
| 2 | 用户气泡从未真正右对齐：`.msg.u` 是整行 block（width auto），其 `margin-left:auto` 不生效，`.txt` fit-content 又贴左 | `.msg.u .txt` 补 `margin-left:auto`，气泡与尾巴一起贴右，meta 行为不变 |
| 3 | toast 落在对话页输入台内部（bottom:32px 处于 cp-foot 高度带内），白底相融读感像被盖住 | `ui.js toast()` 在 cp-foot 可见时把 bottom 抬到输入台上沿（offsetHeight+24），其余页签维持 32px 原位 |

**排查过的其余组件（未见问题）**：今日骨架时间轴与「现在」标记、日程块 board（含锁定钮）、可行性 R 刻度条 marker、周报 `.hl`、可用时段格、新建目标弹层、confirm 遮罩、挽救 banner（mascot + 集中线 + 荧光笔底）、移动端 board/timeline。

**验证**：`node --check` ui.js；五页签×(1280/390) 溢出 0、console 干净；`npm run audit` 0 error；toast 两页签落点实测（chat 182px / today 默认 32px）；尾巴 3x 放大截图核验。

### 界面精修（八）· 边距 / 尺寸 / 叠层专项（2026-11-14 第四轮）

按「边距、大小、叠层」三类对全站再排查一轮（CSS 全文通读 + 五页签×(1280/390) 截图与 DOM 实测）：

| # | 类别 | 问题 | 修正 |
|---|---|---|---|
| 1 | 尺寸·文案 | 「我的 → 显示与动效」字号行写「正文字号 · 13 / 14 / 15 px」，与实现不符（桌面 `--fs-body` 15/16/17，移动整体 +1） | 文案改为「正文字号 · 15 / 16 / 17 px」（`views/me.js`） |
| 2 | 叠层·裁剪 | ≤860 任务行「进行中」朱砂竖条 `left:-8px`，落在 `.ttable` overflow:hidden 裁剪区外（实测整条不可见，进行中只剩 6% 底色） | 移动端竖条改 `left:0`，任务行补左内距 10px（`padding:9px 2px 10px 10px`），与桌面「条 3px + 内容 12px」同构 |
| 3 | 尺寸·溢出 | `.sc2-col` 设 `max-height:216px` 但无 overflow，日程板列内容超出列框继续画到框外——实测周日列 3 块即溢出 16px，压住列底线与板底 | 去掉 max-height；同排各列由 grid 拉伸保持齐平，内容再多也完整可见（实测列高 238px、块底距框 7px） |
| 4 | 叠层·叠压 | 「诺」印（bottom:7px + 高 14px，顶部伸入内容区 6px）与以 ecard / steps 收尾的消息叠压 2–6px：重排卡片、降载建议、重排步骤均命中 | seal 由 say() 追加、恒为 `.txt` 末子元素，故末位内容块是倒数第二：`.msg.a .txt > .ecard:nth-last-child(2), .msg.a .txt > .steps:nth-last-child(2)` 补 `margin-bottom:8px`（实测印顶在卡片底边下方 2px） |

**排查过的其余组件（未见问题）**：气泡月牙尾巴与 meta 带宽（精修七后维持）、ecard/erow/diff-line 行距、可行性 R 刻度条与 marker 标签、学期节律带「当前」角标、周图 `.wk.on` 圆点（列底下 11px，与图例行距足够）、时间轴 `.tl-now` 标签、可用时段格与静默列、sheet/sheet-f/底部抽屉与安全区、toast 两页签落点、桌面 tnav（按钮比顶栏内容区高 2px 延至边框上，描边即状态，无视觉影响）。

**记录不改**：seed.js 周数据 `today:true` 硬编码在「日」列而演示时钟为周六（数据层，非布局）；`.tl-now` 时间标签在 22:00+ 边缘时段可能与右端「07:00 – 23:00」贴近（小概率、瞬时）。

**验证**：`node --check` me.js；`npm run audit` 0 error；`npm test` 57/57；五页签×1280 溢出 0 ×390 稳态溢出 0、error 监听 0；竖条特写、日程板列高、印-卡片净距均为 DOM 实测。**遗留**：861–1080 平板档、`.tl-now` 边缘时段标签、status 一字段两用等既有项不变。

### 界面精修（九）· 对话贴底与演示口径（2026-11-14 第五轮）

| # | 改进 | 实现 |
|---|---|---|
| 1 | 对话区消息贴底：内容不足一屏时欢迎语从顶排、输入台上方整屏留白，视觉重心失衡 | `.cp-body` 改 flex column，首条消息 `margin-top:auto` 吃掉上方自由空间；内容超一屏时 auto 归零、滚动行为不变（不用 justify-content:flex-end，避免顶端溢出不可达）。实测 `pinnedToBottom:true` |
| 2 | 周图「今天」高亮与演示日期矛盾：seed 的 `today:true` 硬编码在「日」列，日期眉标却是真实时钟（如 11.14 周六） | 新增 `U.todayDow()`（真实时钟 → '一'..'日'）；`weekChartData()` 出口统一按星期打标覆盖，今日页 `todayBufMin()` 同源匹配。seed 旗标保留（`engine.test.js:589` 有断言，属示例数据）。实测高亮列=「六」与眉标一致 |
| 3 | 「现在 HH:MM」标签贴边风险：居中标签需两侧各约 30px，now 落 <7% / >93% 时与帽注两端文字共处 0 间距带、且会出面板框 | 贴边时段只保留线与菱形标记、隐藏时刻文字（与「仅落在带内时显示」同一纪律，时刻可从下方刻度读出）。模拟 07:44（pos 5.2%）实测 `hasLabel:false`、线保留；正常时段（15:50）标签照常 |
| 4 | 移动端 goal 弹层「当前基础」四键 seg 折成 3+1，末项孤行拉满 | 容器加 `sa-seg-4` 修饰类，≤640 收 2×2 显式网格（右列恢复左线、第二行加上线，无重线）；三键的「目标类型」不受影响 |
| 5 | 移动端拆解草案「添加计划项」行自动放置留下两个空半列 | ≤640 改显式网格：[科目\|工时] / [标题满行] / [按钮满行] |
| 6 | 字号偏好不覆盖对话正文：`.txt` 与 `.tt-line h3` 写死 px，「稍大/大」只影响部分元素，与「正文字号」承诺不符（上表 #4 遗留项的口径决策：跟随 token） | 两处改走 `var(--fs-body)`，删除移动端 16px 死覆盖；实测三档 × 双宽度全部联动（桌面 15/16/17、移动 16/17/18），大字档五页签×双宽度溢出 0；元信息/次级信息仍固定不随档 |

**验证**：`node --check` ×4；`npm run audit` 0 error；`npm test` 57/57；五页签×(1280/390) 溢出 0；goal 三步弹层桌面 + 移动端逐屏截图核验。**遗留**：弹层分格硬切动效、樱花粉语义扩展——需产品/设计决策后再动。

### 界面精修（十）· 设计决策收口（2026-11-14 第六轮）

两项遗留设计决策完成分析与落地：

**1. 弹层动效 → 分格硬切（采纳「量化入场」方案）**

| 项 | 决策 |
|---|---|
| 入场 | 遮罩瞬暗（删 `ovlIn` 淡入）；sheet 两格落格：`sheetIn .14s steps(2, jump-none) both`，keyframes 只保留 `translateY(12px)→0`、全程不透明——漫画有限动画（2 コマ）读感，2px 墨框让「盖落」成立，替代通用缓动滑入 |
| 出场 | 维持 `.16s` 短淡出：`close()` 以 `setTimeout(170ms)` 移除节点（不依赖 animationend），纯硬切出场会出现 170ms 僵滞，故不动 |
| 家族边界 | 硬切为**弹层家族专属签名**；toast/fold/chips/行内 hover 不动，避免全站抖动 |
| 验证 | 定格实测：25% → translateY 12px / opacity 1（悬起格），100% → 0（落定格），全程无淡入；`close()` 移除与滚动恢复正常；`data-motion="off"` 与 `prefers-reduced-motion` 两道总闸覆盖有效（闸下动画时长 0 = 瞬切，即无动效偏好下的正确形态） |

**2. 樱花粉语义边界 → 关闭扩展，升格为纪律**

粉的全部扩展候选（用户气泡改粉底 / 尾巴·文本色用粉 / 输入台 caret·聚焦改粉 / 移动端诺瓦入口改粉）逐一败于对比度（粉作面/文本 2.6:1）或色板纪律（天空蓝单一活性色、focus 全局蓝、助手侧必须蓝），**无一成立——这本身就是结论**：对位靠「频率 × 位置」（meta 圆点出现在每条用户消息开头）而非「面积」。据此写入纪律：

> **樱花粉 = 用户侧身份标记，仅 `.msg.u .meta b::before` 圆点一处；不进底色、不进文本色、不进状态系统。** 若未来确需扩展，唯一合规路径是引入 ≥3:1 深粉图形 token 且仅限非文本图形。

**遗留清单相应收窄**：弹层动效、樱花粉两项关闭；861–1080 平板档、status 一字段两用、新目标/补录持久化（后端范围）维持。

### 界面精修（十一）· 响应式全谱核验（2026-11-14 第七轮）

补齐此前沿未覆盖的宽度档位：861–1080 平板档（1024/900 实测）、≤360 超窄（360）、1920 宽屏，另排查未截图过的流程浮层。

| 项 | 结果 |
|---|---|
| 861–1080 对话列（平板档核心缺口，唯一修复项） | 消息列沿用桌面 820px 随宽拉满，900 视口 CJK 行长约 55 字超读 → 新增 `@media (861–1080)`：气泡列与输入台列**同步**收拢 720px 居中（只收气泡会与输入台两处边缘错位 66px）；实测 900 档气泡/输入台左缘精确对齐、行长回到可读区间 |
| 861–1080 其余 | 顶栏减负（引擎状态/键位提示已藏）、vstats 横排、feas 单列、日程板 4 列、bench-head 隐藏均正常，五页签溢出 0 |
| ≤360 超窄 | vstats 2×2、brand-en 隐藏、时间轴块化（文字退色块）、任务卡堆叠正常，溢出 0 |
| 1920 宽屏 | wrap 1080 居中、bench-head `padding:0 calc(40px + max(0px,(100%−1160px)/2))` 与内容列精确对齐（实测左缘 420px）、周日列三块完整（精修八去上限后），溢出 0 |
| 挽救弹层三步 | 缺口四宫格 / 三选一卡片（on 态蓝框+已选择标记+方向键导航）/ 确认摘要六行表，均无叠压 |
| 挽救入口 banner | 构造中断态实测：荧光黄底 + rescue mascot + 集中线扫过「进入挽救」按钮右上角——集中线压按钮为设计意图（视线引导），非叠层缺陷 |
| 跳过弹层 | 原因 radio 组（sc-dot 单选）+ 零惩罚说明正常 |
| 危险 confirm | 「删除全部数据」真实 danger 红样式（`o.danger` 生效），取消不执行；7 天恢复期说明在位 |
| 附带发现 | 时间轴「现在」标记在 21:58 落 93.5%（>93% 贴边区）——精修九的标签保护实战生效，时刻文字隐藏、线保留 |

**验证**：`npm run audit` 0 error；`npm test` 57/57；六档（360/900/1024/1280/1920/390）× 五页签溢出全 0；对话列宽三段口径（820 / 720 / 全宽）各档实测正确；挽救 banner 截图核验。**遗留**：status 一字段两用、新目标/补录持久化（后端范围）维持；861–1080 对话列宽已闭合，「平板档沿用桌面布局」遗留项关闭。

### 界面精修（十二）· 本地持久化与 feel 拆分（2026-11-14 第八轮 · 后端遗留收口）

两项后端范围遗留落地：

**1. 新目标 / 记录（含跳过、补录）跨刷新持久化——本地优先 overlay**

| 项 | 实现 |
|---|---|
| 投影 | `zx.overlay`（localStorage）：tasks / sessions / goal / feas / week / weekShift——与「删除恢复」快照同形状 |
| 写入 | **渲染即持久化**：`ZX.render` 末尾统一 `saveOverlay()`（任何状态变更后必走渲染，避免逐个改动点补写、也天然覆盖未来的变更入口） |
| 恢复 | state.js 初始化时 `applyOverlay()`；后端状态合并（probeBackend → adoptServerState）后再覆写一次——本地优先：未上行的本地数据不被服务端旧种子覆盖 |
| 清除 | `删除全部数据`（settings.wipe）显式 `dropOverlay()`，防重载复活已删数据；恢复流程经渲染自动落盘 |
| 验证 | 部分完成（feel=吃力）/ 跳过 / 补录三类记录 + 新目标改名跨刷新全部存活；顶栏目标名同步；补录口径（当日分钟）正确；测试痕迹已清理回种子态 |

**2. `status` 一字段两用 → 拆出 `feel` 字段**

`status` 只承载记录类型枚举（`done` / `partial` / `skip` / `backfill`，由完成度推导或固定值）；感受词（顺利 / 吃力 / 分心 / 疲惫，记录弹层可选）独立存 `feel`（可空）。写入方：exec.record / applyRecord / commitRecord；跳过与补录固定类型、feel 为空。读取方按 §269 容错口径兼容历史混合记录。

**3. 后端 session 回读闭合**

store 的 `applyToState` session 分支改为**直接落完整会话对象**（含 status/feel）——`GET /api/state` 的 `seed.sessions` 即回读接口，不再是无字段语义的包装结构。新增 API 测试：sync 上行 session op → `/api/state` 回读校验完整对象与字段。

**验证**：`node --check` ×5；`npm test` 58/58（新增回读测试）；audit 0 error；浏览器端到端：三类记录 + 新目标改名 → 刷新存活 → 清理回种子态。**遗留清单清空（前端侧全部关闭）**：仅剩「新目标 / 记录的**服务端跨设备**同步与 store 磁盘持久化」为后续可选项——本地 overlay 已保证单机刷新存活，服务端仍是会话级内存存储（重启回落）。
