/** 深蓝鲸的最小联网搜索（版权：用户） */
import { openUrl } from './browser.mjs'
import { execFile } from 'node:child_process'

// ── 联网闸门：界面上「联网白名单 / 每小时联网次数」的执行处 ──────────────
//
// 以前这两个键只有技能页的能力声明和提示词文案在读：界面写着「留空＝全部不许」，
// 工具里却是写死的 30 次/小时，白名单一个字都没检查 —— 面板上开关拨来拨去，
// 联网行为纹丝不动。现在把闸放在所有联网请求共用的这一层，工具、自主活动、
// 热点、简报都绕不过去；配置一改就由订阅者调 configureNet 立刻换策略。
let netPolicy = { allowlist: [], quotaPerHour: 60 }
const netHits = []
let lastDenied = ''
// 搜索返回的站点临时放行：用户点开搜索结果时，不必先把每个新闻站加进白名单。
// 只放行刚搜到的 host，10 分钟后失效；不是把整个白名单关掉。
const followedHosts = new Map()
const FOLLOW_TTL_MS = 10 * 60_000

function pruneHits(now = Date.now()) {
  while (netHits.length && now - netHits[0] >= 3_600_000) netHits.shift()
  for (const [host, until] of followedHosts) {
    if (until <= now) followedHosts.delete(host)
  }
}

function followHost(url) {
  const host = hostOf(url)
  if (host) followedHosts.set(host, Date.now() + FOLLOW_TTL_MS)
}

function deny(reason) {
  lastDenied = reason
  return { ok: false, code: 'net_denied', error: reason }
}

/** 由 index.js 在启动与每次配置变更时调用；返回当前策略，给调试台直接看 */
export function configureNet(config = {}) {
  const raw = config?.net || {}
  const list = Array.isArray(raw.allowlist)
    ? raw.allowlist.map((one) => String(one || '').trim().toLowerCase()).filter(Boolean)
    : []
  const quota = Math.max(0, Math.min(500, Number(raw.quotaPerHour ?? 60) || 0))
  netPolicy = { allowlist: list, quotaPerHour: quota }
  followedHosts.clear()
  lastDenied = ''
  return netStatus()
}

export function netStatus() {
  pruneHits()
  return {
    allowlist: netPolicy.allowlist.slice(),
    quotaPerHour: netPolicy.quotaPerHour,
    used: netHits.length,
    remaining: Math.max(0, netPolicy.quotaPerHour - netHits.length),
    denied: lastDenied,
  }
}

/** 搜索没结果时，工具层用它区分「没搜到」与「被拦了」 */
export function lastNetDenied() {
  return lastDenied
}

function hostOf(url) {
  try { return new URL(String(url || '')).hostname.toLowerCase() } catch { return '' }
}

/** 留空 = 全部不许（与界面、config 注释一致）；支持子域 */
function domainAllowed(host) {
  if (!host) return false
  if ((followedHosts.get(host) || 0) > Date.now()) return true
  return netPolicy.allowlist.some((domain) => host === domain || host.endsWith('.' + domain))
}

function takeSlot() {
  pruneHits()
  if (netPolicy.quotaPerHour <= 0) return deny('每小时联网次数设成了 0，现在不许联网')
  if (netHits.length >= netPolicy.quotaPerHour) {
    return deny(`这一小时已经联网 ${netHits.length} 次，到上限（${netPolicy.quotaPerHour}）了；过一会儿再来，或者去设置里调高`)
  }
  netHits.push(Date.now())
  return { ok: true }
}

/** 打开一个网址前的闸：白名单与次数都在这里过 */
export function checkNet(url) {
  const host = hostOf(url)
  if (!domainAllowed(host)) {
    return deny(netPolicy.allowlist.length
      ? `「${host}」不在联网白名单里，去设置里加上才能打开`
      : '联网白名单是空的（留空＝全部不许）；去设置里点开或添加域名才能联网')
  }
  return takeSlot()
}

/** 用带 --use-env-proxy 的子进程抓页面，解决主进程没走系统代理的问题 */
function proxyText(url, timeoutMs = 9000) {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7897'
  const script = "fetch(process.argv[1],{headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36','accept-language':'zh-CN,zh;q=0.9'}}).then(async r=>{if(!r.ok)process.exit(2);process.stdout.write(await r.text())}).catch(()=>process.exit(3))"
  return new Promise((resolve) => {
    execFile(process.execPath, ['--use-env-proxy', '-e', script, url], {
      env: { ...process.env, HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy },
      timeout: timeoutMs,
      maxBuffer: 12 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout) => resolve(error ? '' : String(stdout || '')))
  })
}

function strip(html) {
  return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&ensp;|&#0183;|&#183;/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * 单页最多收多少字节。
 *
 * 为什么必须有上限：`await res.text()` 会把整个响应体读进内存再切片 ——
 * 切片只决定「给模型看多少」，不决定「占多少内存」。一个几百 MB 的资源页
 * （或者一个把 .zip 当 text/html 返回的地址）就能让进程当场涨几百兆，
 * 而 readWeb 有两条自动触发的调用路径（掉线自学、热点分享），没人盯着。
 * 8 MB 对「读一篇文章」绰绰有余：strip 之后进上下文的只有 3500 字。
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** 边读边数字节，超了立刻停 —— 不是为了读完再判断，而是根本别读完 */
async function readCapped(res, limit) {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    try { res.body?.cancel?.() } catch {}
    return { ok: false, error: `页面太大（${Math.round(declared / 1048576)}MB，上限 ${Math.round(limit / 1048576)}MB）` }
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text()
    return { ok: true, text: text.slice(0, limit) }
  }
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value?.byteLength || 0
      if (total > limit) {
        try { await reader.cancel() } catch {}
        return { ok: false, error: `页面太大（超过 ${Math.round(limit / 1048576)}MB），不读了` }
      }
      chunks.push(value)
    }
  } finally {
    try { reader.releaseLock?.() } catch {}
  }
  return { ok: true, text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8') }
}

export async function readWeb(url, maxChars = 3500) {
  const target = String(url || '').trim()
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: '不是 http(s) 链接' }
  const gate = checkNet(target)
  if (!gate.ok) return { ok: false, code: gate.code, error: gate.error }
  const host = (() => { try { return new URL(target).hostname.toLowerCase() } catch { return '' } })()
  // GitHub 在这台机器上几乎每次直连都超时，先走代理，省掉 12 秒空等。
  if (/(^|\.)github\.com$|(^|\.)githubusercontent\.com$/.test(host)) {
    const proxied = await proxyText(target, 15_000)
    if (proxied) return { ...pageOf(proxied, target, maxChars), viaProxy: true }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  let directError = ''
  try {
    const res = await fetch(target, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, signal: controller.signal })
    if (!res.ok) {
      directError = `HTTP ${res.status}`
    } else {
      const body = await readCapped(res, MAX_BODY_BYTES)
      if (!body.ok) return { ok: false, error: body.error }
      return pageOf(body.text, target, maxChars)
    }
  } catch (error) {
    directError = String((error && error.message) || error)
  } finally {
    clearTimeout(timer)
  }
  // GitHub、部分境外站点在主进程直连会超时，但系统代理是通的。
  // 直连失败后走与搜索同一套 --use-env-proxy 子进程，避免把「网络没通」
  // 误判成「仓库私有 / 空仓库」。
  const proxied = await proxyText(target, 15_000)
  if (proxied) {
    const page = pageOf(proxied, target, maxChars)
    return { ...page, viaProxy: true }
  }
  return {
    ok: false,
    error: directError
      ? `直连失败（${directError}），系统代理也没能打开这个页面`
      : '系统代理也没能打开这个页面',
  }
}

/** 统一从 HTML 里取标题与正文，直连/代理两条路共用 */
function pageOf(html, target, maxChars = 3500) {
  const title = (String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''
  const text = strip(html).slice(0, Math.max(500, Number(maxChars) || 3500))
  return { ok: true, title: strip(title).slice(0, 120), text, url: target }
}

/** 把口语化请求压成搜索词；保留引号和 site:，不破坏精确检索 */
export function normalizeQuery(query) {
  const original = String(query || '').trim()
  let out = original
    .replace(/^(帮我|请|麻烦|你)?\s*(谷歌|google)\s*(?:(?:搜|查|找)(?:一下)?|一下)?\s*/i, '')
    .replace(/^(帮我|请|麻烦|你)?\s*(搜一下|搜索一下|搜索|查一下|查找|查查|看看|找一下|找找)\s*/i, '')
    .replace(/[，。！？!?；;]+$/g, '')
    .trim()
  // 搜索引擎对「最近 / 怎么样了」这类口语词非常敏感：带「最近」的
  // 「日本股市最近暴跌得怎么样了」会被 Bing 理解成「日本」，返回百科/旅游局。
  // 只清掉时间填充词和句尾问法，保留实体与事件词。
  out = out
    .replace(/(?:最近|最新|目前|现在|今天|今日|这几天|近期)/g, ' ')
    .replace(/(?:得)?(?:怎么样了?|怎么样|如何|是什么|有什么|吗|呢|啊|吧|了)+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return out.length >= 2 ? out : original
}

/** 低价值结果：百科、知道、经验这类聚合页。先排后面，不直接丢。 */
const LOW_VALUE_HOST = /(^|\.)(baike\.baidu\.com|zhidao\.baidu\.com|jingyan\.baidu\.com|baike\.sogou\.com|baike\.so\.com)$/i

function rankSearchRows(rows, limit) {
  const good = []
  const low = []
  const seen = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    const url = String(row?.url || '').trim()
    const title = String(row?.title || '').trim()
    if (!url || !/^https?:\/\//i.test(url) || !title) continue
    if (seen.has(url)) continue
    seen.add(url)
    let host = ''
    try { host = new URL(url).hostname.toLowerCase() } catch {}
    ;(LOW_VALUE_HOST.test(host) ? low : good).push(row)
  }
  return [...good, ...low].slice(0, Math.max(1, Number(limit) || 5))
}

function decodeBingUrl(href) {
  const raw = String(href || '')
  try {
    const url = new URL(raw, 'https://cn.bing.com')
    const u = url.searchParams.get('u')
    if (u && /^a1/i.test(u)) {
      const b64 = u.slice(2).replace(/-/g, '+').replace(/_/g, '/')
      return Buffer.from(b64, 'base64').toString('utf8')
    }
    return url.href
  } catch {
    return raw
  }
}

async function searchGoogle(q, limit = 5) {
  try {
    // gbv=1 让 Google 返回基础 HTML，避免只拿到 JS 空壳；仍然是同一套结果页。
    const html = await proxyText('https://www.google.com/search?q=' + encodeURIComponent(q) + '&hl=zh-CN&gbv=1&num=' + Math.max(3, Number(limit) || 5), 12000)
    if (!html) return []
    const out = []
    const seen = new Set()
    const re = /<a[^>]*href="\/url\?q=([^&"]+)[^"]*"[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?(?:<div[^>]*class="[^"]*(?:VwiC3b|IsZvec)[^"]*"[^>]*>([\s\S]*?)<\/div>)?/gi
    let m
    while ((m = re.exec(html)) && out.length < limit) {
      const title = strip(m[2]).slice(0, 120)
      const link = decodeURIComponent(m[1])
      const snippet = strip(m[3] || '').slice(0, 260)
      if (!title || seen.has(link)) continue
      seen.add(link)
      out.push({ title, url: link, snippet })
    }
    return out
  } catch {
    return []
  }
}

async function searchQuark(q, limit = 5) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 9000)
  try {
    const res = await fetch('https://quark.sm.cn/s?q=' + encodeURIComponent(q), {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' },
      signal: controller.signal,
    })
    if (!res.ok) return []
    const html = await res.text()
    if (/_____tmd_____|punish|x5secdata/i.test(html)) return []
    const out = []
    const re = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let m
    while ((m = re.exec(html)) && out.length < limit) {
      const title = strip(m[2]).slice(0, 120)
      if (title.length < 6 || /^(首页|登录|下载|更多|搜索)$/.test(title)) continue
      out.push({ title, url: m[1], snippet: '' })
    }
    return out
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

async function searchBaidu(q, limit = 5) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 9000)
  try {
    const res = await fetch('https://www.baidu.com/s?wd=' + encodeURIComponent(q), {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' },
      signal: controller.signal,
    })
    if (!res.ok) return []
    const html = await res.text()
    const out = []
    const blocks = html.split(/<h3[^>]*class="[^"]*t[^"]*"/i).slice(1)
    for (const block of blocks) {
      if (out.length >= limit) break
      if (/广告|cpro|data-tuiguang/i.test(block.slice(0, 800))) continue
      const href = (block.match(/mu="(https?:\/\/[^"]+)"/i) || block.match(/<a[^>]*href="([^"]+)"/i) || [])[1] || ''
      const title = strip((block.match(/<a[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || '').slice(0, 120)
      const snippet = strip((block.match(/<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '').slice(0, 260)
      if (title && /^https?:\/\//i.test(href)) out.push({ title, url: href, snippet })
    }
    return out
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

async function searchBing(q, limit = 5) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 9000)
  try {
    const res = await fetch('https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN', {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: controller.signal,
    })
    if (!res.ok) return []
    const html = await res.text()
    const out = []
    const re = /<li class="b_algo"[\s\S]*?<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi
    let m
    while ((m = re.exec(html)) && out.length < limit) {
      const title = strip(m[2]).slice(0, 120)
      const link = decodeBingUrl(m[1])
      if (!title || !/^https?:\/\//i.test(link)) continue
      out.push({ title, url: link, snippet: strip(m[3]).slice(0, 260) })
    }
    return out
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

async function searchBrowserQuark(q, limit = 5) {
  try {
    const opened = await openUrl('https://quark.sm.cn/s?q=' + encodeURIComponent(q), { browserHeadless: true, browserTimeoutMs: 30000 })
    if (!opened.ok) return []
    const map = new Map()
    for (const item of opened.page.items || []) {
      const href = String(item.href || '')
      const text = String(item.text || '').trim()
      if (!/^https?:\/\//i.test(href) || /quark\.sm\.cn|quark\.cn/i.test(href) || text.length < 8) continue
      let key = href
      try { key = new URL(href).hostname.replace(/^www\./, '') } catch {}
      const prev = map.get(key)
      if (!prev) map.set(key, { title: text.slice(0, 120), url: href, snippet: '' })
      else if (text.length > prev.title.length) {
        if (prev.title.length <= 24) prev.snippet = prev.snippet || text.slice(0, 260)
        else prev.title = text.slice(0, 120)
      }
    }
    return [...map.values()].slice(0, limit)
  } catch {
    return []
  }
}

/**
 * Keenable 免注册搜索：ModSearch 这条增强源用的就是它。
 * 不装插件、不需要 key；返回的是真正的新闻/行情条目，不是「美」这种字典词。
 */
async function searchKeenable(q, limit = 5) {
  try {
    const res = await fetch('https://api.keenable.ai/v1/search/public', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-keenable-title': 'DeepSeek Harness' },
      body: JSON.stringify({ query: q, max_results: Math.max(1, Math.min(10, Number(limit) || 5)) }),
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) return []
    const data = await res.json()
    return (Array.isArray(data?.results) ? data.results : []).slice(0, limit).map((row) => ({
      title: String(row?.title || '').slice(0, 120),
      url: String(row?.url || ''),
      snippet: String(row?.snippet || row?.description || '').slice(0, 320),
    })).filter((row) => row.title && /^https?:\/\//i.test(row.url))
  } catch {
    return []
  }
}

/** 结构化搜索：Keenable → Google → 夸克 → 百度 →（都失败）浏览器夸克 → Bing */
export async function searchWebDetailed(query, limit = 5) {
  const q = normalizeQuery(query)
  if (!q) return []
  lastDenied = ''
  if (/^https?:\/\//i.test(q)) {
    const page = await readWeb(q, 4000)
    return page.ok ? rankSearchRows([{ title: page.title || q, url: page.url || q, snippet: page.text.slice(0, 260), text: page.text }], limit) : []
  }
  // 搜索引擎的目标域名由代码写死，但「能不能用」按白名单来：
  // 界面里点开 cn.bing.com，Bing 这一路才真的会发请求。
  const providers = [
    // 用户要求优先谷歌：先走 Google，再走免注册增强源和国内源兜底。
    // Google 被墙/要验证码时只是返回空，不会阻断后面的源。
    { host: 'www.google.com', run: searchGoogle },
    // 免注册增强源：不算「用户要访问的站点」，只要联网没被总关就允许。
    { host: 'api.keenable.ai', run: searchKeenable, free: true },
    { host: 'quark.sm.cn', run: searchBrowserQuark },
    { host: 'quark.sm.cn', run: searchQuark },
    { host: 'www.baidu.com', run: searchBaidu },
    { host: 'cn.bing.com', run: searchBing },
  ]
  const usable = providers.filter((one) => one.free ? netPolicy.allowlist.length > 0 : domainAllowed(one.host))
  if (!usable.length) {
    deny(netPolicy.allowlist.length
      ? '联网白名单里没有放行任何搜索引擎，搜不了；去设置里加 cn.bing.com 或 www.baidu.com'
      : '联网白名单是空的（留空＝全部不许）；去设置里点开一个搜索域名才能搜')
    return []
  }
  for (const provider of usable) {
    const gate = takeSlot()
    if (!gate.ok) return []
    const rows = await provider.run(q, limit)
    const ranked = rankSearchRows(rows, limit)
    if (ranked.length) {
      for (const row of ranked) followHost(row.url)
      return ranked
    }
  }
  return []
}

export async function searchWeb(query, limit = 5) {
  const rows = await searchWebDetailed(query, limit)
  return rows.map((row) => '· ' + row.title + (row.snippet ? '：' + row.snippet : '') + '\n' + row.url)
}
