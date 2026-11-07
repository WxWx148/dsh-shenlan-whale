/**
 * 人话层（say）—— 所有出站内容的唯一出口。
 *
 * 规矩只有三条：
 *   1. 用户默认只看到「做了什么 / 结果怎样 / 下一步」，永远不是代码；
 *   2. 代码只在面板第三层展开，QQ 通道只发一句话；
 *   3. 要在沙箱里跑之前必须先交「人话计划」，没有计划就不许执行。
 *
 * 这一层不认识任何具体工具：工具自己提供 label / plan / artifact，
 * 这里只负责翻译、分级、兜底。
 */

/** 常见故障 → 人话。顺序敏感：具体在前，笼统在后。 */
const REASONS = [
  {
    re: /SANDBOX_DENY|静态检查未通过/,
    title: '被安全闸门拦住了',
    why: '这段代码碰到了不允许的写法（起子进程、读密钥、反射调用之类）。',
    hint: '想放行的话，回一句「这次允许」就行。',
  },
  {
    re: /ERR_ACCESS_DENIED|EACCES|EPERM|permission denied/i,
    title: '被沙箱挡住了',
    why: '他/她想读写临时目录以外的位置，程序直接拒绝了。',
    hint: '这是保护，不是坏了；他/她自己会换个做法，你不用管。',
  },
  {
    re: /ENOENT/,
    title: '文件不存在',
    why: '他/她给的路径找不到东西。',
    hint: '如果是你提供的文件，确认一下文件名或位置。',
  },
  {
    re: /ETIMEDOUT|TIMEOUT|timed out|超时/i,
    title: '超时了',
    why: '超过 30 秒还没跑完，被强制停掉。',
    hint: '任务可能太大，让他/她拆成几步再做。',
  },
  {
    re: /heap out of memory|ENOMEM|OOM/i,
    title: '内存不够',
    why: '这次计算超过了 256MB 的上限。',
    hint: '让他/她少处理一点数据，或者分两次做。',
  },
  {
    re: /ENETUNREACH|EAI_AGAIN|ECONNREFUSED|ENOTFOUND|network/i,
    title: '连不上网',
    why: '沙箱默认不许直连外网，只能走白名单。',
    hint: '要联网的话，让他/她改用搜索或读网页的工具。',
  },
  {
    re: /quota|额度|rate ?limit|too many/i,
    title: '额度用完了',
    why: '这一小时的次数到上限了。',
    hint: '等一会儿，或者把上限调高一点。',
  },
  {
    re: /ENOSPC/,
    title: '磁盘满了',
    why: '写文件的时候没有空间了。',
    hint: '清一下临时目录，或者让他/她少存点东西。',
  },
]

/** 把任意错误翻译成 {title, why, hint}，绝不把堆栈丢给用户。 */
export function explainError(error) {
  const raw = typeof error === 'string' ? error : String(error?.message || error || '')
  for (const item of REASONS) {
    if (item.re.test(raw)) return { title: item.title, why: item.why, hint: item.hint, raw }
  }
  return {
    title: '没做成',
    why: raw ? `原因是：${raw.slice(0, 120)}` : '没有拿到具体原因。',
    hint: '可以让他/她换个做法再试一次。',
  }
}

/** 800 → "0.8 秒"，65000 → "1 分 5 秒" */
export function fmtMs(ms) {
  const n = Number(ms) || 0
  if (n < 500) return `${Math.max(1, Math.round(n))} 毫秒`
  if (n < 60_000) {
    const s = n / 1000
    const text = s < 10 ? s.toFixed(1).replace(/\.0$/, '') : String(Math.round(s))
    return `${text} 秒`
  }
  const total = Math.round(n / 1000)
  return `${Math.floor(total / 60)} 分 ${total % 60} 秒`
}

function fmtBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const ARTIFACT_KIND = { image: '一张图', page: '一页网页', file: '一个文件', chart: '一张图表', data: '一份数据' }

/** 产物的一句话描述 —— 用户关心「你给了我什么」，不关心文件名叫啥。 */
export function artifactNote(artifact) {
  if (!artifact) return ''
  const kind = ARTIFACT_KIND[artifact.kind] || ARTIFACT_KIND.file
  const size = artifact.bytes ? `（${fmtBytes(artifact.bytes)}）` : ''
  return artifact.title ? `${kind}：${artifact.title}${size}` : `${kind}${size}`
}

/**
 * 构造一张卡片视图。这是面板与 QQ 共用的唯一结构。
 *
 * @param {object} input
 * @param {string} input.label   人话说法，例如「把 7 天消息做成柱状图」
 * @param {string[]} [input.plan] 三步以内的计划（执行前就在显示）
 * @param {any} [input.error]    失败时传错误，成功时不传
 * @param {object} [input.artifact] {kind,title,url,bytes}
 * @param {number} [input.ms]    耗时
 * @param {string[]} [input.facts] 事实行（语言、行数、是否联网），只在细节层出现
 * @param {string} [input.code]  源码，只在源码层出现
 */
export function card(input = {}) {
  const {
    label = '这件事',
    plan = [],
    error,
    artifact = null,
    ms = 0,
    facts = [],
    code = '',
    choices = null,
    line: givenLine = '',
  } = input

  const fail = error ? explainError(error) : null
  const note = artifactNote(artifact)
  // 允许直接给一句话。有些话不是「做好了」—— 比如定时提醒、主动开口、
  // 或者只是回一句「在」。逼它们套「做好了：X」的壳，说出去就变得不像人话。
  const explicit = typeof givenLine === 'string' ? givenLine.trim() : ''
  const line = explicit || (fail
    ? `没做成：${fail.title}`
    : `做好了：${label}${ms ? ` · ${fmtMs(ms)}` : ''}${note ? `，${note}` : ''}`)

  return {
    ok: !fail,
    line,
    why: fail?.why || '',
    hint: fail?.hint || '',
    // 失败提示里常带着「他/她」「换个做法」这种第三人称内部话。
    // 面板上给主人看没问题，QQ 群和别人的私聊里不该露出来 ——
    // 出站口按 owner 决定加不加，卡片本身只标「这是主人向的」。
    hintOwnerOnly: Boolean(fail),
    plan: Array.isArray(plan) ? plan.slice(0, 5) : [],
    facts: facts.filter(Boolean),
    artifact,
    code: typeof code === 'string' ? code : '',
    choices: Array.isArray(choices) && choices.length ? choices : null,
    ms: Number(ms) || 0,
  }
}

/** 面板：按密度渲染。card 默认，detail 加事实，source 才带源码。 */
export function render(view, level = 'card') {
  const lines = [view.line]
  if (view.plan?.length) lines.push(`打算：${view.plan.join(' → ')}`)
  if (view.why) lines.push(`原因：${view.why}`)
  if (view.hint) lines.push(`你可以：${view.hint}`)
  if (level === 'detail' || level === 'source') {
    if (view.facts?.length) lines.push(`细节：${view.facts.join(' · ')}`)
    if (view.artifact?.url) lines.push(`产物：${view.artifact.url}`)
  }
  if (level === 'source' && view.code) lines.push(['', '```', view.code, '```'].join('\n'))
  return lines.join('\n')
}

/**
 * QQ：只发一句话。代码、事实、链接一律不发。
 * 有产物就换成「做好了，去面板看」，因为 QQ 里点不开本地页面。
 */
export function forQq(view, options = {}) {
  if (!view.ok) {
    const parts = [`${view.line}`]
    // 失败提示只给主人私聊。群聊和别人那里保留标题（正常聊天内容不砍），
    // 但不把「你可以让他/她换个做法」这种内部话甩出去。
    const hintAllowed = view.hint && (view.hintOwnerOnly !== true || options.owner === true)
    if (hintAllowed) parts.push(view.hint)
    return parts.join(' ')
  }
  if (view.artifact) {
    // 先按老规则去掉尾部的耗时细节，再把结尾标点统一抹掉，
    // 否则「文档做好了。」会拼成「文档做好了。。做好了，在面板里能看。」
    const base = String(view.line || '')
      .replace(/，[^，]*$/, '')
      .replace(/[。.!！?？；;、]+$/, '')
      .trim()
    return `${base || '做好了'}。做好了，在面板里能看。`
  }
  return view.line
}

/**
 * 请求许可 —— 用选项代替「请确认这段代码」。
 * 用户永远不需要读代码就能决定给不给。
 */
export function askCard(input = {}) {
  const {
    goal = '做一件事',
    plan = [],
    ms = 0,
    network = false,
    writes = '只用临时目录',
    choices = ['允许这次', '以后都不用问', '不用了'],
  } = input

  const facts = []
  if (ms) facts.push(`大概 ${fmtMs(ms)}`)
  facts.push(network ? '需要联网' : '不联网')
  facts.push(writes)

  return {
    ok: true,
    line: `他/她想做一件事：${goal}`,
    why: '',
    hint: '',
    plan: plan.slice(0, 5),
    facts,
    artifact: null,
    code: '',
    choices,
    ms: Number(ms) || 0,
  }
}

/** 请求许可的纯文本版（QQ / 邮件用）：编号选项，回数字即可。 */
export function askText(view) {
  const head = [`${view.line}`]
  if (view.plan?.length) head.push(`打算：${view.plan.join(' → ')}`)
  if (view.facts?.length) head.push(view.facts.join(' · '))
  const opts = (view.choices || []).map((c, i) => `${i + 1}. ${c}`)
  return [...head, '', ...opts, '', '回数字就行。'].join('\n')
}
