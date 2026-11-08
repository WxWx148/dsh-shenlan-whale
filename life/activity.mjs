/**
 * life/activity.mjs — 自主活动：自己的时间，做真的事（版权：用户）
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
import { normalizeQuery, readWeb, searchWebDetailed, lastNetDenied } from '../ability/index.mjs'
import { activitySpend } from './activity-usage.mjs'

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
 * 自主活动自己产生的 token 走独立账本（lib/activity-usage.mjs）。
 *
 * 这里不再自己判 `result.usage` 有没有：宿主换字段名、流式没给用量、
 * 反思没生成文字，任何一种情况以前都会让这笔开销凭空消失。
 * 现在不管拿没拿到数字都会落一次账，拿不到就明确记「一次调用·没拿到数字」，
 * 面板上显示「有 N 次没拿到 token 数」，而不是一片空白。
 * 思维链上的 tokens 只是这份账的副本，不再是唯一来源。
 */
function spend(runtime, result, at, kind) {
  return activitySpend(runtime, result, { at, kind: kind || 'other' })
}

/**
 * 跑一轮自主活动。只做三件事：想查什么、真的去查、把查到的记下来。
 *
 * @param {object} input
 * @param {object} input.runtime    运行时（logActivity / memory）
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

  // 预算闸（双保险）。
  //
  // 调用方（index.js 的 activityTimer）已经在入口查过一次，这里再查一遍：
  // 这一步会跑**两次**推理（想查什么 + 反思），每次都花钱，
  // 而入口那道闸查的是「跑之前」，跑完这一次之后预算可能就满了 ——
  // 两次推理之间不设闸，就会出现「闸过了、跑完一轮、超了、再跑一轮」。
  //
  // 静默返回，不给主人发消息：主人没在跟它说话。
  const budget = Number(runtime?.config?.usage?.budgetPerDay) || 0
  if (budget && runtime?.usage && typeof runtime.usage.overBudget === 'function') {
    try {
      if (runtime.usage.overBudget(now).over) return { ok: false, error: '日预算用完了', overBudget: true }
    } catch {}
  }

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
  // 记账必须在「有没有想出搜索词」之前：没想出来那次推理照样花了钱，
  // 以前因为提前 return，这一笔连账都没进过。
  const thoughtSpend = spend(runtime, think, now, 'think')
  if (!query) return { ok: false, error: '没有想出要查什么' }

  // 自主活动的记录只进活动账本，不再写思维链。
  // 用户要查的是「它自己找事做时干了什么」，不该和聊天回合的思考混在一起。
  let rows = []
  try {
    rows = await search(query, 3)
  } catch (error) {
    rows = []
  }

  if (!Array.isArray(rows) || !rows.length) {
    // 「没搜到」和「白名单没放行」是两回事：后者是界面开关真的起作用了，
    // 日志里得写明白，不然用户只看到「今天怎么什么都查不到」。
    const denied = search === searchWebDetailed ? lastNetDenied() : ''
    const text = denied
      ? `想查「${query}」，联网没放行：${denied}`
      : '查了「' + query + '」，没有找到结果。'
    runtime?.logActivity?.({ at: now, kind: 'search', text, source: 'auto', tokens: thoughtSpend })
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
  runtime?.logActivity?.({ at: now, kind: 'search', text, source: 'auto', tokens: thoughtSpend })
  // 查到的网页原文只进活动账本，不直接写进自我认知。
  // 自我认知应该记「我怎么看」，不是「百度百科说」；下面 reflectText 才写。

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
  // 反思有没有写出文字都要记：模型已经跑过一次，钱不会因为「没话说」而退回。
  const reflectSpend = spend(runtime, reflect, now, 'reflect')
  if (reflectText) {
    // 活动记录只留在活动账本里；思维链只放聊天回合的思考。
    runtime?.logActivity?.({ at: now, kind: 'reflect', text: reflectText, source: 'auto', tokens: reflectSpend })
    // 活动反思只留在活动账本里，不写自我认知。
    // 反思提示词会追问「这段讲了什么、下次查什么」，写进 self 仍然是网页内容；
    // 自我认知只保留真正的人设判断，不由一次搜索自动生成。
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
