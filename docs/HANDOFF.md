# 诺瓦 Nova · 前后端协作契约（HANDOFF）

> 本文件是 `server/`（后端执行者）与 `assets/`（前端执行者）之间的**唯一接口依据**。
> 双方并行开发，不得交叉修改对方负责的目录；任何契约变更须先改本文件再改代码。

- 架构依据：`docs/ARCHITECTURE.md`（摘编自《MVP 技术架构文档》）
- 目标运行时：**Node.js 22+**，零第三方运行时依赖（仅用 `node:` 内置模块：`http`、`fs`、`path`、`url`、`crypto`、`node:test`）
- 明确不引入：数据库、Redis、ORM、Web 框架、构建工具、打包器

---

## 1. 目录所有权（硬边界）

| 路径 | 所有者 | 说明 |
|---|---|---|
| `shared/engine/*.js` | 后端执行者 | 确定性引擎（双模 UMD，前端只读引用） |
| `shared/data/*.js` | 后端执行者 | 共享种子数据（双模 UMD） |
| `server/**` | 后端执行者 | HTTP 入口、路由、内存存储 |
| `test/engine.test.js` | 后端执行者 | 引擎单测 |
| `test/api.test.js` | 后端执行者 | HTTP 冒烟 |
| `index.html` | 前端执行者 | 页面骨架（双击可运行） |
| `assets/**` | 前端执行者 | 样式与脚本 |
| `package.json` | 后端执行者 | scripts / type |
| `docs/HANDOFF.md` | 管理者 | 本文件 |
| `README.md` | 管理者 | — |

前端执行者**只读** `shared/**`，**禁止**创建或修改该目录。若发现契约与实现不符，报回管理者裁决，不得自行改写。

---

## 2. 双模模块规范（关键约束）

`shared/` 下的文件必须同时能在浏览器 `<script>` 与 Node `require()` 下工作。统一采用 UMD 形态：

```js
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.Rhythm = root.Rhythm || {}; root.Rhythm.<name> = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // ... 纯函数实现
  return { <导出的函数名> };
}));
```

**为什么不用 ESM**：前端需支持 `file://` 双击直接打开（ESM 在 `file://` 下被 CORS 拦截），Node 侧用 CommonJS `require` 最省事。

**纯函数纪律**（对应架构文档 C2 与 §6.1）：
- 不读时钟（`Date.now()` / `new Date()`）、不读随机数、不读环境变量、不做 I/O
- 相同输入必得相同输出；禁止 `Math.random()`、`Object.keys` 迭代序参与计算（需排序时显式 `.sort()`）
- 不依赖 `shared/` 之外的任何模块

---

## 3. 共享引擎 API（四个纯函数）

全部位于 `shared/engine/`，导出方式见第 2 节。

### 3.1 `shared/engine/feasibility.js` → `feasibility(input)`

对齐架构文档 §6.2。

```js
feasibility({
  weeklyH: 20,        // 每周可用小时
  weeks: 58,          // 剩余周数
  discount: 0.85,     // 折扣系数
  demand: 913         // 需求小时 D
}) -> {
  T: number,          // 总可用小时，整数
  D: number,          // 需求小时
  R: number,          // T/D，保留 2 位小数
  margin: number,     // T - D，可为负
  verdict: '充裕' | '合理' | '偏紧' | '阻断',
  threshold: { ample: 1.2, reasonable: 0.9, tight: 0.7 }
}
```

判定：`R >= 1.2` 充裕；`R >= 0.9` 合理；`R >= 0.7` 偏紧；否则阻断。
`T = round(weeklyH * weeks * discount)`。

### 3.2 `shared/engine/schedule.js` → `schedule(input)`

对齐架构文档 §6.4。

```js
schedule({
  tasks: [{ id, subject, estMin, weight, date?, startMin? }],
  slots: [{ date, startMin, durMin, available, isBuffer }],
  params: {
    slotMinutes: 30,
    bufferRatio: 0.15,
    maxContiguousMin: 150,
    deadlineMs: 200
  }
}) -> {
  blocks: [{
    id, taskId, subject, date, startMin, durMin,
    isBuffer: boolean, locked: boolean, reason: string
  }],
  unplanned: [{ taskId, reason }],
  softScore: number,
  truncated: boolean,
  version: 'planner-1.0.0',
  loadByDay: { [date]: minutes },
  bufferUsedRatio: number   // 0..1，已占弹性位 / 全部弹性位
}
```

硬约束（违反即不得排入）：
1. 不可用时段不得排入
2. 单日总时长不超日上限（默认 300 min）
3. 单科目连续不超过 `maxContiguousMin`
4. 弹性 Slot 在装箱阶段优先级最低，仅在无其他选择时使用

### 3.3 `shared/engine/replan.js` → `replan(input)`

对齐架构文档 §6.5。**四级策略有序执行，首个通过防雪崩校验的级别即停止。**

```js
replan({
  tasks: [...],       // 未完成 + 已完成（用于计算负载）；substituted / abandoned 由引擎排除待办
  week: [...],        // 未来 7 天负载 [{ date, minutes, capacity, buffer }]
  locks: { taskId: true }, // 硬约束：锁定任务不参与顺延 / 压缩 / 替代 / 放弃
  params: {
    loadGrowthCap: 0.20,     // 单次重排后未来 7 天负载增幅上限
    compressFloor: 0.60,     // 压缩工时下限（占原工时比例）
    compressedShareCap: 0.30,// 压缩项占比上限
    consecutiveNoImproveCap: 3, // 连续 3 次未改善则停止并转校准
    bufferRatio: 0.15
  },
  history: { consecutiveNoImprove: number }
}) -> {
  strategies: [{ level: 1..4, name: '顺延'|'压缩'|'替代'|'放弃', applied: boolean, reason: string }],
  diff: [{
    op: 'defer' | 'compress' | 'substitute' | 'abandon',
    taskId, subject, from: string, to: string, detail: string
  }],
  loadDelta: number,     // 未来 7 天负载变化比例（0.05 = +5%）
  accepted: boolean,     // L4 恒为 false，确认后才为 true
  needsConfirmation: boolean, // L4 放弃建议为 true
  verdict: 'ok' | 'needsConfirmation' | 'blocked',
  snapshot: { tasks, week, timestamp },   // 撤销用快照（不读时钟，时间戳由调用方注入）
  guards: {
    loadGrowthOk: boolean,
    bufferPreserved: boolean,
    consecutiveOk: boolean,
    compressedShareOk: boolean
  }
}
```

四级语义：
| 级 | 名称 | 行为 | 回退条件 |
|---|---|---|---|
| 1 | 顺延 | 按权重从高到低填入未来 7 天 capacity 内的空闲分钟；不占用弹性池，不按 task.date 改变顺序 | 7 天负载增幅 > `loadGrowthCap`，或容量装不下 |
| 2 | 压缩 | **仅容量溢出时触发**：`overflow = max(0, 待排分钟 − 剩余容量)`，按权重从低到高压缩至 `saved ≥ overflow`，下限原工时 `compressFloor`，标记 degraded | 压缩到下限仍装不下 / 压缩占比超限 / 增幅事后守卫不过 |
| 3 | 替代 | 同知识域内用高频高权重节点替换低频节点；原任务标记 `substituted` 退出待办，B 记录 `replaces` | 无可替换节点，或替换后复核不过 |
| 4 | 放弃 | 标记 abandoned 并返回 `needsConfirmation: true`，**不自动接受** | 未确认 / 全部锁定 |

**三条防雪崩断言（同时成立才算 accepted）**：
1. 未来 7 天负载增幅 ≤ `loadGrowthCap`
2. **任何情况下不得清空弹性位**（`bufferPreserved`）
3. 连续 `consecutiveNoImproveCap` 次重排未改善 → 停止并转目标校准

`replan` **不得自行读时钟**：`snapshot.timestamp` 由调用方注入。

撤销由 `shared/engine/replan.js` 另导出 `undoReplan(snapshot)`，返回还原后的 `{ tasks, week }`，**不重算**。
L4 确认由 `confirmReplan(result)` 完成：只接受 `needsConfirmation === true` 的结果，返回 `accepted === true` 的新对象（不改入参）；服务端在确认前不落库。

### 3.4 `shared/engine/attribute.js` → `attribute(input)`

对齐架构文档 §6.6。**判定顺序固定，顺序即优先级。**

```js
attribute({
  planLoadRatio: number,     // 排程总量 / 可用时长
  consecutiveZeroDays: number,
  consecutiveTimeoutCount: number,
  efficiencyRatio: number,    // 实际 / 预估
  completion: number,         // 0..1
  externalRatio: number       // '临时有事'占比
}) -> {
  type: '计划过载' | '执行中断' | '效率不足' | '外部干扰' | '无偏差',
  confidence: number,         // 0..1
  actions: [string],
  evidence: { [key]: value }
}
```

判定顺序（先计划、后用户）：
1. 计划过载：`planLoadRatio > 1.1` 或 `consecutiveTimeoutCount >= 3`
2. 执行中断：`consecutiveZeroDays >= 2`
3. 效率不足：`efficiencyRatio > 1.4` 且 `completion >= 0.6`
4. 外部干扰：`externalRatio > 0.3`
5. 都不命中 → `无偏差`

---

## 4. 共享种子数据 `shared/data/seed.js`

导出 `seed`（**不可变**，冻结或约定只读），内容对应现有 demo 的初始状态：

```js
seed = {
  user: { id: 'u_demo', name: '林清', tz: 'Asia/Shanghai', dailyCapMin: 300, weeklyH: 20 },
  goal: { id: 'g_2027', name: '2027 考研 · 计算机', target: '380 分', deadline: '2027-12-25', weeks: 58 },
  feas: { weeklyH: 20, weeks: 58, discount: 0.85, demand: 913 },
  tasks: [ { id, subject, title, est, time, weight, done, actual?, why? } ],  // 4 条，与现有 demo 一致
  buffer: { time: '20:30–21:30', free: true },
  week: [ { d: '一'..'日', segs: [[subject, min], ...], buf: 60, total, today? } ],
  weekShift: [...],       // 重排后的对照周
  notif: { daily, weekly, alert, rescue },
  weekStats: { WEEKS: [52,61,58,66,71,74,72,68], kpis: {...} }
}
```

科目色值沿用现有 CSS 变量名：`数学 → var(--m-math)`、`英语 → var(--m-en)`、`408 → var(--m-408)`、`政治 → var(--m-pol)`。

---

## 5. HTTP API 契约

基址 `http://127.0.0.1:8787`，前缀 `/api`。全部返回 JSON。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/health` | — | `{ ok: true, version, uptimeMs }` |
| GET | `/api/state` | — | `{ seed, replan, notifications }` — 前端启动时拉取的初始全量 |
| POST | `/api/feasibility` | `{ weeklyH, weeks, discount, demand }` | `feasibility()` 的返回 |
| POST | `/api/schedule` | `{ tasks, slots, params }` | `schedule()` 的返回 |
| POST | `/api/replan` | `{ tasks, week, params, history }` | `replan()` 的返回（含 snapshot） |
| POST | `/api/replan/undo` | `{ snapshot }` | `{ tasks, week }` |
| POST | `/api/attribute` | `{ ...attribute 输入 }` | `attribute()` 的返回 |
| POST | `/api/sessions` | `{ opId, taskId, durationMin, completion }` | `{ ok: true, serverSeq }` — 幂等：同 `opId` 重复提交返回同一 `serverSeq` |
| GET | `/api/sync?since=N` | query | `{ ops: [...], serverSeq, hasMore }` — seq 升序 |
| POST | `/api/sync/ops` | `{ ops: [{ opId, entity, entityId, field, value, clientTs, baseSeq }] }` | `{ accepted: [opId], serverSeq }` — 单批 ≤ 200 |
| GET | `/api/reports/weekly` | — | `{ week, achievement, effectiveHours, subjectMix, attribution, actions }` |

约定：
- HTTP 错误统一 `{ error: { code, message } }`；`code` 取架构文档附录 B 的错误码（E1001/E2001/E3001/E4001…）
- `POST /api/sessions` 与 `/api/sync/ops` 的幂等键为 `opId`，重复提交返回**首次的** `serverSeq`（架构文档 E4001 视为成功）
- 服务端**不读时钟做业务判断**；需要时间戳时由请求体传入或使用单调计数器

---

## 6. 前端 → 后端通信约定

前端 `assets/js/api.js` 暴露统一接口：

```js
ZX.api.getState()      -> Promise<state>
ZX.api.feasibility(p)  -> Promise<result>
ZX.api.replan(p)       -> Promise<result>
ZX.api.undo(snapshot)  -> Promise<{tasks, week}>
ZX.api.attribute(p)    -> Promise<result>
ZX.api.postSession(p)  -> Promise<{ok, serverSeq}>
ZX.api.syncOps(ops)    -> Promise<{accepted, serverSeq}>
ZX.api.health()        -> Promise<{ok, version}>
```

**降级要求（架构文档 C1 / C4）**：
1. 请求超时 **3000ms**，超时或网络失败 → 抛错
2. 前端在捕获错误后**必须**降级到本地引擎产物（`assets/js/rhythm.build.js`，由 `npm run build:engine` 从 `shared/engine/*` 生成），保证离线双击打开时全部功能可用
3. 本地写操作先入 `localStorage` 的 op 队列（键 `zx.op_queue`），联网成功后清 pending 标记（对应 C4 写路径顺序）
4. 顶栏同步指示器需反映三种状态：`已同步` / `离线 · 待上行 N` / `离线 · 本地计算`

---

## 7. 兼容性硬要求（前端执行者必守）

1. `index.html` 必须支持 **file:// 双击直接打开**（引擎产物随仓库提交，无需构建步骤；`npm run build:engine` 可重建，不依赖 CDN）
2. 视觉沿用现行「日漫清晰线」体系（2026-11-14 起，历经暖纸琥珀 → 纸白墨蓝 → 清晰线分格 → 日漫化四轮演进）：奶油纸白底 `#FBF7EF` + 天空蓝为唯一活性色、主容器 2px 实墨线全框、圆润 `--r:10px` 体系、等宽数字、超重黑体标题；全部视觉参数集中在 `assets/css/app.css` 顶部 token 区（设计语言以其头注释为准），新增样式必须复用变量，不得另起一套配色；IP 形象规范见 `docs/IP-DESIGN.md`
3. 现有**全部交互**必须保留：4 个 Tab（今日/计划/数据/我的）、对话意图路由、重排流程、撤销、计时器、降载采纳、预置撤销、通知开关、导出
4. 现有文案与数值（如 R 1.08、+11.2%、68%）不得擅自改动
5. 不得引入任何第三方库或 CDN 资源

---

## 8. 验收口径

- `npm test` 全绿，且引擎单测覆盖四个模块的：确定性快照断言、重排回退与撤销等价、弹性位不被清空、归因顺序不变量
- `node server/main.js` 启动后 `GET /api/health` 返回 `ok: true`
- `index.html` 双击打开：4 个 Tab 可切换、重排/撤销/计时/降载链路可用、顶栏在无后端时显示离线态
- `git log --oneline` 至少 4 条可独立回滚的提交
