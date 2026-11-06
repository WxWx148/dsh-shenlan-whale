/**
 * lib/taxonomy.mjs — 面板的「概念地图」：一个东西只归一个域，一个名字只对应一件事。
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
export const DOMAINS = Object.freeze([
  { id: 'self', label: '身份', hint: '它是谁、怎么称呼、什么脾气' },
  { id: 'voice', label: '表达', hint: '什么时候开口、说几条、群里怎么接话' },
  { id: 'mind', label: '心智', hint: '记得什么、怎么学、会不会改自己' },
  { id: 'life', label: '自主', hint: '没人叫的时候它自己做什么' },
  { id: 'skill', label: '能力', hint: '会什么、能调什么、能跑什么' },
  { id: 'cost', label: '花费', hint: '花了多少、还剩多少' },
  { id: 'ops', label: '运行', hint: '怎么连上、出问题去哪看、面板长什么样' },
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
  { id: 'overview', label: '概览', hint: '一眼看完它现在的状态', icon: 'pulse', domain: null },
  { id: 'connection', label: 'QQ 连接', hint: '看 QQ 连没连上、扫码登录、改协议端设置', icon: 'plug', domain: 'ops' },
  { id: 'talk', label: '对话', hint: '直接跟它说话，或者看它在 QQ 上跟谁聊', icon: 'chat', domain: 'voice' },
  { id: 'memory', label: '记忆', hint: '记得什么、认识谁、每个群聊过什么', icon: 'spark', domain: 'mind' },
  { id: 'skills', label: '技能', hint: '会什么、学会了什么、哪几项用不了', icon: 'grid', domain: 'skill' },
  { id: 'evolve', label: '学习', hint: '权重第几版、学到了什么、能不能退回去', icon: 'spark', domain: 'mind' },
  { id: 'usage', label: '花费', hint: '今天用了多少、还剩多少', icon: 'coin', domain: 'cost' },
  { id: 'process', label: '过程', hint: '跑了什么代码、改过什么、想过什么', icon: 'layers', domain: 'ops' },
  // 「规则」放在「设置」前面：先看现在按什么跑，再决定改哪一项。
  // 它不是配置页，也不承载变更记录 —— 只列此刻仍然生效的约束与已知缺口。
  { id: 'rules', label: '规则', hint: '此刻生效的硬约束、判定顺序，以及还没接上的事', icon: 'shield', domain: null },
  { id: 'settings', label: '设置', hint: '能改的都列在这里，改不了的说清楚', icon: 'sliders', domain: null },
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
})

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
  return REGION_IDS.includes(head) ? head : ''
}

/** 域的中文名。找不到就说「未分类」，不猜 */
export function domainLabel(id) {
  return DOMAINS.find((one) => one.id === String(id || ''))?.label || '未分类'
}
