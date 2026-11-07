/**
 * lib/blueprint.mjs — 结构的「设计声明」。只有人和生成器读它，界面不直接读。
 *
 * 为什么要把这份东西单独拿出来：
 *   代码里能扫出「有哪些文件、每个文件导出什么」（事实），
 *   但扫不出「12 个父模块分别叫什么、哪个是计划中的、哪个域对应哪几个父模块」（设计）。
 *   以前这两件事混在一起 —— 要么写死在界面里，要么只存在于文档里，然后慢慢对不上。
 *
 * 这里只放**代码里推不出来的判断**：
 *   PARENTS        12 个父模块（landed 表示目录已经存在，planned 表示只有约定）
 *   DOMAIN_PARENTS 概念域 → 父模块的映射（域 id 必须在 taxonomy.DOMAINS 里）
 *   ALIASES        旧页面 id → 新页面 id（合并页面时保证深链不断）
 *   API_BASE       接口前缀的唯一定义
 *
 * 页面的 id/label/icon 不在这里 —— 那是 taxonomy.REGIONS 的事，生成器会去读，
 * 不复制第二份。
 */

export const SCHEMA = 1

/**
 * 12 个父模块。顺序 = 依赖从下往上（底座 → 通道 → 表达 → … → 装配）。
 *
 * `facade` 为 null 表示这一层没有门面：外部要用的东西各自 import。
 * 目前只有 base 是这样（四件互不相干，包一层门面只是多一层转发）。
 */
export const PARENTS = Object.freeze([
  { id: 'base', label: '底座', dir: 'base', facade: null, landed: true, desc: '日志、账本、文件、定时器' },
  { id: 'channel', label: '通道', dir: 'channel', facade: 'index.mjs', landed: true, desc: 'OneBot 协议、NapCat 登录、掉线补回' },
  { id: 'voice', label: '表达', dir: 'voice', facade: 'index.mjs', landed: true, desc: '成形、语气、断句、打字节奏' },
  { id: 'facts', label: '事实', dir: 'facts', facade: 'index.mjs', landed: true, desc: '事件打标、用量；四本账仍在 runtime，见 facts/index.mjs 头注释' },
  { id: 'decide', label: '决定', dir: 'decide', facade: 'index.mjs', landed: true, desc: '该不该说、说不说、出口闸门（含 guardPlan）' },
  { id: 'turn', label: '一轮', dir: 'turn', facade: 'index.mjs', landed: true, desc: '理解、回忆、组装、生成、分条' },
  { id: 'mind', label: '心智', dir: 'mind', facade: 'index.mjs', landed: true, desc: '记忆、人格、意愿、learn/（归纳、习惯、自查、权重、进化）' },
  { id: 'ability', label: '能力', dir: 'ability', facade: 'index.mjs', landed: true, desc: '技能、工具、沙箱、审批、编码、媒体、联网；依赖由装配层注入（tools/ exec/ media/ 仍平铺）' },
  { id: 'life', label: '自主', dir: 'life', facade: 'index.mjs', landed: true, desc: '活动、提醒、活动账本（meter 即 activity-usage.mjs）' },
  { id: 'view', label: '视图', dir: 'view', facade: 'index.mjs', landed: true, desc: '面板载荷、模块卡、会话视图、诊断、列表（client.panel.js 未搬）' },
  { id: 'truth', label: '真源', dir: 'truth', facade: 'index.mjs', landed: true, desc: '配置形状、面板清单、概念地图、自述口径、manifest 三投影、对账清单' },
  { id: 'app', label: '装配', dir: 'app', facade: 'index.mjs', landed: true, desc: '路由、出站、定时任务' },
])

/**
 * 概念域 → 它覆盖的父模块。
 *
 * 域是**给用户看的分类**（设置分组、详情页副标题），父模块是**代码结构**。
 * 两者以前有 4 个同名（voice / mind / life / skill≈ability），界面上说「表达」域
 * 会被误认为等于 voice/ 目录。所以域 id 全部换成语义准、零重名的名字，映射显式写在这里。
 */
export const DOMAIN_PARENTS = Object.freeze({
  identity: Object.freeze(['app', 'truth']),
  speech: Object.freeze(['voice', 'decide']),
  cognition: Object.freeze(['mind', 'facts']),
  autonomy: Object.freeze(['life']),
  capability: Object.freeze(['ability']),
  budget: Object.freeze(['facts']),
  runtime: Object.freeze(['base', 'channel', 'view']),
})

/**
 * 旧页面 id → 新页面 id（页面 10 → 6 时填）。
 *
 * 这张表存在的理由只有一个：**别让用户的旧书签和旧深链断掉**。
 * 它不参与"有哪些页面"的判断 —— 页面清单只有 taxonomy.REGIONS 一份，
 * 别名只负责把旧名字翻译成新名字。
 *
 * 三条约束（check:ui 的 R7 会查）：
 *   1. 值必须是真实存在的页面 id
 *   2. 键不能和真实页面 id 冲突（那样会出现"这个 id 到底指哪页"）
 *   3. 不许指向自己（写 `memory: 'memory'` 是无意义的噪声）
 */
export const ALIASES = Object.freeze({
  // 花费不是独立主题，是"现在怎么样"的一部分
  usage: 'overview',
  // 学习不是独立主题，是"记得什么、变成什么样"的一部分
  evolve: 'mind',
  memory: 'mind',
  // 规则不是独立主题，是"被允许做什么"的一部分
  rules: 'ability',
  skills: 'ability',
  // 连接改名为"连接"：原 id 叫 connection，太像代码词
  connection: 'channel',
})

/** 接口前缀的唯一定义。界面不再拼字面量，统一走 structure.assetUrl / structure.apiUrl */
export const API_BASE = '/api/shenlan'
