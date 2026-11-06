/**
 * lib/wants.mjs — 需求记事本：他/她想要什么，主人有空再处理。
 *
 * 为什么值得单开一份文件：想要的东西和「记忆」不是一回事。
 *   记忆是已经发生的事实，需求是还没发生的事；混在 memory.json 里，
 *   既会被摘要压掉，也会让「我缺什么」这个问题永远答不出来。
 *
 * 一条需求只有四种状态：open（等着）/ done（有了）/ dropped（不要了）/ noted（记下但不算需求）。
 * 序号是给人看的（「给 TA 1」），id 是给程序看的；两个都要能定位。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const MAX_ITEMS = 300

function fileOf(dir) {
  return path.join(String(dir || '.'), 'wants.json')
}

function load(dir) {
  try {
    const parsed = JSON.parse(readFileSync(fileOf(dir), 'utf8'))
    return {
      version: 1,
      seq: Number(parsed?.seq) || 0,
      items: Array.isArray(parsed?.items) ? parsed.items : [],
    }
  } catch {
    return { version: 1, seq: 0, items: [] }
  }
}

function save(dir, data) {
  const file = fileOf(dir)
  try {
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

/** 加一条。同一句话重复提只累加 count，不再长一条 */
export function addWant(dir, input = {}) {
  const text = String(input.text || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!text) return { ok: false, error: '要记的需求是空的' }
  const data = load(dir)
  const key = text.toLowerCase()
  const existing = data.items.find((item) => String(item.text || '').toLowerCase() === key && item.status === 'open')
  if (existing) {
    existing.count = (Number(existing.count) || 1) + 1
    existing.at = Number(input.now) || Date.now()
    const saved = save(dir, data)
    return saved.ok ? { ok: true, duplicated: true, item: existing } : saved
  }
  data.seq += 1
  const item = {
    id: `W-${data.seq}`,
    text,
    why: String(input.why || '').slice(0, 200),
    status: 'open',
    count: 1,
    at: Number(input.now) || Date.now(),
  }
  data.items.push(item)
  data.items = data.items.slice(-MAX_ITEMS)
  const saved = save(dir, data)
  return saved.ok ? { ok: true, item } : saved
}

/** 所有需求（默认按时间倒序） */
export function listWants(dir, options = {}) {
  const data = load(dir)
  const status = String(options.status || '').trim()
  const rows = data.items
    .filter((item) => (status ? item.status === status : item.status !== 'dropped'))
    .slice()
    .reverse()
  return rows.map((item, index) => ({ ...item, no: index + 1 }))
}

/** 按序号（列表里的 no）或 id 找一条 */
function locate(items, target) {
  const key = String(target || '').trim()
  if (!key) return null
  if (/^\d+$/.test(key)) return items[Number(key) - 1] || null
  return items.find((item) => item.id === key) || null
}

export function resolveWant(dir, target, now = Date.now()) {
  const data = load(dir)
  const open = data.items.filter((item) => item.status === 'open').reverse()
  const item = locate(open, target)
  if (!item) return { ok: false, error: '没有这条需求' }
  item.status = 'done'
  item.resolvedAt = now
  const saved = save(dir, data)
  return saved.ok ? { ok: true, item } : saved
}

export function dropWant(dir, target) {
  const data = load(dir)
  const open = data.items.filter((item) => item.status === 'open').reverse()
  const item = locate(open, target)
  if (!item) return { ok: false, error: '没有这条需求' }
  item.status = 'dropped'
  item.droppedAt = Date.now()
  const saved = save(dir, data)
  return saved.ok ? { ok: true, item } : saved
}

export function wantStats(dir) {
  const data = load(dir)
  const count = (status) => data.items.filter((item) => item.status === status).length
  return { total: data.items.length, open: count('open'), done: count('done'), dropped: count('dropped') }
}
