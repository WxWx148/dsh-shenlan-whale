/**
 * decide/behavior.mjs — 事件 → 行为，只有一张路由表说了算。
 *
 * 为什么必须集中成一张表：
 *   旧版「回不回」「算不算指令」「要不要主动」散在 3 个模块的 if 里，
 *   同一个群里未 @ 的消息，一处算「收到」、一处算「忽略」、统计里又算「未处理」，
 *   三种口径同时存在，于是响应率永远是错的。
 *
 * 五类行为，一类只做一件事：
 *   reply        回话（对话、面板提问）
 *   proactive    主动开口（有由头的）
 *   activity     自己安排的事（三段式活动，可在沙箱里跑代码/调工具）
 *   admin        执行指令（工具环）
 *   maintenance  维护（摘要、重建、归纳、进化权重）
 *
 * 主意：**没被路由到的，不是「忽略」，是「按设计不行为」**。
 *   群里没 @ 也没叫名字的话，进事件流、进统计，但不出行为记录。
 *   这样「他说了多少」「我接了多少」两个数字才是可比的。
 */

import { KIND, SCOPE, TAG, has } from '../facts/index.mjs'

/** 兴趣词的概念扩展：不是精确匹配，而是同一类说法 */
const INTEREST_CONCEPTS = Object.freeze({
  游戏: ['游戏', '手游', '端游', '网游', '单机', '主机', 'steam', '开黑', '副本', '打本', '电竞', '联机', '排位'],
  观鸟: ['观鸟', '鸟', '拍鸟', '候鸟', '野鸟', '鸟种', '飞羽', 'bird'],
  硬件: ['硬件', '显卡', 'cpu', '主板', '内存', '装机', '散热', '机箱', '电源', '固态', '硬盘', '显卡吧'],
  小说: ['小说', '看书', '读书', '作者', '剧情', '章节', '网文', '书荒'],
  电影: ['电影', '影片', '片子', '导演', '影院', '上映', '影视', '剧'],
  钓鱼: ['钓鱼', '路亚', '竿', '野钓', '台钓', '抛竿', '鱼获'],
  动漫: ['动漫', '动画', '番剧', '二次元', '漫画', 'cos'],
  音乐: ['音乐', '唱歌', '乐队', '专辑', '耳机', 'livehouse'],
  AI: ['ai', '人工智能', '大模型', '模型', 'deepseek', 'chatgpt', '提示词', 'agent'],
})

/** 一条群消息是否命中兴趣概念 */
function interestMatched(text, interests) {
  const body = String(text || '').toLowerCase()
  if (!body) return false
  for (const raw of Array.isArray(interests) ? interests : []) {
    const word = String(raw || '').trim()
    if (!word) continue
    const terms = [word, ...(INTEREST_CONCEPTS[word] || [])]
    if (terms.some((term) => {
      const value = String(term || '').toLowerCase()
      if (!value) return false
      if (/^[a-z0-9]+$/i.test(value)) return body.includes(value)
      return value.length >= 2 ? body.includes(value) : body.includes(value)
    })) return true
  }
  return false
}

export const BEHAVIOR = Object.freeze({
  REPLY: 'reply',
  PROACTIVE: 'proactive',
  ACTIVITY: 'activity',
  ADMIN: 'admin',
  MAINTENANCE: 'maintenance',
})

export const BEHAVIOR_LIST = Object.freeze(Object.values(BEHAVIOR))

/** 参与权重进化的行为（管理与维护不优化：它们由规则决定，不该被「效果」带跑） */
export const TUNABLE_BEHAVIORS = Object.freeze([BEHAVIOR.REPLY, BEHAVIOR.PROACTIVE, BEHAVIOR.ACTIVITY])

const MESSAGE_KINDS = new Set([KIND.MESSAGE, KIND.IMAGE])

/**
 * 路由。纯函数，只吃事件 + 运行时开关，不碰磁盘、不发消息。
 *
 * @param {object} event
 * @param {object} [ctx]
 * @param {(text: string) => string|null} [ctx.matchCommand] 命中指令就返回指令名
 * @param {'activity'|'proactive'} [ctx.timerIntent]          定时器这次想干什么
 * @param {boolean} [ctx.maintenanceDue]                      到点该做维护了
 * @param {boolean} [ctx.guardAllowed]                        限流放行了吗
 * @param {{continue:boolean, handoffFrom:string}} [ctx.attention] 注意力账本的判定（见 decide/attention.mjs）
 * @returns {{ behavior: string|null, trigger: string, reason: string }}
 *   behavior 为 null 表示「只记事件，不产生行为」，这是正常结果，不是错误。
 */
export function route(event, ctx = {}) {
  if (!event) return { behavior: null, trigger: 'no_event', reason: '没有事件' }

  // 1. 只看不做的：进事件流就够了
  if (event.kind === KIND.NOTICE || event.kind === KIND.HEARTBEAT) {
    return { behavior: null, trigger: 'observe_only', reason: '通知与心跳只记录' }
  }

  // 2. 显式指令：主人发才算数，别人发的一律不执行（安全边界，不靠提示词）
  if (event.kind === KIND.COMMAND) {
    if (has(event, TAG.IS_OWNER)) return { behavior: BEHAVIOR.ADMIN, trigger: 'command', reason: '主人下的指令' }
    return { behavior: null, trigger: 'command_not_owner', reason: '不是主人发的指令，不执行' }
  }

  // 3. 定时任务
  if (event.kind === KIND.TASK) {
    return { behavior: BEHAVIOR.MAINTENANCE, trigger: 'task', reason: '到点做维护' }
  }

  // 4. 定时器触发的自主行为。
  //    必须先于「消息分支」判断：定时器也可能造出 kind=message 的事件
  //    （比如「到点提醒一句」），它不该被当成聊天消息去回话。
  if (event.source === 'timer') {
    if (ctx.guardAllowed === false) return { behavior: null, trigger: 'guard_hold', reason: '限流没过' }
    if (ctx.maintenanceDue) return { behavior: BEHAVIOR.MAINTENANCE, trigger: 'daily_due', reason: '每日维护到点' }
    const intent = ctx.timerIntent === BEHAVIOR.PROACTIVE ? BEHAVIOR.PROACTIVE : BEHAVIOR.ACTIVITY
    return {
      behavior: intent,
      trigger: `timer_${intent}`,
      reason: intent === BEHAVIOR.PROACTIVE ? '有由头，主动说一句' : '自己找点事做',
    }
  }

  // 5. 面板来的提问，等同于私聊
  if (event.source === 'panel') {
    return { behavior: BEHAVIOR.REPLY, trigger: 'panel', reason: '面板里问的' }
  }

  // 6. 消息与图片
  if (MESSAGE_KINDS.has(event.kind)) {
    // 没有合法 scope 的消息不猜：猜成私聊就会对该回的话全回、不该回的全回
    if (event.scope !== SCOPE.PRIVATE && event.scope !== SCOPE.GROUP) {
      return { behavior: null, trigger: 'bad_scope', reason: `不认识的会话范围：${event.scope || '(空)'}` }
    }
    const command = typeof ctx.matchCommand === 'function' ? ctx.matchCommand(String(event.payload?.text || '')) : null
    // 主人在群里说「@鱼 重启一下」：既要回话也要执行，执行优先（工具环结束后仍会走 say 回一句）
    if (command && has(event, TAG.IS_OWNER)) {
      return { behavior: BEHAVIOR.ADMIN, trigger: 'owner_command', reason: `主人让做：${command}` }
    }
    if (event.scope === SCOPE.PRIVATE) return { behavior: BEHAVIOR.REPLY, trigger: 'private', reason: '私聊' }
    if (has(event, TAG.AT_ME)) return { behavior: BEHAVIOR.REPLY, trigger: 'at_me', reason: '被 @ 了' }
    // @ 了别人 = 这句话的对象不是它。即使还在 follow-up 窗口、或正文里出现
    // 「你/名字」，也不该把别人的对话接到自己身上。
    const atOthers = Array.isArray(event.payload?.atOthers) ? event.payload.atOthers.filter(Boolean) : []
    if (atOthers.length) {
      return { behavior: null, trigger: 'addressed_to_other', reason: '这条 @ 的是别人，不是深蓝' }
    }
    if (has(event, TAG.MENTIONED_NAME) && ctx.config?.proactive?.nameCall !== false) return { behavior: BEHAVIOR.REPLY, trigger: 'name_called', reason: '名字被叫到' }
    if (has(event, TAG.CALLED)) return { behavior: BEHAVIOR.REPLY, trigger: 'called', reason: '被“在吗/出来”等呼唤' }
    // 注意力账本的判定优先于兴趣词：兴趣词是「我可能想说」，窗口是「对方正在跟我说话」。
    // 后者更硬 —— 同一个群里，两个都成立时不该被算成「看到感兴趣的内容」，
    // 否则统计里「主动接话」和「被搭话」会混成一类，响应率永远算不准。
    if (ctx.attention?.continue) {
      return {
        behavior: BEHAVIOR.REPLY,
        trigger: 'follow_up',
        // 换人接话是「这个人正在对深蓝说」，不是可接可不接的续聊；
        // 后面的接话概率不该再把这一条随机吞掉。
        handoff: Boolean(ctx.attention.handoffFrom),
        reason: ctx.attention.handoffFrom ? `接话换人：${ctx.attention.handoffFrom} 已经停了` : '刚聊过，窗口里接着聊',
      }
    }
    const text = String(event.payload?.text || '')
    const interests = Array.isArray(ctx.config?.group?.interests) ? ctx.config.group.interests : []
    if (interestMatched(text, interests)) {
      return { behavior: BEHAVIOR.REPLY, trigger: 'interest', reason: '看到感兴趣的内容' }
    }
    if (has(event, TAG.FOLLOW_UP)) return { behavior: BEHAVIOR.REPLY, trigger: 'follow_up', reason: '刚聊过，三分钟内接着聊' }
    return { behavior: null, trigger: 'group_not_addressed', reason: '群里没点到，按设计不接' }
  }

  return { behavior: null, trigger: 'unrouted', reason: '没有匹配的行为' }
}

/**
 * 写一条行为记录。行为记录与事件记录分开两个文件，靠 eventId 关联。
 *
 * @param {object} journal  base/journal.mjs 的 Journal 实例
 * @param {object} input
 * @param {string} input.eventId
 * @param {string} input.behavior
 * @param {string} [input.trigger]
 * @param {number} [input.lines]   回了几条
 * @param {number} [input.ms]      花了多久
 * @param {boolean} [input.ok]
 * @param {string} [input.reason]
 * @param {number} [input.at]
 * @returns {{ ok: boolean, row?: object, error?: string }}
 */
export function record(journal, input = {}) {
  const behavior = String(input.behavior || '')
  if (!BEHAVIOR_LIST.includes(behavior)) {
    return { ok: false, error: `未知行为：${behavior || '(空)'}，只能是 ${BEHAVIOR_LIST.join(' / ')}` }
  }
  if (!journal || typeof journal.append !== 'function') {
    return { ok: false, error: '没有可写的日志' }
  }
  // 行为必须挂在一条事件上。没有 eventId 的记录，事后既不能回溯「这是回哪句」，
  // 也没法算出「群里被点到的回了几条」——统计会永久偏一点，且找不到原因。
  const eventId = String(input.eventId || '').trim()
  if (!eventId) {
    return { ok: false, error: '行为要挂在一条事件上：缺 eventId' }
  }
  const result = journal.append({
    kind: 'behavior',
    eventId,
    behavior,
    trigger: String(input.trigger || ''),
    // 会话范围随行为一起落盘：只靠 eventId 反查也能算，但多存一份，
    // 事件日志被轮转清掉之后统计仍然成立
    scope: String(input.scope || ''),
    conversation: String(input.conversation || ''),
    lines: Number(input.lines) || 0,
    ms: Number(input.ms) || 0,
    ok: input.ok !== false,
    reason: String(input.reason || ''),
  })
  if (!result.ok) return { ok: false, error: result.error || '写入失败' }
  return { ok: true, row: result.row }
}
