/**
 * lib/stickers.mjs — 表情包库：收一张、打标签、按情绪挑一张。
 *
 * 为什么要单独一层：
 *   以前「发表情」的代码散在 turn.mjs 的三处 if 里，各自扫目录、各自读 index.json，
 *   收藏时写一套格式、发送时读另一套格式。结果是：收藏成功的图，发的时候找不到。
 *   现在只留一份库存（index.json），收藏、列表、挑选、指定，全走这里。
 *
 * 三条硬规则：
 *   1. 只认图片后缀，别的文件一律不当表情（防止把 .json 当图发出去）；
 *   2. 文件名用内容 sha1，重复收藏同一张不会长两份；
 *   3. 标签最多 5 个、每个 8 字以内 —— 标签是给挑选用的，不是写小作文。
 *
 * 兼容：~/.dsh/qq-fish/stickers 是旧版目录，只读不写；新收藏一律落当前数据目录。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { writeJson } from './core.mjs'

const IMAGE = /\.(jpe?g|png|gif|webp)$/i
const MAX_ITEMS = 500
const MAX_TAGS = 5
const MAX_TAG_CHARS = 8

/** 情绪标签的推荐写法；只是提示，不限制用户自创 */
const MOOD_HINTS = Object.freeze(['开心', '得意', '无语', '委屈', '生气', '害羞', '困', '震惊', '撒娇', '嫌弃'])

/** 从图片头判断真实后缀，别信文件名 */
function extOf(buffer) {
  const head = buffer && buffer.length > 12 ? buffer : Buffer.alloc(0)
  if (head[0] === 0x89 && head[1] === 0x50) return 'png'
  if (head[0] === 0x47 && head[1] === 0x49) return 'gif'
  if (head[0] === 0x52 && head[1] === 0x49) return 'webp'
  if (head[0] === 0xff && head[1] === 0xd8) return 'jpg'
  return ''
}

/** 标签清洗：去空、去重、限长；顺带把「标签：」这种前缀去掉 */
function cleanLabels(input = []) {
  const out = []
  const list = Array.isArray(input) ? input : String(input || '').split(/[、,，;；\s]+/)
  for (const raw of list) {
    const tag = String(raw || '')
      .replace(/^标签(?:是|为)?[：:\s]*/, '')
      .replace(/[【】\[\]「」"']/g, '')
      .trim()
      .slice(0, MAX_TAG_CHARS)
    if (!tag) continue
    if (out.some((item) => item.toLowerCase() === tag.toLowerCase())) continue
    out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

function stickerDir(dir) {
  return path.join(String(dir || '.'), 'stickers')
}

/** 当前目录优先，旧版目录只读兜底 */
function stickerDirs(dir) {
  const list = [stickerDir(dir)]
  const legacy = path.join(homedir(), '.dsh', 'qq-fish', 'stickers')
  if (legacy !== list[0]) list.push(legacy)
  return list
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 读一个目录的库存；坏文件不炸，回空表 */
function readIndex(dir) {
  const file = path.join(dir, 'index.json')
  const parsed = readJson(file, null)
  const items = Array.isArray(parsed?.items) ? parsed.items : []
  return items
    .filter((item) => item && item.file && IMAGE.test(String(item.file)))
    .map((item) => ({
      id: String(item.id || item.sha1 || ''),
      file: String(item.file),
      labels: cleanLabels(item.labels || []),
      description: String(item.description || ''),
      from: String(item.from || ''),
      source: String(item.source || ''),
      addedAt: Number(item.addedAt) || 0,
      interested: item.interested === true,
      dir,
      path: path.join(dir, item.file),
    }))
    .filter((item) => existsSync(item.path))
}

/** 旧格式：labels.json 里 { "a.jpg": ["开心","笑"] }，没有 index.json 时兜底 */
function readLegacyLabels(dir) {
  const parsed = readJson(path.join(dir, 'labels.json'), null)
  if (!parsed || typeof parsed !== 'object') return new Map()
  const map = new Map()
  for (const [file, labels] of Object.entries(parsed)) {
    if (IMAGE.test(file)) map.set(file, cleanLabels(labels || []))
  }
  return map
}

/**
 * 全部表情。当前目录里没登记进 index 的图片也会出现（标签为空），
 * 否则「明明有图却不能发」会变成查不出来的怪事。
 */
export function loadStickers(dir) {
  const out = []
  const seen = new Set()
  for (const base of stickerDirs(dir)) {
    if (!existsSync(base)) continue
    const indexed = readIndex(base)
    const legacy = indexed.length ? new Map() : readLegacyLabels(base)
    const items = indexed.length
      ? indexed
      : (() => {
          try {
            return readdirSync(base)
              .filter((file) => IMAGE.test(file))
              .map((file) => ({ file, labels: legacy.get(file) || [] }))
          } catch {
            return []
          }
        })()
    for (const item of items) {
      const key = `${item.file}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        id: String(item.id || ''),
        file: String(item.file),
        labels: cleanLabels(item.labels || []),
        description: String(item.description || ''),
        from: String(item.from || ''),
        dir: base,
        path: path.join(base, item.file),
      })
    }
  }
  return out
}

/** 列表：序号、标签、文件名。序号就是 send_sticker 里能填的数字 */
export function listStickers(items, options = {}) {
  const limit = Math.max(1, Math.min(80, Number(options.limit) || 30))
  const rows = (Array.isArray(items) ? items : []).slice(0, limit).map((item, index) => {
    const tags = item.labels.length ? item.labels.join(' / ') : '无标签'
    return `${index + 1}. ${tags} · ${item.file}`
  })
  return rows
}

/**
 * 按标签挑一张。先精确包含，再反包含（标签「笑」能匹配「大笑」），
 * 都没有就随机 —— 随机也比「找不到就不发」更像个活人。
 */
export function pickSticker(items, tag = '', random = Math.random) {
  const pool = Array.isArray(items) ? items.filter((item) => item && item.path) : []
  if (!pool.length) return null
  const want = String(tag || '').trim().toLowerCase()
  if (want) {
    const exact = pool.filter((item) => item.labels.some((label) => label.toLowerCase() === want))
    const loose = pool.filter((item) =>
      item.labels.some((label) => label.toLowerCase().includes(want) || want.includes(label.toLowerCase())),
    )
    const hit = exact.length ? exact : loose
    if (hit.length) return hit[Math.floor(random() * hit.length)]
    return null
  }
  return pool[Math.floor(random() * pool.length)]
}

/** 按序号 / 文件名 / id 指定一张 */
export function resolveSticker(items, key) {
  const pool = Array.isArray(items) ? items : []
  const value = String(key || '').trim()
  if (!value) return null
  if (/^\d+$/.test(value)) return pool[Number(value) - 1] || null
  return pool.find((item) => item.id === value || item.file === value || item.file.replace(/\.[^.]+$/, '') === value) || null
}

/**
 * 收藏一张。buffer 优先；只给 file 也能用。
 * @returns {{ok:boolean, item?:object, duplicated?:boolean, error?:string}}
 */
export function saveSticker(input = {}) {
  const base = stickerDir(input.dir)
  const buffer = Buffer.isBuffer(input.buffer) ? input.buffer : null
  const source = String(input.file || '')
  const data = buffer || (source && existsSync(source) ? readFileSync(source) : null)
  if (!data || !data.length) return { ok: false, error: '没有图片内容' }
  const ext = extOf(data)
  if (!ext) return { ok: false, error: '这不是能认出来的图片（png/jpg/gif/webp）' }
  const labels = cleanLabels(input.labels || [])

  try {
    mkdirSync(base, { recursive: true })
    const hash = createHash('sha1').update(data).digest('hex')
    const file = `${hash}.${ext}`
    const target = path.join(base, file)
    const indexFile = path.join(base, 'index.json')
    const index = readJson(indexFile, { version: 1, items: [] })
    const items = Array.isArray(index.items) ? index.items : []
    const existing = items.find((item) => item.file === file)

    if (existing) {
      existing.labels = cleanLabels([...(existing.labels || []), ...labels])
      existing.interested = true
      existing.addedAt = Number(input.now) || Date.now()
      writeJson(indexFile, { ...index, version: 1, items })
      return {
        ok: true,
        duplicated: true,
        item: { id: String(existing.id || hash.slice(0, 10)), file, labels: existing.labels, dir: base, path: target },
      }
    }

    writeFileSync(target, data)
    const item = {
      id: hash.slice(0, 10),
      sha1: hash,
      file,
      mediaType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
      bytes: data.length,
      labels,
      description: String(input.description || '').slice(0, 80),
      from: String(input.from || ''),
      source: String(input.source || ''),
      addedAt: Number(input.now) || Date.now(),
      interested: true,
    }
    const next = [...items, item].slice(-MAX_ITEMS)
    // 先写临时文件再换名：写到一半断电，不至于把整个表情库弄坏
    const tmp = indexFile + '.tmp'
    writeFileSync(tmp, JSON.stringify({ ...index, version: 1, items: next }, null, 2) + '\n', 'utf8')
    renameSync(tmp, indexFile)
    return { ok: true, duplicated: false, item: { ...item, dir: base, path: target } }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}
