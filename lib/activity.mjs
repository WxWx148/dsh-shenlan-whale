/**
 * lib/activity.mjs — 自主活动：自己的时间，做真的事（版权：用户）
 * ============================================================================
 * 旧版是「想 → 写一段我做了什么 → 反思」：中间那一步没有任何真实动作，
 * 日志里全是编出来的经历。现在只留真的：
 *
 *   想（只产出搜索词）→ 真的联网查 → 把抓到的原文和来源记下来。
 *
 * 约束只有一条：**日志里不许出现没发生过的动作**。
 * 写进去的标题、正文、链接都必须来自刚抓到的页面；查不到就如实写「没找到」。
 * 反思只基于刚查到的这段原文，查不到就不反思 —— 没东西可反思时硬写，
 * 就是在替它编一段经历。
 *
 * 为什么单独成模块：index.js 的定时器和 turn.mjs 的「活动一下」都走这里，
 * 两条入口共用同一套「真查」逻辑，也才能在没有宿主的环境里用假搜索验证它。
 * ============================================================================
 */
import { normalizeQuery, readWeb, searchWebDetailed } from './web.mjs'

const FALLBACK_INTERESTS = ['游戏', '观鸟', '硬件', 'AI']

/** 兴趣清单：配置里没有就用内置的四项，过滤空串 */
function interestsOf(config = {}, fallback = FALLBACK_INTERESTS) {
  const list = config?.group?.interests
  if (!Array.isArray(list) || !list.length) return fallback.slice()
  const clean = list.map((item) => String(item || '').trim()).filter(Boolean)
  return clean.length ? clean : fallback.slice()
}

/** 最近做过什么，喂给「想」这一步，免得每次都查同一件事 */
function recentLines(runtime, limit = 6) {
  try {
    return (runtime?.activities?.read?.({ limit })?.rows || [])
      .map((row) => String(row.text || '').replace(/\s+/g, ' ').slice(0, 80))
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 自主活动自己产生的 token 也要进账本。
 *
 * 以前这里一次都没记过：定时活动一天跑十几轮，每轮两次模型调用，
 * 账本上却完全看不见 —— 面板的「今天」永远比实际少一块，而少的那块没人知道去哪了。
 * 联网那一步本身不花 token（是 HTTP 请求），贵的是「想查什么」和「查完怎么想」这两次推理。
 */
function spend(runtime, result, at) {
  const usage = result?.usage
  if (!usage) return null
  const input = Math.max(0, Number(usage.input) || 0)
  const output = Math.max(0, Number(usage.output) || 0)
  if (!input && !output) return null
  try {
    runtime?.usage?.record?.(input, output, {
      at: Number(at) || Date.now(),
      model: result?.model || '',
      conversation: 'activity',
      source: 'auto',
    })
  } catch {}
  return { input, output }
}

/**
 * 跑一轮自主活动。只做三件事：想查什么、真的去查、把查到的记下来。
 *
 * @param {object} input
 * @param {object} input.runtime    运行时（logActivity / logCot / memory）
 * @param {Function} input.runner   生成器（只用来产出搜索词和一句反思）
 * @param {object} [input.config]   配置（取 interests）
 * @param {Function} [input.search] 搜索函数，默认 searchWebDetailed
 * @param {Function} [input.read]   读页函数，默认 readWeb
 * @param {number} [input.now]
 * @returns {Promise<{ok:boolean, query?:string, found?:boolean, text?:string, nextMinutes?:number|null, error?:string}>}
 */
export async function runActivityStep(input = {}) {
  const runtime = input.runtime
  const runner = input.runner
  const search = typeof input.search === 'function' ? input.search : searchWebDetailed
  const read = typeof input.read === 'function' ? input.read : readWeb
  const now = Number(input.now) || Date.now()
  if (typeof runner !== 'function') return { ok: false, error: '没有生成器' }

  const interests = interestsOf(input.config)
  const recent = recentLines(runtime)
  let think = null
  try {
    think = await runner(
      '现在是你的自由时间。从这些兴趣里挑一个你此刻真想知道的事：' + interests.join('、') + '。' +
      (recent.length ? '最近查过：' + recent.join(' / ') + '，别重复。' : '') +
      '只写一行搜索词，10-30 字；不要写你做了什么，不要解释。',
      { conversation: 'activity' },
    )
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
  const query = normalizeQuery(String(think?.text || '')).replace(/\s+/g, ' ').trim().slice(0, 60)
  if (!query) return { ok: false, error: '没有想出要查什么' }
  const thoughtSpend = spend(runtime, think, now)

  // 思维链先于联网：先把「打算查什么」落盘，再去查。
  // 顺序反了，面板上就成了「先看到结果、后看到为什么查」。
  runtime?.logCot?.({
    at: now,
    conversation: 'activity',
    kind: 'activity',
    text: String(think?.text || ''),
    summary: '自主活动：想查「' + query + '」',
    steps: ['web_search：' + query],
    source: 'auto',
    tokens: thoughtSpend,
  })

  let rows = []
  try {
    rows = await search(query, 3)
  } catch (error) {
    rows = []
  }

  if (!Array.isArray(rows) || !rows.length) {
    const text = '查了「' + query + '」，没有找到结果。'
    runtime?.logActivity?.({ at: now, kind: 'search', text })
    return { ok: true, query, found: false, text, nextMinutes: null }
  }

  const pick = rows[0]
  let body = String(pick.snippet || '')
  try {
    if (pick.url) {
      const page = await read(pick.url, 1200)
      if (page?.ok) body = String(page.text || '').slice(0, 600)
    }
  } catch {}

  // 这一行只由抓到的内容拼成，模型不参与：写什么，就是真看到了什么。
  const text = '查了「' + query + '」：' + String(pick.title || '').slice(0, 80) + '。' +
    body.replace(/\s+/g, ' ').slice(0, 260) + (pick.url ? '（' + pick.url + '）' : '')
  runtime?.logActivity?.({ at: now, kind: 'search', text })
  runtime?.memory?.rememberSelf?.(text.slice(0, 160))

  // 反思只基于刚查到的原文；查不到就不反思，免得替它编一段经历。
  let reflect = null
  try {
    reflect = await runner(
      '你刚真的查到了这段：' + text + '\n用一句 20-40 字说说它跟你有什么关系、下次想接着查什么。' +
      '不要编造这段里没有的内容。最后可加一行 [[next: 30m]]。',
      { conversation: 'activity' },
    )
  } catch {}
  const reflectText = String(reflect?.text || '').replace(/\[\[next:[^\]]*\]\]/gi, '').trim()
  const reflectSpend = spend(runtime, reflect, now)
  if (reflectText) {
    // 反思也是一次真花钱的推理，同样要落一条：只把它写进活动日志，
    // 面板的思维链上就只剩「想查什么」一半，另一半开销查无实据。
    runtime?.logCot?.({
      at: now,
      conversation: 'activity',
      kind: 'activity',
      text: reflectText,
      summary: '自主活动：查完之后',
      steps: [],
      source: 'auto',
      tokens: reflectSpend,
    })
    runtime?.logActivity?.({ at: now, kind: 'reflect', text: reflectText })
  }

  const mark = String(reflect?.text || '').match(/\[\[next:\s*(\d+)\s*([mh])\]\]/i)
  return {
    ok: true,
    query,
    found: true,
    text,
    nextMinutes: mark ? Math.max(10, Number(mark[1]) * (mark[2].toLowerCase() === 'h' ? 60 : 1)) : null,
  }
}
