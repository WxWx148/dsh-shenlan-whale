/** 深蓝鲸的本地提醒（版权：用户） */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import path from 'node:path'

const EMPTY = { items: [], updatedAt: 0 }

export function parseReminder(text, now = Date.now()) {
  const body = String(text || '').replace(/\s+/g, ' ').trim()
  if (!body) return null
  let ms = 0
  const half = body.match(/半小时后|半个小时(?:后|之后)/)
  if (half) ms = 30 * 60_000
  if (!ms) {
    const m = body.match(/(\d+(?:\.\d+)?)\s*(分钟|分|小时|钟头|天)(?:后|之后)/)
    if (!m) return null
    const n = Number(m[1])
    const unit = m[2]
    ms = unit === '天' ? n * 86_400_000 : /小时|钟头/.test(unit) ? n * 3_600_000 : n * 60_000
  }
  if (!(ms >= 10_000)) return null
  let tail = body
    .replace(/^.*?(?:后|之后)/, '')
    .replace(/^[，,：:\s]*提醒我[，,：:\s]*/, '')
    .replace(/^[，,：:\s]*/, '')
    .trim()
  if (!tail || tail === body) {
    const after = body.replace(/^.*?提醒我[，,：:\s]*/, '').replace(/^.*?(?:后|之后)[，,：:\s]*/, '').trim()
    tail = after || '时间到了'
  }
  return { at: now + ms, text: tail.slice(0, 180), ms }
}

export class Reminders {
  constructor(options = {}) {
    this.file = path.join(String(options.dir || '.'), 'reminders.json')
    this.now = options.now || (() => Date.now())
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!Array.isArray(this.data.items)) this.data = { ...EMPTY }
    } catch {
      this.data = { ...EMPTY, items: [] }
    }
  }

  save() {
    mkdirSync(path.dirname(this.file), { recursive: true })
    this.data.updatedAt = this.now()
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8')
    renameSync(tmp, this.file)
  }

  add({ at, text, to }) {
    const item = { id: 'R-' + this.now().toString(36), at: Number(at) || 0, text: String(text || '').slice(0, 180), to: String(to || ''), sent: false, createdAt: this.now() }
    if (!item.at || !item.text || !item.to) return { ok: false, error: '提醒内容不完整' }
    this.data.items.push(item)
    this.data.items = this.data.items.slice(-100)
    this.save()
    return { ok: true, item }
  }

  due(now = this.now()) {
    return this.data.items.filter((item) => !item.sent && Number(item.at) <= now)
  }

  markSent(id) {
    const item = this.data.items.find((row) => row.id === id)
    if (!item) return { ok: false }
    item.sent = true
    item.sentAt = this.now()
    this.save()
    return { ok: true }
  }

  list() {
    return this.data.items.filter((item) => !item.sent).slice(-20)
  }

  update(id, patch = {}) {
    const item = this.data.items.find((row) => row.id === String(id || '') && !row.sent)
    if (!item) return { ok: false, error: '没有这条提醒' }
    if (patch.text) item.text = String(patch.text).slice(0, 180)
    const at = Number(patch.at)
    if (Number.isFinite(at) && at > this.now()) item.at = at
    this.save()
    return { ok: true, item }
  }

  cancel(id) {
    const item = this.data.items.find((row) => row.id === String(id || '') && !row.sent)
    if (!item) return { ok: false, error: '没有这条提醒' }
    item.sent = true
    item.cancelled = true
    item.sentAt = this.now()
    this.save()
    return { ok: true }
  }

  cancelAll(to) {
    const target = String(to || '')
    let count = 0
    for (const item of this.data.items) {
      if (!item.sent && (!target || item.to === target)) {
        item.sent = true
        item.cancelled = true
        item.sentAt = this.now()
        count += 1
      }
    }
    if (count) this.save()
    return count
  }
}
