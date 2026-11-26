'use strict';
/* 诺瓦 Nova · LLM 理解与分析层
 *
 * 定位（架构裁决 2026-11-22）：LLM 只承担两件事——
 *   1. 多轮澄清（clarifyTurn）：从模糊诉求到结构化需求画像，逐层追问；
 *   2. 分析建议（analyzeProfile）：画像 → 科目拆解 / 周投入建议 / 风险提示。
 * 输出一律为结构化 JSON 并经 schema 归一；R 值判定与排程仍由 shared/engine/
 * 纯函数执行（可解释可复现不变，LLM 不产出任何排程块）。
 *
 * 接入：OpenAI 兼容协议（POST {base}/chat/completions），服务商三要素走环境
 * 变量（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL），key 只在服务端进程内，
 * 不入仓库不进前端。零第三方依赖：Node 22+ 全局 fetch + AbortController。
 * 未配置 / 调用失败 / 输出非法时抛 ApiError（E5010 / E5011 / E5012），
 * 前端按码降级到现有关键词 + 表单流程。
 */

const { ApiError } = require('./api/errors.js');

/* 环境变量在调用时读取（而非模块加载时冻结），便于测试注入与运行期变更 */
function envConfig() {
  return {
    baseUrl: String(process.env.LLM_BASE_URL || '').trim().replace(/\/+$/, ''),
    apiKey: String(process.env.LLM_API_KEY || '').trim(),
    model: String(process.env.LLM_MODEL || '').trim(),
    timeoutMs: Math.min(120000, Math.max(3000, parseInt(process.env.LLM_TIMEOUT_MS, 10) || 30000))
  };
}

function configured() {
  const c = envConfig();
  return !!(c.baseUrl && c.apiKey && c.model);
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = (() => {
  const value = Number(process.env.NOVA_LLM_MAX_REQUEST_BYTES || 256 * 1024);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('NOVA_LLM_MAX_REQUEST_BYTES 必须是正安全整数');
  return value;
})();

async function readJsonLimited(res) {
  if (!res.body || typeof res.body.getReader !== 'function') return res.json();
  const declared = Number(res.headers && res.headers.get ? res.headers.get('content-length') : 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    try { await res.body.cancel(); } catch (e) { /* ignore cancellation failure */ }
    throw new ApiError('E5012', 'LLM 响应超过 1 MiB 上限');
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch (e) { /* ignore cancellation failure */ }
        throw new ApiError('E5012', 'LLM 响应超过 1 MiB 上限');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
  try { return JSON.parse(text); } catch (e) { throw new ApiError('E5012', 'LLM 响应不是合法 JSON'); }
}
/* ── OpenAI 兼容 chat/completions 客户端 ──────────────────────────────
   通过 globalThis.fetch 调用，测试可整桩替换 */
async function chat(messages, opts) {
  const o = opts || {};
  const c = envConfig();
  if (!c.baseUrl || !c.apiKey || !c.model) {
    return Promise.reject(new ApiError('E5010', 'LLM 服务未配置：请在环境变量中设置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL'));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), c.timeoutMs);
  if (Buffer.byteLength(JSON.stringify(messages), 'utf8') > MAX_REQUEST_BYTES) {
    clearTimeout(timer);
    throw new ApiError('E4002', 'LLM 请求超过 ' + MAX_REQUEST_BYTES + ' 字节上限');
  }
  try {
    const res = await fetch(c.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + c.apiKey
      },
      body: JSON.stringify({
        model: c.model,
        messages: messages,
        temperature: typeof o.temperature === 'number' ? o.temperature : 0.3,
        stream: false
      }),
      signal: ctrl.signal,
      redirect: 'error'
    });
    if (!res.ok) {
      /* 不读取/透传上游正文；取消响应体，清理失败也不能覆盖 HTTP 状态。 */
      try {
        if (res.body) await res.body.cancel();
      } catch (e) {
        ctrl.abort();
      }
      throw new ApiError('E5011', 'LLM 调用失败：HTTP ' + res.status);
    }
    const data = await readJsonLimited(res);
    const choice = data && Array.isArray(data.choices) && data.choices[0];
    const content = choice && choice.message && typeof choice.message.content === 'string'
      ? choice.message.content : '';
    if (!content) throw new ApiError('E5012', 'LLM 返回内容为空');
    return content;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e && e.name === 'SyntaxError') throw new ApiError('E5012', 'LLM 响应不是合法 JSON');
    if (e && e.name === 'AbortError') throw new ApiError('E5011', 'LLM 调用超时（' + c.timeoutMs + ' ms）');
    throw new ApiError('E5011', 'LLM 调用失败：网络错误');
  } finally {
    /* 超时覆盖响应头与整个响应体读取；所有退出路径均释放定时器。 */
    clearTimeout(timer);
  }
}

/* ── JSON 提取与 schema 归一 ────────────────────────────────────────── */

/* 容忍 markdown 代码围栏与前后缀文本：取首个 { 到末个 } 之间解析 */
function parseJsonContent(content) {
  let text = String(content || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ApiError('E5012', 'LLM 输出不含 JSON 对象');
  let data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new ApiError('E5012', 'LLM 输出不是合法 JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ApiError('E5012', 'LLM 输出不是 JSON 对象');
  }
  return data;
}

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function str(v) { return typeof v === 'string' ? v.trim() : ''; }
function numOrNull(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(n))); }

const GOAL_TYPES = ['考研', '考公', '项目导学', '其他'];
const LEVELS = ['零基础', '一轮', '二轮', '多战'];
const MAX_REPLY = 600;

/* 画像归一：仅接受白名单槽位，未知字段丢弃，避免 LLM 幻觉字段渗入前端 */
function normalizeProfile(p) {
  const src = isObj(p) ? p : {};
  const out = {
    goalType: GOAL_TYPES.indexOf(str(src.goalType)) >= 0 ? str(src.goalType) : null,
    goalName: str(src.goalName).slice(0, 60) || null,
    deadline: /^\d{4}-\d{2}-\d{2}$/.test(str(src.deadline)) ? str(src.deadline) : null,
    weeklyH: numOrNull(src.weeklyH) === null ? null : clamp(numOrNull(src.weeklyH), 1, 80),
    level: LEVELS.indexOf(str(src.level)) >= 0 ? str(src.level) : null,
    subjects: Array.isArray(src.subjects)
      ? src.subjects.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, 12)).slice(0, 8)
      : [],
    preferences: str(src.preferences).slice(0, 200) || null
  };
  return out;
}

function profileMissing(profile) {
  const p = normalizeProfile(profile);
  const missing = [];
  if (!p.goalName) missing.push('goalName');
  if (!p.deadline) missing.push('deadline');
  if (!p.weeklyH) missing.push('weeklyH');
  if (!p.goalType) missing.push('goalType');
  return missing;
}

/* ── 澄清：一轮对话 → { reply, profile, done, missing } ────────────── */

const CLARIFY_SYSTEM = [
  '你是「诺瓦」，面向学生的日程助理。当前任务：通过多轮对话帮学生把模糊的学习诉求澄清成一份明确的需求画像。',
  '',
  '对话原则：',
  '- 从整体到局部：先确认目标方向，再问截止时间，再问每周可投入时间，再问现状水平，最后确认科目范围与偏好。',
  '- 每轮只问一到两个问题，语气自然、不施压、不堆砌术语；已知信息绝不重复询问。',
  '- 学生答非所问时温和拉回；学生表达情绪时先简短共情再继续。',
  '- 全部槽位确认完才置 done=true，并在最后一轮用两三句话复述完整画像请学生确认。',
  '',
  '槽位定义：',
  '- goalType：目标类型，只能是 考研 / 考公 / 项目导学 / 其他',
  '- goalName：目标名称（如「2027 考研 · 计算机」）',
  '- deadline：截止日期，YYYY-MM-DD；学生只说年份月份时按当月末补全',
  '- weeklyH：每周可投入学习小时数（数字）',
  '- level：现状水平，只能是 零基础 / 一轮 / 二轮 / 多战（不适用时为 null）',
  '- subjects：涉及科目数组（如 ["数学","英语"]）',
  '- preferences：其他偏好或约束（一句话）',
  '',
  '只输出一个 JSON 对象，不要输出任何其他文本，格式：',
  '{"reply":"这轮要对用户说的话","goalType":"考研|考公|项目导学|其他|null","goalName":"…|null","deadline":"YYYY-MM-DD|null","weeklyH":数字|null,"level":"零基础|一轮|二轮|多战|null","subjects":["…"],"preferences":"…|null","done":true|false,"missing":["尚未确认的槽位名"]}'
].join('\n');

/* 深合并：LLM 本轮未给出的槽位（null / 空数组）不覆盖既有画像，
   防止模型在追问轮丢掉先前已确认的信息 */
function mergeProfiles(prior, patch) {
  const p = normalizeProfile(prior);
  const q = normalizeProfile(patch);
  return normalizeProfile({
    goalType: q.goalType || p.goalType,
    goalName: q.goalName || p.goalName,
    deadline: q.deadline || p.deadline,
    weeklyH: q.weeklyH === null ? p.weeklyH : q.weeklyH,
    level: q.level || p.level,
    subjects: q.subjects.length ? q.subjects : p.subjects,
    preferences: q.preferences || p.preferences
  });
}

function clarifyTurn(messages, profile) {
  const prior = normalizeProfile(profile);
  const payload = messages.slice(-20).map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));
  const context = [
    { role: 'system', content: CLARIFY_SYSTEM },
    {
      role: 'system',
      content: '已确认的画像（可能为空，不要重复询问已确认项）：' + JSON.stringify(prior)
    }
  ].concat(payload);
  return chat(context, { temperature: 0.4 }).then((content) => {
    const data = parseJsonContent(content);
    const reply = str(data.reply).slice(0, MAX_REPLY);
    if (!reply) throw new ApiError('E5012', 'LLM 澄清输出缺少 reply');
    const merged = mergeProfiles(prior, data);
    let done = data.done === true;
    const missing = profileMissing(merged);
    /* 防幻觉兜底：LLM 宣称完成但槽位不齐时，强制回到追问态 */
    if (done && missing.length) done = false;
    return {
      reply: reply,
      profile: merged,
      done: done,
      missing: done ? [] : missing
    };
  });
}

/* ── 分析：画像（+ 可选执行历史）→ 拆解建议 ─────────────────────────── */

const ANALYZE_SYSTEM = [
  '你是「诺瓦」，面向学生的日程助理。当前任务：根据学生需求画像，产出下周学习计划拆解建议。',
  '',
  '规则：',
  '- 拆解 6～8 个计划项，覆盖画像中的全部科目，每项是一个具体可执行的动作（如「高数 · 极限与连续 40 题」），不要输出「复习数学」这类不可执行的条目。',
  '- est 为该项预计分钟数，取 15～240 的整数，按 15 分钟粒度取整；一天总负荷不超过 weeklyH 对应的分钟数。',
  '- weight 为重要度 0～1 之间的小数，越接近 1 越重要。',
  '- demandH 为达成该目标所需的总标准工时估计（小时，整数）：按目标类型与现状水平常识估计，宁大勿小。',
  '- weeklyH 为建议每周投入小时数（数字），应与画像中的 weeklyH 一致或给出更合理值。',
  '- risks 指出 2～3 条最可能的中断风险与对策，advice 用一句话收尾。',
  '',
  '只输出一个 JSON 对象，不要输出任何其他文本，格式：',
  '{"summary":"一句话计划思路","demandH":600,"weeklyH":18,"tasks":[{"s":"数学","title":"高数 · 极限与连续 40 题","est":90,"weight":0.92}],"risks":["…"],"advice":"…"}'
].join('\n');

/* 目标类型 → 缺省总需求工时（与 flows/goal.js 演示口径同源，LLM 缺项时兜底） */
const FALLBACK_DEMAND = { '考研': 913, '考公': 660, '项目导学': 520 };

/* 建议归一：est/weight 夹紧到引擎边界，条目上限 8，缺字段补默认 */
function normalizeSuggestion(data, profile) {
  const p = normalizeProfile(profile);
  const out = {
    summary: str(data.summary).slice(0, 120) || '按画像拆解本周计划',
    demandH: clamp(numOrNull(data.demandH) || FALLBACK_DEMAND[p.goalType] || 600, 60, 5000),
    weeklyH: clamp(numOrNull(data.weeklyH) || p.weeklyH || 15, 1, 80),
    tasks: [],
    risks: Array.isArray(data.risks) ? data.risks.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim().slice(0, 100)).slice(0, 3) : [],
    advice: str(data.advice).slice(0, 200)
  };
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  for (let i = 0; i < tasks.length && out.tasks.length < 8; i++) {
    const t = tasks[i];
    if (!isObj(t)) continue;
    const title = str(t.title).slice(0, 40);
    if (!title) continue;
    const est = typeof t.est === 'number' && isFinite(t.est) ? clamp(t.est, 15, 240) : 45;
    const weight = typeof t.weight === 'number' && isFinite(t.weight) ? Math.max(0.1, Math.min(1, t.weight)) : 0.6;
    out.tasks.push({
      s: str(t.s).slice(0, 12) || (p.subjects[0] || '学习'),
      title: title,
      est: est,
      weight: weight
    });
  }
  if (!out.tasks.length) throw new ApiError('E5012', 'LLM 拆解建议中没有有效计划项');
  return out;
}

function analyzeProfile(profile, history) {
  const p = normalizeProfile(profile);
  const missing = profileMissing(p);
  if (missing.length) return Promise.reject(new ApiError('E1001', '画像不完整，缺少：' + missing.join(' / ')));
  const payload = {
    role: 'user',
    content: '需求画像：' + JSON.stringify(p) +
      (isObj(history) && Object.keys(history).length
        ? '\n近况参考（只用于调整节奏与风险，不要照抄）：' + JSON.stringify(history).slice(0, 1200)
        : '')
  };
  return chat([{ role: 'system', content: ANALYZE_SYSTEM }, payload], { temperature: 0.5 })
    .then((content) => normalizeSuggestion(parseJsonContent(content), p));
}

module.exports = {
  configured: configured,
  chat: chat,
  parseJsonContent: parseJsonContent,
  normalizeProfile: normalizeProfile,
  profileMissing: profileMissing,
  clarifyTurn: clarifyTurn,
  analyzeProfile: analyzeProfile
};
