/**
 * decide/intent.mjs — 「主人这句话是要我办什么事」的唯一判定表。
 *
 * 以前意图判定是散在 turn.mjs 里的正则：长度调参一组、联网搜索一组、
 * 主动开口一组、主人开关一组。新增一种说法只能再加一个 if，而且
 * 「查一下你代码」这种自指说法还会被 /(查一下|查查)/ 先送去联网搜一句话。
 *
 * 这一层把判定收成一张表：谁先匹配、命中后给什么规则、要几轮工具、
 * 期间界面显示哪句人话。turn.mjs 只负责按结果办事，不再自己猜。
 */
import { CAPABILITY_RULE, CORRECTION_RULE, PROGRESS_WORDS, SELF_CHECK_RULE } from '../truth/index.mjs'

/**
 * 顺序即优先级：诊断类最具体，必须排在泛化的「能不能」之前；
 * 进度追问排在最后，因为它常常只是「？」「怎么不说话」。
 */
export const INTENTS = Object.freeze([
  {
    kind: 'self_check',
    re: /(查一?查|查一下|查查|核对|核实|排查|复盘|自检|审视|研究一下?|看看?).{0,16}(代码|源码|实现|配置|数据|问题|原因|结论|自己)|(代码|源码|实现).{0,12}(有什么问题|的问题|问题|查一下|查)|给我说结论|说结论|给我结论/,
    rule: SELF_CHECK_RULE,
    minRounds: 4,
    progress: PROGRESS_WORDS.checking,
    tools: ['code_list', 'code_read', 'code_search', 'my_status', 'audit_self'],
  },
  {
    kind: 'capability',
    re: /(能不能|可不可以|是不是|知不知道|知道.{0,10}(里面|是什么|吗|嘛|说了什么)|看得到|看不看到|看不到|别的群|另一个群|记忆体|同一个|串到|你查.*代码)/,
    rule: CAPABILITY_RULE,
    minRounds: 3,
    progress: PROGRESS_WORDS.checking,
    tools: ['group_recap', 'who_said', 'my_memory', 'code_search', 'my_capabilities'],
  },
  {
    kind: 'correction',
    re: /(我要修正你|修正你|你说错了|说错了|纠正一下|改正|不对[，,。！!]?)/,
    rule: CORRECTION_RULE,
    minRounds: 2,
    progress: '',
    tools: ['my_memory', 'revise_self', 'read_persona', 'revise_persona', 'code_read', 'code_search', 'code_write'],
  },
  {
    kind: 'progress_query',
    re: /(怎么又不说话|不说话了|没查完|查完了吗|还在查|在干嘛|没反应)/,
    rule: '主人是在问刚才那件事的进展。直接说做到哪一步、还差什么，不要重新开始，也不要只回一句「在呢」。',
    minRounds: 1,
    progress: '',
    tools: [],
  },
])

/** 命中后仍可用的工具（注册表里没有的过滤掉，免得提示词点名一个不存在的工具） */
export function matchIntent(text, toolNames = []) {
  const value = String(text || '')
  for (const intent of INTENTS) {
    if (!intent.re.test(value)) continue
    return {
      ...intent,
      tools: intent.tools.filter((name) => toolNames.includes(name)),
    }
  }
  return null
}

/**
 * 这句话是不是在说「查我自己」，而不是「上网查」。
 *
 * turn.mjs 的联网兜底用的正则很宽（查一下 / 查查 / 搜索），
 * 「你查一下你代码这部分」会先被送去 searchWeb，而 net.allowlist 默认空
 * = 不许上网，结果就是静默失败、模型拿不到任何资料，只能凭印象胡答。
 */
export function isSelfReferential(text) {
  return /(代码|源码|实现|配置|自己|这部分|这块|你的设置|你的记忆)/.test(String(text || ''))
}

/** 联网兜底要不要跳过 */
export function skipWebSearch(text) {
  return isSelfReferential(text) && /(查|搜|找|看|核对|排查|复盘)/.test(String(text || ''))
}
