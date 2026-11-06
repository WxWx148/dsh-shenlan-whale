/**
 * scripts/dump-taxonomy.mjs — 把当前的概念分类原样打印成 Markdown。
 *
 * 为什么要有它：CONCEPTS.md 里那几张表如果手抄，改一次代码就会过期一次，
 * 而「文档数字过期」正是这个工程反复要修的老毛病。这张表由代码生成，
 * 谁怀疑文档写错了，跑一遍这个脚本对一下就行。
 *
 * 只读：不写盘、不改任何东西。
 *
 * 用法：node scripts/dump-taxonomy.mjs
 */

import { DOMAINS, REGIONS } from '../lib/taxonomy.mjs'
import { PANEL_GROUPS, PANEL_ITEMS, LEVEL, itemsOf, isPending } from '../lib/panel.mjs'
import { SKILL_GROUPS, CATALOG } from '../lib/skill.mjs'
import { RULE_GROUPS } from '../lib/rules.mjs'

/**
 * 每个区域挂哪些模块卡。
 * 这里手写一遍是刻意的：它同时充当「预期清单」—— 真实模块由 panel-view 现算，
 * 两边对不上时，单元测试会先红，不会等到文档过期才发现。
 */
const MODULES = {
  overview: ['usage.today', 'talk.qq', 'skills.all', 'process.audit', 'rules.all', 'status.all'],
  connection: ['connection.status', 'connection.qr', 'connection.groups', 'settings.channel'],
  talk: ['talk.local', 'talk.qq'],
  memory: ['memory.all', 'memory.facts', 'memory.people', 'memory.groups', 'memory.self'],
  skills: SKILL_GROUPS.map((group) => `skills.${group.id}`),
  evolve: ['evolve.weights', 'evolve.history', 'evolve.policy'],
  usage: ['usage.today', 'usage.price'],
  process: ['process.sandbox', 'process.audit', 'process.cot', 'process.activity', 'process.vision'],
  rules: ['rules.all', ...RULE_GROUPS.map((group) => `rules.${group.id}`), 'rules.gaps'],
  settings: PANEL_GROUPS.filter((group) => group.id !== 'status').map((group) => `settings.${group.id}`),
}

const lines = []
const push = (line = '') => lines.push(line)

push('## 七个域')
push('')
push('| 域 | 一句话 | 管辖的区域 | 设置分组 | 技能分组 |')
push('|---|---|---|---|---|')
for (const domain of DOMAINS) {
  const regions = REGIONS.filter((one) => one.domain === domain.id).map((one) => one.label)
  const groups = PANEL_GROUPS.filter((one) => one.domain === domain.id).map((one) => one.label)
  const skills = SKILL_GROUPS.filter((one) => one.domain === domain.id).map((one) => one.label)
  push(`| ${domain.label} \`${domain.id}\` | ${domain.hint} | ${regions.join('、') || '—'} | ${groups.join('、')} | ${skills.join('、') || '—'} |`)
}

push('')
push('## 十个区域')
push('')
push('| 区域 | 回答什么问题 | 域 | 模块卡（点进去看什么） |')
push('|---|---|---|---|')
for (const region of REGIONS) {
  const domain = region.domain ? DOMAINS.find((one) => one.id === region.domain)?.label : '—'
  push(`| ${region.label} \`${region.id}\` | ${region.hint} | ${domain} | ${regionModules(region.id)} |`)
}

push('')
push('## 设置分组（12 组，其中 1 组只读）')
push('')
push('| 分组 | 域 | 项数 | 生效情况 |')
push('|---|---|---|---|')
for (const group of PANEL_GROUPS) {
  const items = itemsOf(group.id)
  const pending = items.filter((item) => isPending(item.key)).length
  const readonly = items.every((item) => item.level === LEVEL.READONLY)
  push(`| ${group.label} \`${group.id}\` | ${group.domain} | ${items.length} | ${readonly ? '只读' : pending ? `${pending} 项暂不生效` : '都可改'} |`)
}

push('')
push('## 状态项（只读）')
push('')
const statusItems = PANEL_ITEMS.filter((item) => item.level === LEVEL.READONLY)
push(`共 ${statusItems.length} 项，按来源分：`)
push('')
const bySource = new Map()
for (const item of statusItems) {
  if (!bySource.has(item.source)) bySource.set(item.source, [])
  bySource.get(item.source).push(item)
}
push('| 来源 | 项 | 项数 |')
push('|---|---|---|')
for (const [source, items] of bySource) push(`| \`${source}\` | ${items.map((one) => one.label).join('、')} | ${items.length} |`)

push('')
push('## 技能分组')
push('')
push('| 分组 | 域 | 技能数 | 出厂技能 |')
push('|---|---|---|---|')
for (const group of SKILL_GROUPS) {
  const skills = CATALOG.filter((skill) => skill.group === group.id)
  push(`| ${group.label} \`${group.id}\` | ${group.domain} | ${skills.length} | ${skills.map((one) => one.name).join('、')} |`)
}
push('')
push(`出厂技能合计 **${CATALOG.length}** 项；配置键 **${PANEL_ITEMS.filter((item) => item.level !== LEVEL.READONLY).length}** 个，全部在设置页有归属。`)

/** 模块卡由 panel-view 现算；这里只列 id，避免把渲染逻辑搬进脚本 */
function regionModules(regionId) {
  const ids = MODULES[regionId] || []
  return ids.map((id) => `\`${id}\``).join(' ')
}

console.log(lines.join('\n'))
