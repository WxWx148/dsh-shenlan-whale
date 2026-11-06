/** 深蓝鲸的最小联网搜索（版权：用户） */
import { openUrl } from './browser.mjs'
import { execFile } from 'node:child_process'

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

export async function readWeb(url, maxChars = 3500) {
  const target = String(url || '').trim()
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: '不是 http(s) 链接' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const res = await fetch(target, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, signal: controller.signal })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const html = await res.text()
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''
    const text = strip(html).slice(0, Math.max(500, Number(maxChars) || 3500))
    return { ok: true, title: strip(title).slice(0, 120), text, url: target }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  } finally {
    clearTimeout(timer)
  }
}

/** 把口语化请求压成搜索词；保留引号和 site:，不破坏精确检索 */
export function normalizeQuery(query) {
  return String(query || '')
    .replace(/^(帮我|请|麻烦|你)?\s*(搜一下|搜索一下|搜索|查一下|查找|查查|看看|找一下|找找)\s*/i, '')
    .replace(/[，。！？!?；;]+$/g, '')
    .trim()
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
    const html = await proxyText('https://www.google.com/search?q=' + encodeURIComponent(q) + '&hl=zh-CN&num=' + Math.max(3, Number(limit) || 5), 12000)
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

/** 结构化搜索：Google → 夸克 → 百度 →（都失败）浏览器夸克 → Bing */
export async function searchWebDetailed(query, limit = 5) {
  const q = normalizeQuery(query)
  if (!q) return []
  if (/^https?:\/\//i.test(q)) {
    const page = await readWeb(q, 4000)
    return page.ok ? [{ title: page.title || q, url: page.url || q, snippet: page.text.slice(0, 260), text: page.text }] : []
  }
  const providers = [searchGoogle, searchBrowserQuark, searchQuark, searchBaidu, searchBing]
  for (const provider of providers) {
    const rows = await provider(q, limit)
    if (rows.length) return rows
  }
  return []
}

export async function searchWeb(query, limit = 5) {
  const rows = await searchWebDetailed(query, limit)
  return rows.map((row) => '· ' + row.title + (row.snippet ? '：' + row.snippet : '') + '\n' + row.url)
}
