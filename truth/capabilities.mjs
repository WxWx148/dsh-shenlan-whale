/**
 * truth/capabilities.mjs — 「我能看到什么、我该怎么做」的唯一口径。
 *
 * 以前这件事散在四处：tools.prompt() 的工具名清单、TOOL_HINTS 的前 10 个示例、
 * my_capabilities 的手写文案、以及模型自己从上下文窗口猜出来的结论。
 * 结果就是主人问「别的群你知道吗」「能查自己代码吗」，它照着「最近这段对话里
 * 没出现」答成「我看不到 / 不可能」，把「默认没注入」说成了「能力不存在」。
 *
 * 这一层只做两件事：
 *   1. 把可见范围说成三层，谁都能按同一套话回答；
 *   2. 把「主人让我自查」变成有固定产出的任务，而不是一句拟人化闲聊。
 *
 * 注意：这些文字是给模型看的提示词，不是界面文案。界面上该说什么由
 * panel-view.mjs 决定，两边不许互相抄。
 */

/** 三层可见性。顺序不能变：模型回答时先说自己看到了什么，再说能查什么 */
export const VISIBILITY = Object.freeze({
  HERE: '这场对话',
  ALWAYS: '一直记得的',
  ON_DEMAND: '可以现在查的',
})

/**
 * 按当前配置与工具注册表生成一份自述。
 * 传 toolNames 而不是写死名字：以后加工具、改白名单、关档位，这段话自动跟上。
 *
 * `withTools: false` 是给**聊天提示词**用的：工具名已经在工具清单那一行里，
 * 这里再抄一遍只是让同一串名字出现两次。保留分组语义（别的群 / 代码 / 状态 / 记忆），
 * 模型仍然知道「这些能查」，只是不再重复记名字。
 */
export function capabilityBrief({ config = {}, toolNames = [], withTools = true } = {}) {
  const has = (name) => toolNames.includes(name)
  const can = (...names) => names.some(has)
  const lines = [
    `· ${VISIBILITY.HERE}：只有当前这场对话最近的消息。群与群、群与私聊各是一条线，默认不交叉。`,
    `· ${VISIBILITY.ALWAYS}：全局事实、认识的人、对自己的认知，这些跨群与私聊共享，是同一个记忆体。`,
    `· ${VISIBILITY.ON_DEMAND}：别的群在聊什么、某人说过什么、自己的源码与配置、账本与运行状态，都可以现在查。`,
  ]
  const groups = []
  if (can('group_recap', 'group_patrol')) groups.push('别的群')
  if (can('code_search', 'code_read', 'code_list')) groups.push('自己的代码')
  if (can('my_status', 'my_capabilities', 'my_thoughts')) groups.push('自己的状态')
  if (can('recall', 'my_memory', 'person_dossier')) groups.push('记忆')
  if (groups.length) {
    lines.push(withTools
      ? `  能用的查法：${groups.map((one) => {
        if (one === '别的群') return '别的群：group_recap / group_impressions / who_said'
        if (one === '自己的代码') return '自己的代码：code_list / code_read / code_search'
        if (one === '自己的状态') return '自己的状态：my_status / my_capabilities / audit_self'
        return '记忆：recall / my_memory / person_dossier'
      }).join('；')}。`
      : `  能查：${groups.join('、')}；问到就现在查，别答「看不到」。`)
  }
  // 「改自己」三件事经常被模型混成一件：
  //   人设（persona.md）走 read_persona / revise_persona；
  //   源码走 code_read / code_write（写前自动备份）；
  //   exec_sandbox 只是临时脚本的草稿纸，只写 out/，碰不到前两者。
  // 不写清就会听到「沙箱碰不到 persona，所以改不了」——那是把三条路当成一条。
  const selfBits = []
  if (can('read_persona', 'revise_persona')) selfBits.push(withTools ? '人设 read_persona/revise_persona' : '人设（能读能改）')
  if (can('code_read', 'code_write') && config.sandbox?.codeMode !== 'off') {
    selfBits.push(withTools ? '源码 code_read/code_write（改前备份）' : '源码（能读能改，改前备份）')
  }
  if (can('exec_sandbox')) selfBits.push(withTools ? '临时脚本 exec_sandbox（只写 out/）' : '临时脚本（只写 out/）')
  if (selfBits.length) lines.push(`  改自己：${selfBits.join('；')}。三条路不是一回事。`)
  if (config.memory?.enabled === false) lines.push('  注意：长期记忆现在关着，这一层暂时读不到。')
  if (config.sandbox?.codeMode === 'off') lines.push('  注意：看源码现在关着，这一层暂时查不了。')
  return lines.join('\n')
}

/** 被问到「知不知道 / 能不能」时的硬规则 */
export const CAPABILITY_RULE =
  '关于你能看到什么，只按上面三层回答，不许把「这场对话里没出现」说成「不存在 / 不可能 / 我这边看不到」。' +
  '主人问起别的群、别的会话、自己的代码或数据时：先说清它属于哪一层，' +
  '再说「我可以现在查一下」并真的调用对应工具；查完给结论，不要只回一句「不知道」。' +
  '确实查不到时，说清缺的是哪一部分，不要反问主人「要我怎么改」。'

/**
 * 自查结论的四段标题。
 *
 * 规则句从这份清单生成，不再手写一遍：以前规则里硬写着「【现象】【依据】
 * 【结论】【建议】」，而这份清单单独导出、没人用 ——
 * 改了清单不会改规则，改了规则不会改清单，两边悄悄对不上，
 * 而模型照着提示词输出的是规则那一份。
 */
const SELF_CHECK_SECTIONS = Object.freeze(['现象', '依据', '结论', '建议'])

/** 主人下达自查 / 复盘 / 核对类指令时的硬规则 */
export const SELF_CHECK_RULE =
  '主人让你查代码、核对数据、复盘问题、给结论，这是一件必须做完的事，不是闲聊。' +
  '先调用查证工具拿到依据，再按四段给结论：' +
  SELF_CHECK_SECTIONS.map((title) => `【${title}】`).join('') +
  '（依据要写清是哪一处记录或文件）。资料不够就明说缺哪一部分，不要说「我再查一下」然后不给结论，' +
  '也不要把「我要修正你」理解成让主人先说怎么改。' +
  '结论里不要出现「第几轮」「调用了几次」这类过程描述。'

/** 主人说「我要修正你」时的硬规则：先分清修正对象，再给可选项 */
export const CORRECTION_RULE =
  '主人说要修正你，先回一句确认，并列出可以修正的四类：记错的事实、对自己的认知、' +
  '说话的方式、代码与配置。不要只回「你说怎么改」，也不要擅自改任何一项；' +
  '主人点明对象后，先查依据再动手，改完说清改了什么。' +
  '分清三条路：想法用 revise_self；人设用 read_persona/revise_persona（section+text+reason）；' +
  '源码用 code_read/code_write（改前自动备份）。exec_sandbox 只是临时脚本草稿纸，改不了人设和源码。'

/**
 * 界面上的状态词。内部阶段 → 人话，一对一。
 * 界面不许出现「第 N 轮工具调用」「maxRounds」「执行器」这类过程词。
 */
export const PROGRESS_WORDS = Object.freeze({
  checking: '正在核对数据',
  reading: '正在翻聊天记录',
  forwarding: '正在整理这段转发',
  source: '正在看自己的实现',
  memory: '正在翻记过的东西',
  done: '核对完了',
})
