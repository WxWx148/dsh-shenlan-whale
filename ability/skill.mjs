/**
 * ability/skill.mjs — 这份文件管「他/她会做什么、学会了什么、关掉了什么」。
 *
 * ══════════════════════════════════════════════════════════════
 * 为什么需要这一层（先说清病）
 *
 * 之前「他会什么」是答不出来的，三个具体原因：
 *
 *   1. `tools.whitelist` 留空 = 全部允许。听起来宽松，实际是**黑箱**：
 *      面板不知道该列出哪些工具，因为工具名从来没登记过。用户看到的只有一句
 *      「留空 = 全部允许」，等于什么都没说。
 *   2. 进化在调 `toolWeight[tool]`，起点是空对象。所以他学过什么之前，
 *      面板上一个工具都不显示；学过之后冒出来的是 `toolWeight.http_get`
 *      这种裸名 —— 用户不认识，也不知道那是什么。
 *   3. 「学会了」没有任何记录。用了 1 次成功 1 次算不算会？没人回答得了，
 *      因为连「用过几次」都没记。
 *
 * 所以这里做三件事：
 *   · **登记**：能力必须是清单里的一条，不能是散落在代码里的工具名；
 *   · **鉴权**：清单说「会」不算数，还要现场检查依赖 —— 沙箱关了就说关了，
 *     不能让用户以为会、实际调用时失败；
 *   · **证据**：学会要有次数和成功率。三次成两次叫「还不稳」，不叫「会」。
 *
 * ══════════════════════════════════════════════════════════════
 * 三条硬规矩
 *
 *   1. **默认最小权限**：主人教的、自己学的技能，一律先「关」，等用户点开。
 *      一句话就打开沙箱或主动发消息，是最容易出事的路径。
 *   2. **会 ≠ 能用**：状态是现场算的。沙箱关了、联网白名单空着，
 *      对应技能显示「用不了」并说明原因，而不是假装在。
 *   3. **学不会要退**：连续失败到阈值自动关掉并留原因，不硬撑。
 */

/** 技能从哪来 */
export const SOURCE = Object.freeze({
  BUILTIN: 'builtin', // 出厂就会，改代码才有
  TAUGHT: 'taught', // 主人教的
  LEARNED: 'learned', // 自己从做事里长出来的
})

/** 开关三态。blocked 不是用户选的，是算出来的 */
export const STATE = Object.freeze({
  ON: 'on',
  OFF: 'off',
  BLOCKED: 'blocked',
})

/** 熟练度。回答「学会了没有」只能靠这个，不能靠感觉 */
export const MASTERY = Object.freeze({
  NEW: 'new', // 没用过
  TRYING: 'trying', // 试过，还不够
  LEARNED: 'learned', // 会了
  SOLID: 'solid', // 很熟
})

/**
 * 分组 = 面板上的顺序，也是「这件事属于哪个域」的唯一说法。
 *
 * `domain` 必须落在 truth/taxonomy.mjs 的七个域里（有用例钉住）：
 * 技能分组是「能力」视角的再切分，不能自己另造一套世界。
 */
export const SKILL_GROUPS = Object.freeze([
  { id: 'talk', label: '说话', desc: '怎么开口、说几条、说不说得动人', domain: 'speech' },
  { id: 'know', label: '知道', desc: '记得住谁、想得起什么', domain: 'cognition' },
  { id: 'do', label: '动手', desc: '算账、在沙箱里跑、改东西', domain: 'capability' },
  { id: 'net', label: '上网', desc: '查资料、看网页', domain: 'capability' },
  { id: 'media', label: '看和听', desc: '认图、听语音、发表情', domain: 'capability' },
  { id: 'care', label: '照看', desc: '到点提醒、冷场接话、早上补消息', domain: 'autonomy' },
])

/**
 * 出厂技能清单。
 *
 * 每条必须有 `tools`：那是**进化权重与真实调用共用的键**。
 * 以前权重表里是裸工具名，面板只能显示 `http_get`；现在固定成技能 id，
 * 面板能显示「上网搜一下」，权重也归得到人头上。
 *
 * `needs` 是依赖的权限，用来现场判断「现在到底能不能用」。
 * `risk` 高的（沙箱、主动发消息）打开时要确认。
 */
export const CATALOG = Object.freeze([
  // ── 说话 ──────────────────────────────────────────────────────
  { id: 'talk.reply', name: '接话', what: '有人找他/她，就按人样回一句', group: 'talk', needs: ['channel'], tools: ['reply'], risk: 'low' },
  { id: 'talk.split', name: '拆成几条发', what: '话长了自己断句，不像一段公告', group: 'talk', needs: [], tools: ['split'], risk: 'low' },
  { id: 'talk.tone', name: '看人下语气', what: '对熟人和对陌生人不一样', group: 'talk', needs: ['memory'], tools: ['tone'], risk: 'low' },

  // ── 知道 ──────────────────────────────────────────────────────
  { id: 'know.recall', name: '想起以前的事', what: '聊到旧话题能翻出相关记忆', group: 'know', needs: ['memory'], tools: ['memory_search'], risk: 'low' },
  { id: 'know.people', name: '记得住人', what: '记得谁是谁、上次聊到哪', group: 'know', needs: ['memory'], tools: ['people_lookup'], risk: 'low' },
  { id: 'know.summary', name: '总结群聊', what: '被问「刚才聊了啥」能说清', group: 'know', needs: ['memory'], tools: ['thread_summary'], risk: 'low' },
  { id: 'know.archive', name: '翻旧聊天', what: '「上次那个」能翻出原话', group: 'know', needs: ['memory'], tools: ['recall'], risk: 'low' },
  { id: 'know.dossier', name: '某人的档案', what: '这个人聊过几次、在哪些群、说过什么', group: 'know', needs: ['memory'], tools: ['person_dossier'], risk: 'low' },
  { id: 'know.recap', name: '群聊回顾', what: '这个群最近在聊什么', group: 'know', needs: ['memory'], tools: ['group_recap'], risk: 'low' },
  { id: 'know.who', name: '谁说过', what: '跨群找某句话是谁说的', group: 'know', needs: ['memory'], tools: ['who_said'], risk: 'low' },
  { id: 'know.status', name: '看清自己', what: '在线多久、记得多少、今天说了几句', group: 'know', needs: ['memory'], tools: ['my_status'], risk: 'low' },
  { id: 'know.memory', name: '翻自己的记忆', what: '按事实/人物/想法分类查', group: 'know', needs: ['memory'], tools: ['my_memory', 'my_digest'], risk: 'low' },
  { id: 'know.thoughts', name: '翻自己的想法', what: '自己记下的观点、反省和做过的事', group: 'know', needs: ['memory'], tools: ['my_thoughts', 'my_activities'], risk: 'low' },
  // 5 个写记忆的工具（remember_fact / remember_person / remember_self / revise_self / forget_self）
  // 原来谁都不管：技能页上没有对应的一项，所以关不掉；工具表里却真在跑。
  // 「记住说过的事」把这条补上 —— 它是最常用的能力，本来最该有一个开关。
  { id: 'know.remember', name: '记住说过的事', what: '主人说「记一下」就记住，说「忘了」就删掉', group: 'know', needs: ['memory'], tools: ['remember_fact', 'remember_person', 'remember_self', 'revise_self', 'forget_self'], risk: 'low' },
  { id: 'know.wants', name: '需求本', what: '想要什么记下来，主人来处理', group: 'know', needs: [], tools: ['note_want', 'my_wants', 'resolve_want', 'drop_want'], risk: 'low' },
  { id: 'know.impressions', name: '对群的印象', what: '每个群是干什么的、常聊什么', group: 'know', needs: ['memory'], tools: ['group_impressions'], risk: 'low' },
  { id: 'know.schedule', name: '看排期', what: '现在几点、下次活动、今天还剩多少额度', group: 'know', needs: [], tools: ['my_schedule', 'time'], risk: 'low' },
  { id: 'know.help', name: '说清自己会什么', what: '被问「你会什么」能如实列出来', group: 'know', needs: [], tools: ['my_capabilities', 'owner_commands'], risk: 'low' },
  // 自查复盘不依赖记忆开关：主人让「查代码给结论」时，哪怕长期记忆关着也该能办。
  { id: 'know.selfcheck', name: '自查复盘', what: '主人让查问题就翻记录、给结论、记下待处理的事', group: 'know', needs: [], tools: ['audit_self', 'my_patch_proposals', 'propose_patch', 'close_patch'], risk: 'low' },
  // 灵魂文件：读自己的设定、改自己的设定、翻版本、退回版本。
  // 为什么单独一项而不是塞进「改自己」：改说话习惯（self_tune）和改人格是两件事，
  // 前者只调长度条数，后者动的是「我是谁」，风险和影响面差一个量级。
  // risk 标 medium：改完会留版本、能退回，而且必须告诉主人，不会悄悄改掉。
  { id: 'know.persona', name: '维护自己人设', what: '读自己的设定、改其中一条、记下学到的手感、翻历史版本、退回旧版', group: 'know', needs: [], tools: ['read_persona', 'revise_persona', 'absorb_habit', 'persona_versions', 'rollback_persona'], risk: 'medium' },

  // ── 动手 ──────────────────────────────────────────────────────
  { id: 'do.calc', name: '算数', what: '算账、换单位、比大小', group: 'do', needs: [], tools: ['calc'], risk: 'low' },
  { id: 'do.code', name: '自己写代码跑', what: '要真算一遍的时候，写代码跑出结果', group: 'do', needs: ['sandbox'], tools: ['exec_sandbox'], risk: 'high' },
  { id: 'do.file', name: '读文件', what: '看工作目录里的东西', group: 'do', needs: ['sandbox'], tools: ['file_read'], risk: 'medium' },
  // 「改自己的代码」这一项为什么 risk 标 high：它动的不是聊天内容，是**承载它自己的代码**。
  // 代码能力组里只有这一项能让插件下次起不来，所以不给 medium。
  { id: 'do.dev', name: '改自己的代码', what: '看源码、搜关键词、改文件、跑脚本 —— 改之前会备份，关键启动文件还要额外点头', group: 'do', needs: ['sandbox'], tools: ['code_list', 'code_read', 'code_search', 'code_write', 'code_restore', 'run_command'], risk: 'high' },
  { id: 'do.self', name: '改自己', what: '调自己的说话习惯（不动人格）', group: 'do', needs: [], tools: ['self_tune'], risk: 'medium' },
  { id: 'do.notebook', name: '写本子', what: '想写什么就写，按天存在本地', group: 'do', needs: [], tools: ['write_notebook', 'read_notebook'], risk: 'low' },

  // ── 上网 ──────────────────────────────────────────────────────
  { id: 'net.search', name: '上网搜一下', what: '不知道的事去查，回来只说结论', group: 'net', needs: ['net'], tools: ['web_search'], risk: 'medium' },
  { id: 'net.fetch', name: '打开网页看', what: '给了链接就去看内容', group: 'net', needs: ['net'], tools: ['web_fetch'], risk: 'medium' },
  { id: 'net.news', name: '看热榜', what: '各平台今天在热什么', group: 'net', needs: ['net'], tools: ['news_now', 'hot_news'], risk: 'low' },

  // ── 看和听 ────────────────────────────────────────────────────
  { id: 'media.image', name: '认图', what: '看得懂别人发的图和表情', group: 'media', needs: ['channel'], tools: ['image_read'], risk: 'low' },
  { id: 'media.voice', name: '听语音', what: '语音转成字再回', group: 'media', needs: ['channel'], tools: ['voice_to_text'], risk: 'low' },
  { id: 'media.sticker', name: '发表情', what: '该发表情的时候发一个', group: 'media', needs: ['channel'], tools: ['send_sticker', 'list_stickers', 'save_sticker'], risk: 'low' },
  { id: 'media.face', name: '发小黄脸', what: '聊天框里的 QQ 原生表情', group: 'media', needs: ['channel'], tools: ['send_face'], risk: 'low' },
  { id: 'media.at', name: '群里 @ 人', what: '该找谁说话时 @ 他一下', group: 'media', needs: ['channel'], tools: ['at_person'], risk: 'medium' },
  { id: 'media.forward', name: '展开转发', what: '聊天记录太长时能接着往下看', group: 'media', needs: ['channel'], tools: ['read_forward_more'], risk: 'low' },
  { id: 'media.avatar', name: '看头像', what: '看看这个人的头像是什么样', group: 'media', needs: ['channel'], tools: ['view_avatar'], risk: 'low' },
  { id: 'media.draw', name: '画一张图', what: '描述一句就能画出来发过去', group: 'media', needs: ['channel', 'net'], tools: ['draw_image'], risk: 'medium' },
  { id: 'media.refuse', name: '暂时不理人', what: '被冒犯时可以安静一阵子', group: 'media', needs: ['channel'], tools: ['refuse_person'], risk: 'medium' },


  // ── 照看 ──────────────────────────────────────────────────────
  { id: 'care.remind', name: '到点提醒', what: '「明早八点叫我」这种能记住', group: 'care', needs: ['channel'], tools: ['remind', 'set_reminder'], risk: 'low' },
  { id: 'care.proactive', name: '主动开口', what: '有由头的时候先说一句', group: 'care', needs: ['channel', 'activity'], tools: ['proactive'], risk: 'medium' },
  { id: 'care.digest', name: '每日简报', what: '一天一次，说清发生了什么', group: 'care', needs: ['channel', 'activity'], tools: ['digest'], risk: 'low' },
])

/** 出厂清单按 id 索引，供 O(1) 查 */
const BY_ID = new Map(CATALOG.map((skill) => [skill.id, skill]))

/** 上限：不能无限长。教得太多，面板又回到「看不完」的老路 */
export const LIMITS = Object.freeze({
  taught: 60, // 教的 + 自学的最多这么多（面板可改，这里是默认值）
  nameChars: 20,
  whatChars: 60,
})

/** 连续失败这么多次自动关掉，不硬撑（面板可改，这里只是默认值，不对外公开） */
const FAIL_STREAK_LIMIT = 3

/**
 * 已经接上执行器的工具名。
 *
 * 为什么必须有这张表：`tools` 字段只说明「这一项要用什么」，**不等于「那个东西真的能调」**。
 * 光凭 CATALOG 就说「会 18 项」，而底下没有任何实现，就是把清单当成了能力：
 * 用户照着清单去用，然后什么都没发生 —— 这比说「还不会」伤人得多。
 *
 * 谁往里加：真正实现能力的模块（通道、生成、沙箱执行器）初始化时调 registerTools()。
 * 默认**空**，方向是 fail-closed：忘了注册就显示「还没接上」，而不是假装会用。
 * 宁可让面板说「现在什么都不会」，也不要让它说「会」然后做不到。
 */
const IMPLEMENTED = new Set()

/** 注册已经能调的工具。返回这次新加进去的名字（重复注册不算失败） */
export function registerTools(names = []) {
  const added = []
  for (const raw of names) {
    const name = String(raw || '').trim()
    if (!name || IMPLEMENTED.has(name)) continue
    IMPLEMENTED.add(name)
    added.push(name)
  }
  return added
}

/** 当前已接上的工具名（面板与测试对账用） */
export function implementedTools() {
  return [...IMPLEMENTED]
}

/** 这一项还缺哪些没有实现的工具 */
export function missingImpl(skill, impl = IMPLEMENTED) {
  const need = Array.isArray(skill?.tools) ? skill.tools.filter(Boolean) : []
  // 教出来的技能把「自己的 id」写进 tools（teach 里就是这么写的），
  // 那只是给权重表用的虚拟键，底下并没有一个叫 `taught.3` 的执行器。
  // 把它当真实依赖，会让所有教过的技能永远显示「用不了」—— 那是误判，不是保护。
  const real = need.filter((name) => name !== skill?.id)
  if (!real.length) return []
  const pool = impl instanceof Set ? impl : new Set(impl || [])
  return real.filter((name) => !pool.has(name))
}

/** 出厂清单用到的全部工具名。用它和 IMPLEMENTED 对账，就知道还差多少没接 */
export function allToolNames() {
  return [...new Set(CATALOG.flatMap((skill) => skill.tools || []))]
}

/**
 * 工具 → 谁在用它。
 *
 * 这张表是「工具层」和「技能层」唯一的关系，两件事都靠它：
 *   · 技能页关掉一项，要反查出该拦哪些工具（blockedTools）；
 *   · 模型调一次工具，要知道该给哪一项记一笔使用次数（mastery 的证据）。
 * 以前只有前一半有实现，后一半是空的 —— 于是「知道」那组永远显示「没试过」。
 *
 * 教的技能会把自己的 id 写进 tools，那不是真执行器，这里排除。
 */
export function toolOwners(skills = CATALOG) {
  const owners = new Map()
  for (const skill of skills || []) {
    for (const tool of skill?.tools || []) {
      if (!tool || tool === skill?.id) continue
      if (!owners.has(tool)) owners.set(tool, [])
      owners.get(tool).push(skill)
    }
  }
  return owners
}

/**
 * 一个工具归哪一项技能。没有归属就返回空串 —— 调用方据此跳过记账，
 * 而不是拿工具名去 find() 一个不存在的技能（`record` 会静默失败，谁也看不见）。
 */
export function skillIdOfTool(name, skills = CATALOG) {
  const owners = toolOwners(skills).get(String(name || ''))
  if (!owners || !owners.length) return ''
  return owners[0].id
}

/**
 * 当前有哪些权限是真的可用的。
 * 这是「说会」和「真能用」之间那道检查 —— 清单不能自己给自己作证。
 *
 * 注意 `net`：白名单留空等于**一律拒绝**（只允许这些域名，没有允许的就是全拒）。
 * 而 `tools.whitelist` 留空等于**全部允许**。两个空值的含义正好相反，
 * 这是最容易被误解的一处，所以在面板文案里必须写清。
 */
export function resolveNeeds(config = {}) {
  const netList = Array.isArray(config.net?.allowlist) ? config.net.allowlist.filter(Boolean) : []
  return {
    channel: config.channel?.enabled === true,
    memory: config.memory?.enabled === true,
    activity: config.activity?.enabled === true,
    net: netList.length > 0 && Number(config.net?.quotaPerHour ?? 0) > 0,
    sandbox: config.sandbox?.mode !== 'off' && Number(config.sandbox?.dailyMax ?? 0) > 0,
  }
}

/** 依赖没满足时，人话怎么说。必须具体到「去改哪一项」 */
const NEED_HINT = Object.freeze({
  channel: 'QQ 通道关着，他/她收不到也发不出',
  memory: '长期记忆关着，他/她想不起以前的事',
  activity: '自主活动关着，他/她不会自己找事做',
  net: '联网白名单是空的（空着等于全都不许），加一个域名才能上网',
  sandbox: '沙箱关着，或者每天的次数上限是 0',
})

/**
 * 工具白名单这层单独查。
 *
 * 为什么不能只靠 needs：needs 说的是「权限类别」（联网/沙箱/记忆），
 * 而 `tools.whitelist` 是**另一个闸门**，按具体工具名放行。两处都开才真能用。
 * 少查这一层，就会出现最坏的那种谎：技能页说「会」，一调用就被白名单挡回去。
 */
export function toolsAllowed(skill, config = {}) {
  const list = Array.isArray(config.tools?.whitelist) ? config.tools.whitelist.filter(Boolean) : []
  if (list.length === 0) return { ok: true, why: '' } // 留空 = 全部允许
  const missing = (skill.tools || []).filter((tool) => !list.includes(tool))
  if (missing.length === 0) return { ok: true, why: '' }
  return { ok: false, why: `工具白名单里没有 ${missing[0]}，把它加进去才能用` }
}

/**
 * 一个技能的当前状态：用户开没开 + 依赖够不够。两个都满足才是 on。
 * @returns {{state: string, why: string}}
 */
/**
 * 这条文字是不是已经被编码坏成了问号。
 *
 * 线上真实踩过：教出来的技能在 skills.json 里存成 `name: "????"`、`what: "??"`，
 * 面板上就显示四个问号，谁也认不出那是什么。损坏发生在**到达服务端之前**
 * （终端/脚本按 ANSI 码页转了一道），代码这边无法还原，只做两件事：
 *   · 不让新的乱码再存进来（teach 里挡一道）；
 *   · 已经坏了的明确标出来，而不是当成一条正常技能挂着。
 */
export function looksBroken(value) {
  const text = String(value || '').trim()
  if (!text) return false
  // 全是问号（半角/全角）或替换字符，且至少两个 —— 一个问号可能是真问句
  if (text.length < 2) return false
  return /^[?\uFFFD？]+$/.test(text)
}

export function stateOf(skill, { config = {}, states = {}, impl = IMPLEMENTED } = {}) {
  // 先算「底层有没有」，因为后面每个分支都要带上这个事实。
  // wired=false 表示这一项声明了要用某个工具，但那个工具还没有实现。
  const noImpl = missingImpl(skill, impl)
  const wired = noImpl.length === 0

  const picked = states[skill.id]
  if (picked === STATE.OFF) return { state: STATE.OFF, why: '你关掉了', wired }

  // 名字已经坏成问号：这条技能实际上不可用，也不可能被叫对。
  // 直接说清「删掉重教」，别让用户对着四个问号猜。
  if (looksBroken(skill.name)) {
    return { state: STATE.BLOCKED, why: '这条的名字是乱码（问号），认不出是什么，删掉重教一次', wired }
  }

  // 第一道：底层有没有这个东西。放在权限之前，是因为它**用户改不了**——
  // 先让人去开白名单、开沙箱，开完发现仍然不能用，那是二次伤害。
  // 顺序在这里是产品判断，不是代码风格。
  if (!wired) {
    return { state: STATE.BLOCKED, why: `还没接上：${noImpl.join('、')}`, wired }
  }

  const needs = resolveNeeds(config)
  const missing = (skill.needs || []).filter((need) => needs[need] !== true)
  if (missing.length) {
    return { state: STATE.BLOCKED, why: NEED_HINT[missing[0]] || `缺 ${missing.join('、')}`, wired }
  }
  // 权限类别够了，还要过工具白名单 —— 两个闸门是「与」，不是「或」
  const gate = toolsAllowed(skill, config)
  if (!gate.ok) return { state: STATE.BLOCKED, why: gate.why, wired }
  // 教的、自学的默认是关的，必须显式点开 —— 最小权限
  const defaultOn = skill.source === SOURCE.BUILTIN || skill.source === undefined
  if (picked === STATE.ON) return { state: STATE.ON, why: '能用', wired }
  return defaultOn
    ? { state: STATE.ON, why: '出厂就会', wired }
    : { state: STATE.OFF, why: '还没打开，点一下就能用', wired }
}

/**
 * 熟练度。这是「学会了没有」唯一诚实的算法。
 *
 * 为什么不用「用过就算会」：一次成功可能只是运气，用户信了这句话，
 * 下次让他/她做就会失望。所以要求次数 + 成功率两个门槛。
 */
export function masteryOf(record) {
  // 钳一下：手改坏的文件里可能写着 uses: -5 / ok: 99，
  // 不钳的话成功率会算出 -1980%，面板上就成了「成功率 -1980%」这种笑话。
  const uses = Math.max(0, Number(record?.uses) || 0)
  const ok = Math.min(uses, Math.max(0, Number(record?.ok) || 0))
  if (uses === 0) return { level: MASTERY.NEW, rate: null, why: '还没试过' }
  const rate = ok / uses
  if (uses >= 10 && rate >= 0.8) return { level: MASTERY.SOLID, rate, why: `${uses} 次里成 ${ok} 次，很稳` }
  if (uses >= 3 && rate >= 0.6) return { level: MASTERY.LEARNED, rate, why: `${uses} 次里成 ${ok} 次，会了` }
  return { level: MASTERY.TRYING, rate, why: `${uses} 次只成 ${ok} 次，还不稳` }
}

const MASTERY_LABEL = Object.freeze({
  [MASTERY.NEW]: '没试过',
  [MASTERY.TRYING]: '在学',
  [MASTERY.LEARNED]: '学会了',
  [MASTERY.SOLID]: '很熟',
})

/**
 * 被用户关掉的技能，连带它底下那几个工具名。
 *
 * 为什么需要它：技能页上一个个开关，关掉之后如果执行层照跑，
 * 那这个开关就只是一行字 —— 用户以为关了，模型照样联网、照样在沙箱里跑。
 * 这里按「工具 → 谁在用它」反查：某个工具名下**所有**技能都关着，才算这个工具关掉；
 * 只要还有一项开着（比如两个技能都用 web_search），就不拦。
 *
 * 只认「明确关掉」（state === OFF）。BLOCKED 是「缺权限/还没接上」，
 * 那是另一件事，由 call() 的白名单与 needs 去拦，不在这里重复判。
 *
 * @param {{config?: object, states?: object, impl?: Set<string>, skills?: object[]}} input
 * @returns {Set<string>} 关掉的工具名
 */
export function blockedTools({ config = {}, states = {}, impl = IMPLEMENTED, skills = [] } = {}) {
  const owners = new Map()
  for (const skill of skills) {
    for (const tool of skill?.tools || []) {
      // 教出来的技能会把自己的 id 写进 tools，那不是真执行器（见 missingImpl）
      if (!tool || tool === skill?.id) continue
      if (!owners.has(tool)) owners.set(tool, [])
      owners.get(tool).push(skill)
    }
  }
  const blocked = new Set()
  for (const [tool, list] of owners) {
    const anyOn = list.some((skill) => stateOf(skill, { config, states, impl }).state !== STATE.OFF)
    if (!anyOn) blocked.add(tool)
  }
  return blocked
}

/**
 * 技能簿：管清单、开关、教与学、证据。
 *
 * 存一个 JSON 就够，不需要数据库：
 *   { states: {id: 'off'}, taught: [...], stats: {id: {uses, ok, fail, firstAt, lastAt}}, failStreak: {id: n} }
 */
export class SkillBook {
  /** 缓存上一份视图。技能清单是纯函数产物，只有「开关/教过的/用过一次」会变 */
  #cache = null
  #rev = 0

  /**
   * 标一次「变了」。
   *
   * 为什么要这个：面板一次刷新要问三遍「会什么」——
   * 状态页要计数、技能区要分组、权重区要名字。三遍都从 CATALOG 重新跑一遍
   * stateOf（里面查配置、比白名单），37 项 × 3 遍。缓存按这个版本号失效，
   * 谁改了技能簿就 +1，谁也别想读到旧清单。
   */
  #bump() {
    this.#rev += 1
    this.#cache = null
  }

  /**
   * 外部配置变了，让视图缓存作废。
   *
   * 为什么不能只靠 `view()` 里的 `snapshot.config !== config`：
   * 配置对象在进程里是**就地改**的（applyInto 不换身份，见 config.mjs），
   * 改完还是同一个引用，这个比较永远是 false。结果就是面板先看过一次技能页，
   * 之后在设置里放开白名单 / 关掉记忆 / 改工具白名单，技能清单一直停在旧状态，
   * 除非重启。现在由 Runtime 在每次配置变更时调一次，缓存按「变了」失效，
   * 而不是按「对象换没换」猜。
   */
  invalidate() {
    this.#bump()
  }

  /**
   * @param {object} input
   * @param {object|null} input.data 从 skills.json 读回来的
   * @param {Function} [input.now]
   */
  constructor(input = {}) {
    const raw = input.data && typeof input.data === 'object' ? input.data : {}
    this.now = typeof input.now === 'function' ? input.now : () => Date.now()
    this.states = { ...(raw.states && typeof raw.states === 'object' ? raw.states : {}) }
    // 去重：手改坏或两次写入撞在一起时会出现重复 id。
    // 不去重的话第二条永远访问不到（find 只返回第一个），却照样占着名额、显示在列表里 ——
    // 用户看到两条同名技能，改一个没反应，改另一个才有，谁也查不明白。
    const seen = new Set()
    this.taught = (Array.isArray(raw.taught) ? raw.taught : []).filter((row) => {
      if (!row || !row.id || seen.has(row.id)) return false
      seen.add(row.id)
      return true
    })
    this.stats = { ...(raw.stats && typeof raw.stats === 'object' ? raw.stats : {}) }
    this.failStreak = { ...(raw.failStreak && typeof raw.failStreak === 'object' ? raw.failStreak : {}) }
    // 自增序号：**不能用 taught.length**。忘掉中间一个之后长度回退，
    // 新建的 id 就会和还活着的最后一条撞车，find() 于是读到别人的名字。
    this.seq = Number(raw.seq) || this.taught.reduce((max, row) => {
      const n = Number(String(row.id).replace(/^taught\./, ''))
      return Number.isFinite(n) ? Math.max(max, n) : max
    }, 0)
    // 坏数据自愈：states 里出现非三态的值，直接丢掉 —— 一个手改坏的文件不该让技能全乱
    for (const [id, value] of Object.entries(this.states)) {
      if (value !== STATE.ON && value !== STATE.OFF) delete this.states[id]
    }
    this.configure(input.options || {})
  }

  /**
   * 面板上的数字要真管用。
   *
   * 上一版把 `autoOffAfterFails` 与 `maxTaught` 写死在模块常量里，
   * 面板能改、改完没反应 —— 和上轮修的「maxParts 允许 1–8 实际夹 4」是同一个病。
   * 阈值收口成一处：全从 options 来，模块常量只做默认值。
   */
  configure(options = {}) {
    const fails = Number(options.autoOffAfterFails)
    // 0 是合法值（永远不自动关），所以不能用 `|| 默认`，那会把 0 吃掉
    this.failStreakLimit = Number.isFinite(fails) && fails >= 0 ? Math.min(10, fails) : FAIL_STREAK_LIMIT
    const max = Number(options.maxTaught)
    this.maxTaught = Number.isFinite(max) && max >= 1 ? Math.min(200, max) : LIMITS.taught
    // 阈值只影响「下次记录时怎么判」，但面板上那句「连续失败几次自动关」跟着它变，
    // 缓存必须一起作废，否则改了设置面板还显示旧数。
    this.#bump()
    return this
  }

  /** 全部技能 = 出厂 + 教的。同一 id 以教的为准（教可以覆盖出厂的说法） */
  list() {
    return [...CATALOG, ...this.taught.map((row) => ({ ...row, source: SOURCE.TAUGHT }))].map((skill) => ({
      ...skill,
      source: skill.source || SOURCE.BUILTIN,
    }))
  }

  /** 找一条 */
  find(id) {
    const key = String(id || '')
    const taught = this.taught.find((row) => row.id === key)
    if (taught) return { ...taught, source: SOURCE.TAUGHT }
    const builtin = BY_ID.get(key)
    return builtin ? { ...builtin, source: SOURCE.BUILTIN } : null
  }

  /** 打开 / 关掉。**教的技能打开高危项要确认**，这条不能省 */
  setState(id, state, options = {}) {
    const skill = this.find(id)
    if (!skill) return { ok: false, error: `没有这个技能：${id || '(空)'}` }
    const next = String(state || '')
    if (next !== STATE.ON && next !== STATE.OFF) {
      return { ok: false, error: '只能设成开或关' }
    }
    if (next === STATE.ON && skill.risk === 'high' && options.confirm !== true) {
      return { ok: false, needConfirm: true, error: `${skill.name} 能直接动手，打开前需要再确认一次` }
    }
    this.states[id] = next
    if (next === STATE.OFF) this.failStreak[id] = 0
    this.#bump()
    return { ok: true, id, state: next, skill }
  }

  /**
   * 教一个新技能。**默认是关的**：一句话就打开一个能力，是这里最危险的路径。
   */
  teach(input = {}) {
    // 换行必须压成空格：名字会被当成面板上的标题渲染，
    // 带一个换行就能把整行挤歪，而用户根本看不出来自己输了什么。
    const name = String(input.name || '').replace(/\s+/g, ' ').trim()
    if (!name) return { ok: false, error: '得给这个技能起个名字' }
    if (looksBroken(name)) {
      return { ok: false, error: '这个名字收到的是一串问号，编码在路上坏了。请在面板输入框里重新输入中文（别从终端/脚本里发）' }
    }
    if (name.length > LIMITS.nameChars) {
      return { ok: false, error: `名字太长了（上限 ${LIMITS.nameChars} 字）` }
    }
    if (this.taught.length >= this.maxTaught) {
      return { ok: false, error: `教的技能已经到上限 ${this.maxTaught} 个了，先忘掉几个` }
    }
    // 重名不新建，直接返回原来那条：用户重复说同一件事不该长出一堆副本
    const exists = this.taught.find((row) => row.name === name)
    if (exists) return { ok: true, id: exists.id, duplicate: true, skill: exists }

    const what = String(input.what || '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.whatChars)
    const group = SKILL_GROUPS.some((g) => g.id === input.group) ? input.group : 'do'
    const needs = Array.isArray(input.needs) ? input.needs.filter((need) => need in resolveNeeds({})) : []
    this.seq += 1
    const id = `taught.${this.seq}`
    const row = {
      id,
      name,
      what: what || '主人教的，具体做什么看他/她怎么理解',
      group,
      needs,
      tools: [id],
      risk: input.risk === 'high' ? 'high' : 'low',
      steps: Array.isArray(input.steps) ? input.steps.map(String).slice(0, 8) : [],
      taughtAt: this.now(),
    }
    this.taught.push(row)
    // 教完先关着，等用户点开 —— 最小权限
    this.states[id] = STATE.OFF
    this.#bump()
    return { ok: true, id, skill: { ...row, source: SOURCE.TAUGHT } }
  }

  /** 忘掉。出厂的忘不掉，只能关 —— 代码里还在，说忘了就是骗人 */
  forget(id) {
    const index = this.taught.findIndex((row) => row.id === id)
    if (index < 0) {
      return { ok: false, error: BY_ID.has(id) ? '出厂技能忘不掉，只能关掉' : `没有这个技能：${id || '(空)'}` }
    }
    const [removed] = this.taught.splice(index, 1)
    delete this.states[id]
    delete this.stats[id]
    delete this.failStreak[id]
    this.#bump()
    return { ok: true, removed }
  }

  /**
   * 改一条教过的技能。
   *
   * 为什么需要它：教的时候名字是在输入框里现打的，打错了、粘进来乱码了，
   * 之前唯一的出路是「忘掉重教」—— 而重教会换一个新 id，`states`/`stats`
   * （开关状态、用过几次、成功率）全部归零。用户只是想改一个错字，
   * 却要付出「这条的履历清零」的代价，这不合理。
   *
   * 只改「说法」（名字/说明/分组/步骤），不动 id、不动 tools、不动证据。
   * 出厂技能不给改：它在代码里，改了下次启动就变回去，那才是真的骗人。
   *
   * 乱码这一条要特别放行：`looksBroken` 的名字**允许**用 amend 覆盖掉
   * （这正是它存在的意义 —— 把坏名字换成好名字），但新名字本身不能还是乱码。
   */
  amend(id, patch = {}) {
    const key = String(id || '')
    const index = this.taught.findIndex((row) => row.id === key)
    if (index < 0) {
      return { ok: false, error: BY_ID.has(key) ? '出厂技能改不了，只能关掉' : `没有这个技能：${key || '(空)'}` }
    }
    const before = this.taught[index]
    const next = { ...before }

    if (patch.name !== undefined) {
      const name = String(patch.name || '').replace(/\s+/g, ' ').trim()
      if (!name) return { ok: false, error: '名字不能空着' }
      if (looksBroken(name)) {
        return { ok: false, error: '这个名字收到的还是一串问号，编码在路上坏了。请在面板输入框里重新输入中文' }
      }
      if (name.length > LIMITS.nameChars) return { ok: false, error: `名字太长了（上限 ${LIMITS.nameChars} 字）` }
      // 重名会让面板出现两条一样的，`find` 只认第一条，改哪条都改不对
      if (this.taught.some((row) => row.id !== key && row.name === name)) {
        return { ok: false, error: `已经有一条叫「${name}」的技能了` }
      }
      next.name = name
    }

    if (patch.what !== undefined) {
      const what = String(patch.what || '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.whatChars)
      next.what = what || '主人教的，具体做什么看他/她怎么理解'
    }

    if (patch.group !== undefined && SKILL_GROUPS.some((group) => group.id === patch.group)) {
      next.group = patch.group
    }

    if (Array.isArray(patch.steps)) next.steps = patch.steps.map(String).slice(0, 8)

    if (next.name === before.name && next.what === before.what && next.group === before.group) {
      return { ok: true, id: key, changed: false, skill: { ...next, source: SOURCE.TAUGHT } }
    }

    this.taught[index] = next
    this.#bump()
    return {
      ok: true,
      id: key,
      changed: true,
      before: { name: before.name, what: before.what, group: before.group },
      skill: { ...next, source: SOURCE.TAUGHT },
    }
  }

  /**
   * 记一次使用结果。这是「学会」的证据来源，别处不要自己算。
   *
   * 连续失败到阈值会把技能自动关掉并返回 `autoOff`，让调用方写一条审计——
   * 「以为会、其实一直失败」比不会更糟。
   */
  record(id, ok) {
    const skill = this.find(id)
    if (!skill) return { ok: false, error: `没有这个技能：${id || '(空)'}` }
    const at = this.now()
    const row = this.stats[id] || { uses: 0, ok: 0, fail: 0, firstAt: at, lastAt: at }
    row.uses += 1
    row.lastAt = at
    if (ok) {
      row.ok += 1
      row.firstOkAt = row.firstOkAt || at
      this.failStreak[id] = 0
    } else {
      row.fail += 1
      this.failStreak[id] = (Number(this.failStreak[id]) || 0) + 1
    }
    this.stats[id] = row

    let autoOff = false
    // 0 表示永不自动关：用户明确要「失败了也别管」时，不能替他/她做主
    if (this.failStreakLimit > 0 && this.failStreak[id] >= this.failStreakLimit && this.states[id] !== STATE.OFF) {
      this.states[id] = STATE.OFF
      autoOff = true
    }
    this.#bump()
    return {
      ok: true,
      id,
      mastery: masteryOf(row),
      autoOff,
      why: autoOff ? `连续失败 ${this.failStreak[id]} 次，已经先关掉了` : '',
    }
  }

  /** 学到哪了 —— 归纳层用它判断「最近有没有长新东西」 */
  learnedSince(at) {
    const since = Number(at) || 0
    return this.list().filter((skill) => {
      const row = this.stats[skill.id]
      return row?.firstOkAt && row.firstOkAt >= since
    })
  }

  /**
   * 面板要的东西。一次算完，别让前端自己拼。
   *
   * 分三块，对应「他会哪些、学会了哪些、为什么有的一直不开」：
   *   groups  按用途分组，每项带状态与熟练度
   *   learned 最近学会的（有首胜时间的）
   *   blocked 现在用不了的 + 具体原因
   */
  view({ config = {}, at = this.now(), impl = IMPLEMENTED } = {}) {
    // 三项决定「清单会不会变」：谁改了技能簿（rev）、配置是不是另一份对象、
    // 接了哪些工具（impl.size 只增不减，够用且不必每次遍历一遍 Set）。
    // 注意：配置就地改时对象不会换，那份判断挡不住；失效由 invalidate() 兜住。
    const implSize = impl && typeof impl.size === 'number' ? impl.size : -1
    let snapshot = this.#cache
    if (!snapshot || snapshot.rev !== this.#rev || snapshot.config !== config || snapshot.implSize !== implSize) {
      const items = this.list().map((skill) => {
        const state = stateOf(skill, { config, states: this.states, impl })
        const record = this.stats[skill.id] || null
        const mastery = masteryOf(record)
        return {
          id: skill.id,
          name: skill.name,
          what: skill.what,
          group: skill.group,
          source: skill.source,
          risk: skill.risk,
          state: state.state,
          why: state.why,
          // 底层接没接上。面板据此把「还没接上」和「你关掉了」分开显示 ——
          // 前者用户做什么都没用，后者他/她自己点一下就行，两件事不该长同一张脸。
          wired: state.wired !== false,
          uses: Number(record?.uses) || 0,
          rate: mastery.rate,
          mastery: mastery.level,
          masteryLabel: MASTERY_LABEL[mastery.level],
          masteryWhy: mastery.why,
          canForget: skill.source === SOURCE.TAUGHT,
        }
      })

      const groups = SKILL_GROUPS.map((group) => ({
        id: group.id,
        label: group.label,
        desc: group.desc,
        items: items.filter((item) => item.group === group.id),
      })).filter((group) => group.items.length > 0)

      snapshot = {
        rev: this.#rev,
        config,
        implSize,
        items,
        groups,
        counts: {
          total: items.length,
          on: items.filter((item) => item.state === STATE.ON).length,
          off: items.filter((item) => item.state === STATE.OFF).length,
          blocked: items.filter((item) => item.state === STATE.BLOCKED).length,
          // 用不了的里面，有多少是「用户改不了」的（还没接上）
          notWired: items.filter((item) => item.wired === false).length,
          learned: items.filter((item) => item.mastery === MASTERY.LEARNED || item.mastery === MASTERY.SOLID).length,
          taught: this.taught.length,
          builtin: items.filter((item) => item.source === SOURCE.BUILTIN).length,
          self: items.filter((item) => item.source === SOURCE.TAUGHT).length,
        },
      }
      this.#cache = snapshot
    }

    const { items, groups, counts } = snapshot
    // 「最近一周学会的」跟时间走，不跟清单走：从缓存的项目里现算，
    // 免得一份缓存把「七天内」冻在第一次打开面板的那一刻。
    const weekAgo = Number(at) - 7 * 24 * 3600 * 1000
    const learned = items
      .filter((item) => Number(this.stats[item.id]?.firstOkAt) >= weekAgo)
      .sort((a, b) => Number(this.stats[b.id]?.firstOkAt) - Number(this.stats[a.id]?.firstOkAt))

    return {
      groups,
      learned,
      blocked: items.filter((item) => item.state === STATE.BLOCKED),
      counts,
    }
  }

  /** 一句话总结。内部会算一遍 view；已有 view 的调用方请直接用 lineOf(view) */
  line(options = {}) {
    return lineOf(this.view(options))
  }

  /** 落盘用 */
  toJSON() {
    return {
      seq: this.seq,
      states: { ...this.states },
      taught: this.taught.map((row) => ({ ...row })),
      stats: { ...this.stats },
      failStreak: { ...this.failStreak },
    }
  }
}

/**
 * 从已经算好的视图里取那一句话。
 *
 * 单独拆出来是因为 `skills()` 既要整个视图、又要这句话；
 * 走 `book.line()` 会把 18 项状态重算一遍，而状态里有配置解析与白名单比对 ——
 * 一份数据算两次，除了慢，还容易在两次之间被改出不一致。
 */
export function lineOf(view) {
  const { counts } = view || {}
  if (!counts || counts.total === 0) return '还没有登记任何技能'
  const parts = [`会 ${counts.on} 项`]
  if (counts.learned) parts.push(`其中练熟了 ${counts.learned} 项`)
  if (counts.blocked) {
    // 「还没接上」和「权限不够」要分开说：前者等更新，后者他自己点两下就好，
    // 混成一句「用不了」，他会一直去找那个并不存在的权限开关。
    const notWired = Number(counts.notWired) || 0
    parts.push(notWired >= counts.blocked ? `${counts.blocked} 项还没接上` : `${counts.blocked} 项用不了`)
  }
  if (counts.taught) parts.push(`你教了 ${counts.taught} 项`)
  return parts.join('，')
}

/**
 * 已开启的「教出来的技能」写进提示词的一行。
 *
 * 为什么必须有这一段：教技能的完整链路是「教 → 打开 → 生效」，
 * 而「生效」这一步以前是断的 —— 技能清单只出现在面板和「你会什么」的回答里，
 * **从来不进提示词**。结果是主人教了「每天早上问好」，在面板里看到它亮着，
 * 但模型压根不知道有这回事：该早问的时候不早问，问了也不按教的做。
 * 「教了等于没教」是这类产品最伤的一种失败：用户看不出哪里不对，
 * 只觉得「这玩意儿学不进去」。
 *
 * 为什么只取教出来的：出厂技能的行为都由具体工具承载，而工具名已经在
 * 「可用工具：」那一行里了 —— 再抄一遍只是让提示词变长。教出来的技能没有工具，
 * 它的内容就是那句说明本身，所以必须原样交给模型。
 *
 * 预算：最多 6 条、每条 60 字。超了就是又把它写成文章了。
 */
export function promptLineOf(view) {
  const groups = Array.isArray(view?.groups) ? view.groups : []
  const lines = []
  for (const group of groups) {
    for (const item of Array.isArray(group?.items) ? group.items : []) {
      if (item.source !== SOURCE.TAUGHT) continue
      if (item.state !== STATE.ON) continue
      const name = String(item.name || '').trim()
      if (!name) continue
      const what = String(item.what || '').trim()
      // 说明是主人写的，可能很长；截断时不要把话说一半
      lines.push(what ? `- ${name}：${what.slice(0, 60)}` : `- ${name}`)
      if (lines.length >= 6) break
    }
    if (lines.length >= 6) break
  }
  if (!lines.length) return ''
  return ['主人教过你这几件事，做的时候按这个来：', ...lines].join('\n')
}

/**
 * 能直接说给对方听的一段话。
 *
 * 为什么要有这个：用户不该为了知道「他会什么」专门去开面板。
 * 在 QQ 里问一句「你会什么」，就该收到这几行。
 *
 * 预算（和 style.mjs 一致）：最多 5 行。
 *   1 行总计 + 最多 3 行分组 + 1 行「剩下的去哪看」。
 *
 * 两个刻意的取舍：
 *   · 一行最多 4 个名字。塞十个只是让读的人觉得「好多」，一个都记不住 ——
 *     那和给一张长清单没区别，等于没回答。
 *   · 分组装不下时**不假装全说了**，明确告诉他/她还有几类在面板里。
 *     少说一句比说完再漏掉一半可信。
 */
export function brief(view) {
  const { counts, groups } = view || {}
  if (!counts || counts.total === 0) return ['还没学会什么，刚起步']

  // 一项都用不了时，不要先报「会 0 项」再补一句解释 —— 那是报表的口吻。
  // 一句话说清现状和原因就够了，而且原因要分开：用户能改的，和用户改不了的。
  if (counts.on === 0) {
    const notWired = Number(counts.notWired) || 0
    if (notWired) return [`现在 ${counts.total} 项都还用不了，底层还没接上`, '接好之后会自己出现在这里']
    return [`现在 ${counts.total} 项都用不了，是权限没开`, '去面板的技能页看看缺哪一项']
  }

  const head = [`会 ${counts.on} 项`]
  if (counts.learned) head.push(`其中 ${counts.learned} 项练熟了`)
  if (counts.taught) head.push(`你教过 ${counts.taught} 项`)
  const lines = [head.join('，')]

  const usable = (groups || []).filter((group) => group.items.some((item) => item.state === STATE.ON))
  const ROOM = 3
  for (const group of usable.slice(0, ROOM)) {
    const names = group.items
      .filter((item) => item.state === STATE.ON)
      .slice(0, 4)
      .map((item) => item.name)
    lines.push(`${group.label}：${names.join('、')}`)
  }

  const rest = []
  if (usable.length > ROOM) rest.push(`还有 ${usable.length - ROOM} 类`)
  // 不在这里断言原因：没接上和权限不够都是「用不了」，具体哪一种去面板看
  if (counts.blocked) rest.push(`${counts.blocked} 项还用不了`)
  if (rest.length) lines.push(rest.join('，') + '，在面板的技能页里')
  else if (usable.length <= ROOM) lines.push('想看全部在面板的技能页里')

  return lines.slice(0, 5)
}

/**
 * 把进化学到的工具权重按技能归位。
 *
 * 为什么需要这一步：`toolWeight` 的键以前是裸工具名（`http_get`），
 * 面板拿到的是一堆英文；而且工具改名后权重就成孤儿，永远对不上人。
 * 现在按技能的 `tools` 归位，面板显示「上网搜一下 · 手感 1.3」。
 *
 * 对不上任何技能的键单独列出来，不静默丢弃 —— 那是「有个能力没登记」的证据。
 */
export function bindWeights(weights = {}, skills = []) {
  const byTool = new Map()
  for (const skill of skills) {
    for (const tool of skill.tools || []) byTool.set(tool, skill)
  }
  const rows = []
  const orphans = []
  for (const [tool, value] of Object.entries(weights || {})) {
    const skill = byTool.get(tool)
    const score = Number(value)
    if (!skill) {
      orphans.push({ tool, score })
      continue
    }
    rows.push({
      id: skill.id,
      name: skill.name,
      tool,
      score,
      // 1 是基准。1.3 表示比一般能力更常被选中，0.6 表示他/她不太爱用
      trend: score > 1.05 ? '更常用' : score < 0.95 ? '不太用' : '正常',
    })
  }
  rows.sort((a, b) => b.score - a.score)
  return { rows, orphans }
}
