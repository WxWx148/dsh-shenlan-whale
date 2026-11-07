/**
 * truth/manifest.mjs — 「这张脸能改什么、能看什么」的唯一一份合成视图。
 *
 * 设计文档里 truth 是三件：`manifest / config / audit`。前两件 0.45.21 就位了，
 * manifest 一直空着 —— 不是忘了，是因为它**不是第四个真源**，而是前三份真源
 * （panel 的面板项、taxonomy 的页面与域、capabilities 的自述口径）的一次合并投影。
 * 造一个「又一堆常量」的 manifest 只会立刻与真源分叉；真正有价值的是：
 *
 *   data()    数据：配置键的默认值 + 面板项的元数据（谁可改、风险、生效方式）
 *   derive()  派生：按分组/页面/域重新切一遍，界面与文档要的是这些切法
 *   check()   对账：三份真源之间有没有对不上的地方（缺默认值、分组不存在、页面归错域…）
 *
 * 三个投影都是**算出来的**，没有一处手抄。判据也就很硬：
 * 改 `panel.mjs` 一行，`check()` 与 `data()` 立刻跟着变；如果没变，说明这里藏了副本。
 *
 * 与 `check-config-consumers.mjs` 的分工：那个问「这个键有没有人读」（运行时行为），
 * 这里问「这个键有没有面板项、有没有默认值」（形状一致性）。两者都过，才叫「改得动」。
 */

// 直接指到三份真源的文件，不绕自己的门面：门面会 export 本文件，
// 从门面取就成了「index → manifest → index」的环（check-layers 会当场报）。
import { DEFAULTS, defaultKeys, flatten } from './config.mjs'
import { PANEL_GROUPS, PANEL_ITEMS, RISK, coverage, editable, summary } from './panel.mjs'
import { DOMAINS, REGIONS, REGION_IDS } from './taxonomy.mjs'

export const MANIFEST_SCHEMA = 'shenlan.manifest/1'

/**
 * 数据投影：96 个键的默认值 + 123 个面板项。
 *
 * 只放「键 → 值 / 键 → 元数据」，不做分组、不做筛选 —— 那些是 derive() 的事。
 * 混在一起是旧版面板的老毛病：读的人分不清哪部分是配置、哪部分是布局。
 */
export function manifestData() {
  const defaults = flatten(DEFAULTS)
  return {
    keys: defaultKeys().sort(),
    defaults,
    items: PANEL_ITEMS.map((one) => ({
      key: one.key,
      label: one.label,
      group: one.group,
      kind: one.kind,
      level: one.level,
      risk: one.risk,
      source: one.source,
      hint: one.hint,
    })),
  }
}

/**
 * 派生投影：同一份数据换几种切法。全部现算，不缓存 ——
 * 缓存过一次就会有人忘了失效，然后界面显示上一版的分组。
 */
export function manifestDerive() {
  const byGroup = {}
  for (const item of PANEL_ITEMS) {
    if (!byGroup[item.group]) byGroup[item.group] = []
    byGroup[item.group].push(item.key)
  }
  const pagesOfDomain = {}
  for (const page of REGIONS) {
    const key = page.domain || 'overview'
    if (!pagesOfDomain[key]) pagesOfDomain[key] = []
    pagesOfDomain[key].push(page.id)
  }
  return {
    groups: PANEL_GROUPS.map((group) => ({
      id: group.id,
      label: group.label,
      hint: group.hint,
      keys: (byGroup[group.id] || []).sort(),
    })),
    domains: DOMAINS.map((domain) => ({
      id: domain.id,
      label: domain.label,
      hint: domain.hint,
      pages: (pagesOfDomain[domain.id] || []).sort(),
    })),
    pages: REGIONS.map((page) => ({ id: page.id, label: page.label, domain: page.domain || 'overview' })),
    editable: editable().map((item) => item.key).sort(),
    highRisk: PANEL_ITEMS.filter((item) => item.risk === RISK.HIGH).map((item) => item.key).sort(),
    counts: summary(),
  }
}

/**
 * 对账投影：三份真源之间对不上的地方，一条一条列出来。
 *
 * 六条判据，每条都对应一次真实的「改了没反应」：
 *   1. 可编辑项没有默认值 —— 用户改完重启，值又变回去；
 *   2. 默认值没有面板项 —— 手工改 json 才生效，界面上找不到；
 *   3. 面板项写了一个不存在的分组 —— 它在界面上无处可去（掉进「其他」）；
 *   4. 同一个键登记两次 —— 后一条静默覆盖前一条，标注与实际不符；
 *   5. 分组里一个面板项都没有 —— 界面上多一个空标题；
 *   6. 只读项被标成可改 —— 界面上出现一个改不动的输入框（比没有更糟）。
 *
 * 曾经想加「域必须至少有一个页面」，跑出来 3 条假警报：identity / autonomy / budget
 * 是模块归属用的域，本来就由总览页的卡片覆盖，不是每一域都对应一张独立页面。
 * 判据要能区分「真缺陷」和「设计如此」，宁可少一条，不要报假警 ——
 * 会报假警的对账，最后没人看。
 */
export function manifestCheck() {
  const problems = []
  const cov = coverage(Object.keys(flatten(DEFAULTS)))
  for (const key of cov.missing) problems.push(`可编辑项没有默认值：${key}`)
  for (const key of cov.extra) problems.push(`默认值没有面板项：${key}`)

  const groupIds = new Set(PANEL_GROUPS.map((group) => group.id))
  for (const item of PANEL_ITEMS) {
    if (!groupIds.has(item.group)) problems.push(`面板项 ${item.key} 的分组「${item.group}」不存在`)
  }

  const seen = new Set()
  for (const item of PANEL_ITEMS) {
    if (seen.has(item.key)) problems.push(`面板项重复登记：${item.key}`)
    seen.add(item.key)
  }

  const pageIds = new Set(REGION_IDS)
  const domainIds = new Set(DOMAINS.map((domain) => domain.id))
  for (const page of REGIONS) {
    if (!page.domain) continue
    if (!domainIds.has(page.domain)) problems.push(`页面 ${page.id} 归到了不存在的域「${page.domain}」`)
  }
  if (pageIds.size !== REGIONS.length) problems.push('页面 id 有重复')

  const usedGroups = new Set(PANEL_ITEMS.map((item) => item.group))
  for (const group of PANEL_GROUPS) {
    if (!usedGroups.has(group.id)) problems.push(`分组「${group.id}」里一个面板项都没有`)
  }
  for (const item of PANEL_ITEMS) {
    if (item.level === 'readonly' && item.kind !== 'readonly') {
      problems.push(`只读项 ${item.key} 的 kind 是「${item.kind}」，界面上会变成改不动的输入框`)
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    counts: {
      keys: defaultKeys().length,
      items: PANEL_ITEMS.length,
      groups: PANEL_GROUPS.length,
      pages: REGIONS.length,
      domains: DOMAINS.length,
    },
  }
}

/** 三投影一起给：导出快照、面板「关于」页、审计脚本都从这里取。 */
export function manifest() {
  return {
    schema: MANIFEST_SCHEMA,
    data: manifestData(),
    derive: manifestDerive(),
    check: manifestCheck(),
  }
}
