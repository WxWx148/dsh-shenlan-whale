/**
 * lib/media.mjs — 把 QQ 消息里的图片本体留下来。
 *
 * 为什么非要有这一层：
 *   一条图片消息进来时，OneBot 只给两样东西：`url`（会过期的 CDN 链接）和 `file`
 *   （协议端那边的临时文件名）。以前两样都只存在内存里，于是：
 *     · 想「收藏这张表情」时链接可能已经废了 → 取不到字节；
 *     · 翻聊天记录看不到图（只有一句 [图片]）；
 *     · 面板里那张图，过了十分钟就变成裂图。
 *   一句话：**图片的本体从来没落到我们的盘上**。收图就落盘，是唯一稳的做法。
 *
 * 三条规矩：
 *   1. 文件名用内容 sha1：同一张图收十次也只有一份；
 *   2. 认图片头，不认后缀（防止把 .json 存成 .png）；
 *   3. 落盘失败不影响收消息 —— 图没了是遗憾，消息丢了是事故。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DEFAULT_MAX_BYTES = 6_000_000
const NAME_RE = /^[a-f0-9]{8,40}\.(png|jpe?g|gif|webp)$/i

/** 按文件头判真实类型；认不出来返回空串 */
export function extOf(buffer) {
  const head = Buffer.isBuffer(buffer) && buffer.length > 12 ? buffer : Buffer.alloc(0)
  if (head[0] === 0x89 && head[1] === 0x50) return 'png'
  if (head[0] === 0x47 && head[1] === 0x49) return 'gif'
  if (head[0] === 0x52 && head[1] === 0x49) return 'webp'
  if (head[0] === 0xff && head[1] === 0xd8) return 'jpg'
  return ''
}

export function mediaDir(dir) {
  return path.join(String(dir || '.'), 'media')
}

/**
 * 名字 → 路径。只认自己写出来的那种名字（十六进制 + 图片后缀），
 * 别的一律拒绝 —— 这个函数会被路由直接喂参数，不能让 ../ 走通。
 */
export function mediaPath(dir, name) {
  const file = String(name || '')
  if (!NAME_RE.test(file)) return ''
  return path.join(mediaDir(dir), file)
}

/**
 * 存一份字节。已存在就只返回（内容寻址，天然去重）。
 * @returns {{ok:boolean, name?:string, path?:string, bytes?:number, sha1?:string, existed?:boolean, error?:string}}
 */
export function saveImageBytes(dir, buffer, options = {}) {
  const data = Buffer.isBuffer(buffer) ? buffer : null
  if (!data || !data.length) return { ok: false, error: '没有图片内容' }
  const maxBytes = Math.max(64 * 1024, Number(options.maxBytes) || DEFAULT_MAX_BYTES)
  if (data.length > maxBytes) return { ok: false, error: '图片超过大小上限（' + Math.round(maxBytes / 1024) + 'KB）' }
  const ext = extOf(data)
  if (!ext) return { ok: false, error: '这不是能认出来的图片（png/jpg/gif/webp）' }
  const base = mediaDir(dir)
  try {
    mkdirSync(base, { recursive: true })
    const sha1 = createHash('sha1').update(data).digest('hex')
    const name = sha1.slice(0, 32) + '.' + ext
    const target = path.join(base, name)
    if (existsSync(target)) {
      return { ok: true, name, path: target, bytes: data.length, sha1, existed: true }
    }
    // 先写临时文件再改名：写到一半断电，不至于留下一张裂图被当成「已存在」
    const tmp = target + '.' + process.pid + '.tmp'
    writeFileSync(tmp, data)
    renameSync(tmp, target)
    return { ok: true, name, path: target, bytes: data.length, sha1, existed: false }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

/**
 * 下载一张图。只收图片类型，大小有上限，超时就放弃。
 * @returns {Promise<Buffer|null>}
 */
export async function fetchImageBytes(url, options = {}) {
  const href = String(url || '')
  if (!/^https?:/i.test(href)) return null
  const maxBytes = Math.max(64 * 1024, Number(options.maxBytes) || DEFAULT_MAX_BYTES)
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : fetch
  try {
    const res = await fetchImpl(href, {
      headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://qq.com/' },
      signal: AbortSignal.timeout(Math.max(1000, Number(options.timeoutMs) || 12_000)),
    })
    if (!res.ok) return null
    const type = String(res.headers?.get?.('content-type') || '')
    if (type && !type.startsWith('image/')) return null
    const declared = Number(res.headers?.get?.('content-length') || 0)
    if (declared && declared > maxBytes) return null
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.length && buf.length <= maxBytes ? buf : null
  } catch {
    return null
  }
}

/**
 * 把一条图片消息落到盘上。按「代价从低到高」试三条路：
 *   本地已有文件 → 协议端要 base64 → 下载 url
 * 成功返回 {name, path}；全都不行返回 null（调用方自己决定怎么说话）。
 */
export async function persistImage(input = {}) {
  const pic = input.pic || {}
  const dir = input.dir
  const maxBytes = Number(input.maxBytes) || DEFAULT_MAX_BYTES
  const channel = input.channel || null

  const local = String(pic.file || '').replace(/^file:\/\//, '')
  if (local && /^([A-Za-z]:[\\/]|\/)/.test(local)) {
    try {
      if (existsSync(local) && statSync(local).size <= maxBytes) {
        const saved = saveImageBytes(dir, readFileSync(local), { maxBytes })
        if (saved.ok) return saved
      }
    } catch {}
  }

  if (channel && typeof channel.getImage === 'function') {
    try {
      const got = await channel.getImage(pic.file || pic.url || '')
      if (got?.base64) {
        const saved = saveImageBytes(dir, Buffer.from(got.base64, 'base64'), { maxBytes })
        if (saved.ok) return saved
      }
      if (got?.file) {
        const file = String(got.file).replace(/^file:\/\//, '')
        try {
          if (existsSync(file) && statSync(file).size <= maxBytes) {
            const saved = saveImageBytes(dir, readFileSync(file), { maxBytes })
            if (saved.ok) return saved
          }
        } catch {}
      }
      if (got?.url) {
        const buf = await fetchImageBytes(got.url, { maxBytes, fetch: input.fetch })
        if (buf) {
          const saved = saveImageBytes(dir, buf, { maxBytes })
          if (saved.ok) return saved
        }
      }
    } catch {}
  }

  const buf = await fetchImageBytes(pic.url, { maxBytes, fetch: input.fetch })
  if (buf) {
    const saved = saveImageBytes(dir, buf, { maxBytes })
    if (saved.ok) return saved
  }
  return null
}

/**
 * 在事件上挂「本体落盘」的承诺。
 *
 * 不 await：收消息不能被一张图拖住（下载可能要十几秒）。
 * 但把 promise 挂在 pic 上，收藏/看图这些真正要字节的地方 await 它就有了。
 * 落盘成功后把名字写回 payload，面板与日志就能直接引用本地文件。
 */
export function attachImages(raw, options = {}) {
  const pics = raw?.payload?.images
  if (!Array.isArray(pics) || !pics.length) return []
  const dir = options.dir
  const limit = Math.max(1, Math.min(6, Number(options.limit) || 3))
  return pics.slice(0, limit).map((pic) => {
    if (!pic || typeof pic !== 'object') return null
    if (pic.persist) return pic.persist
    // 用不可枚举属性挂承诺：事件最终会被 JSON.stringify 写进 events.jsonl，
    // 可枚举的 Promise 会变成一个空对象 `"persist":{}`，白白塞进每一条图片事件里。
    // 不可枚举既不影响按键取值，也不会污染落盘内容。
    Object.defineProperty(pic, 'persist', {
      value: persistImage({ ...options, dir, pic })
        .then((saved) => {
          if (saved?.ok) {
            pic.cached = saved.name
            pic.localPath = saved.path
          }
          return saved || null
        })
        .catch(() => null),
      enumerable: false,
      configurable: true,
      writable: true,
    })
    return pic.persist
  }).filter(Boolean)
}

/**
 * 清理：只留最近的 maxFiles 张，且不保留超过 keepDays 天的。
 * 图片是缓存，不是档案 —— 该删就删，别把磁盘吃光。
 * @returns {{removed:number, kept:number}}
 */
export function pruneMedia(dir, options = {}) {
  const base = mediaDir(dir)
  const keepDays = Math.max(1, Number(options.keepDays) || 30)
  const maxFiles = Math.max(50, Number(options.maxFiles) || 3000)
  const now = Number(options.now) || Date.now()
  let files = []
  try {
    files = readdirSync(base)
      .filter((name) => NAME_RE.test(name))
      .map((name) => {
        const full = path.join(base, name)
        try {
          const info = statSync(full)
          return { name, full, at: info.mtimeMs, size: info.size }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.at - a.at)
  } catch {
    return { removed: 0, kept: 0 }
  }
  const cutoff = now - keepDays * 24 * 3600_000
  let removed = 0
  let kept = 0
  for (const [index, item] of files.entries()) {
    const tooMany = index >= maxFiles
    const tooOld = item.at < cutoff
    if (!tooMany && !tooOld) {
      kept += 1
      continue
    }
    try {
      unlinkSync(item.full)
      removed += 1
    } catch {
      kept += 1
    }
  }
  return { removed, kept }
}
