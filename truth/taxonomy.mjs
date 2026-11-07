/**
 * truth/taxonomy.mjs — 面板的「概念地图」：一个东西只归一个域，一个名字只对应一件事。
 *
 * 为什么单独一份：
 *   面板上本来有三套并行分类，各起各的名字 ——
 *     · 左栏十个区域（按「你想干什么」分）
 *     · 设置十三个分组（按配置命名空间分）
 *     · 技能六个分组（按能力用途分）
 *   于是同一个概念在不同地方叫法不同：「记忆」区域 vs「记忆与自我」设置组、
 *   「技能」区域 vs「会做什么」设置组、「学习」区域 vs「进化与权重」设置组。
 *   用户换一页就要重新认一遍，维护的人也会在两处各改一半。
 *
 * 这里只定义一份共同词汇：
 *   域（domain）—— 七个，回答「这一块是什么」；区域与设置分组都挂到域上。
 *   区域（region）—— 左栏入口，回答「我现在想干什么」；十个，每个都落在一个域里。
 *     例外是概览、规则、设置：它们本身是汇总或索引，不归任何单一域。
 *   详情类型（kind）—— 点开一张卡之后长什么样；只有五种，多一种先问是不是塞了两件事。
 *
 * 依赖规则：本文件**不 import 任何模块**（连 panel.mjs 都不 import）。
 * 否则会形成 taxonomy → panel → config → panel 的环，加载顺序一变就 undefined。
 * 反向依赖是允许的：panel.mjs / skill.mjs / panel-view.mjs 都可以 import 这里。
 */

/**
 * 七个域。顺序 = 设置页的顺序，也是「从它是谁，到它怎么跑」的顺序。
 *
 * 为什么是这七个而不是按配置文件分：
 *   配置文件的命名空间是实现细节（`guard` / `group` 分两个键空间，但用户眼里都是「说话」）。
 *   域是用户嘴里的词，设置分组只是它在某一页的展开。
 */
import { ALIASES } from '../lib/blueprint.mjs'

export const DOMAINS = Object.freeze([
  { id: 'identity', label: '身份', hint: '它是谁、怎么称呼、什么脾气' },
  { id: 'speech', label: '表达', hint: '什么时候开口、说几条、群里怎么接话' },
  { id: 'cognition', label: '心智', hint: '记得什么、怎么学、会不会改自己' },
  { id: 'autonomy', label: '自主', hint: '没人叫的时候它自己做什么' },
  { id: 'capability', label: '能力', hint: '会什么、能调什么、能跑什么' },
  { id: 'budget', label: '花费', hint: '花了多少、还剩多少' },
  { id: 'runtime', label: '运行', hint: '怎么连上、出问题去哪看、面板长什么样' },
])

/** 域 id 集合，给「不许写野域名」用 */
export const DOMAIN_IDS = Object.freeze(DOMAINS.map((one) => one.id))

/**
 * 十个区域 = 左栏入口。顺序按「一天里会看几次」，不按模块排。
 *
 * `domain` 是它归属的域；`null` 表示这一页本身是汇总或索引（概览 / 规则 / 设置），
 * 不归任何一个域 —— 硬塞进去会让「域」变成「页面」的同义词，那就白分了。
 *
 * 为什么把「对话」放在第二位：这是唯一需要用户动手的地方，其余都是看。
 * 为什么「连接」还在第三位而不是最后：第一次装上就要用它，藏到第八位等于让人找。
 */
export const REGIONS = Object.freeze([
  // 10 → 6（+ 诊断）。合并的判据不是"数量少好看"，而是**这两个页回答的是同一个问题**：
  //   花费不是独立主题，它是"它现在怎么样"的一部分 → 并进总览
  //   学习不是独立主题，它是"它记得什么、变成什么样"的一部分 → 并进心智
  //   规则不是独立主题，它是"它被允许做什么"的一部分 → 并进能力
  // 旧 id 全部留在 blueprint.ALIASES 里，深链与旧书签照样打开。
  { id: 'overview', label: '总览', hint: '它现在怎么样、今天花了多少', icon: 'pulse', domain: null },
  { id: 'talk', label: '对话', hint: '直接跟它说话，或者看它在 QQ 上跟谁聊', icon: 'chat', domain: 'speech' },
  { id: 'mind', label: '心智', hint: '记得什么、学到什么、能不能退回去', icon: 'spark', domain: 'cognition' },
  { id: 'ability', label: '能力', hint: '会什么、被允许什么、被什么硬约束卡住', icon: 'grid', domain: 'capability' },
  { id: 'channel', label: '连接', hint: '连上没有、怎么登录、协议端在哪', icon: 'plug', domain: 'runtime' },
  { id: 'settings', label: '设置', hint: '能改的都列在这里，改不了的说清楚', icon: 'sliders', domain: null },
  // 诊断不进主流程：只在出问题时才去。放在最后一段，平时不占注意力。
  { id: 'process', label: '诊断', hint: '跑了什么代码、改过什么、试一次', icon: 'layers', domain: 'runtime' },
])

/** 区域 id 集合（用例用它校验「每个区域都落在一个域里」） */
export const REGION_IDS = Object.freeze(REGIONS.map((one) => one.id))

/**
 * 详情页的形状。七种，分三组看就清楚了：
 *   通用   cards（一格格状态牌）· rows（一条条记录，可翻页）· form（一组可改的配置）
 *   对话   chat（聊天窗口，带输入框）
 *   取数据 image（一张图，前端按 src 取）· groups（一份列表）· vision（一次自检结果）
 *
 * 后三种不在这边拼内容，只给一个 `src` 让前端自己去取 —— 二维码、群列表、自检
 * 都是「取回来才知道」，算在宿主里只会多一次没必要的等待。
 *
 * 加新形状之前先问一句：是不是把两种东西硬塞进一个界面了。
 */
export const DETAIL_KINDS = Object.freeze({
  CARDS: 'cards',
  ROWS: 'rows',
  CHAT: 'chat',
  FORM: 'form',
  IMAGE: 'image',
  GROUPS: 'groups',
  VISION: 'vision',
  DEBUG: 'debug',
})

/**
 * 侧栏按「用户要办的事」分四段，而不是把十个区域平铺成一堵墙。
 * REGIONS 的顺序与 id 不变（导航仍按它排），这里只给每一段一个标题与归属。
 * 新增区域必须在这里归段，用例会钉住「一个区域只属于一段、没有漏掉的」。
 */
export const NAV_SECTIONS = Object.freeze([
  // label 为空 = 不画分段标题。总览和对话是"每次都会看"的两页，
  // 给它们加一个分类词只会多一行灰字，不提供任何信息。
  { id: 'main', label: '', regions: Object.freeze(['overview', 'talk']) },
  { id: 'self', label: '它是什么样', regions: Object.freeze(['mind', 'ability']) },
  { id: 'system', label: '连接与设置', regions: Object.freeze(['channel', 'settings']) },
  { id: 'debug', label: '诊断', regions: Object.freeze(['process']) },
])

/** 前端认得的全部详情形状。用例拿它做闭集校验，多一个少一个当场红 */
export const DETAIL_KIND_LIST = Object.freeze(Object.values(DETAIL_KINDS))

/**
 * 一个详情 id 的「归属」= 点号前面的那一段。
 * `skills.talk` 属于 skills 区域；`qq:private:1001` 这种带冒号的属于 talk（会话）。
 * 这一条只用来做面包屑，不参与取数 —— 取数按完整 id 走。
 */
export function regionOfDetail(id) {
  const key = String(id || '')
  if (key.startsWith('qq:')) return 'talk'
  const head = key.split('.')[0]
  if (REGION_IDS.includes(head)) return head
  // 详情 id 的前缀是"它属于哪一页"，页面合并之后前缀可能是旧名字。
  // 这里按 ALIASES 归位：`memory.xxx` 现在属于 mind 页。
  return ALIASES[head] || ''
}

/** 域的中文名。找不到就说「未分类」，不猜 */
export function domainLabel(id) {
  return DOMAINS.find((one) => one.id === String(id || ''))?.label || '未分类'
}
