/** 深蓝鲸的本地提醒（版权：用户） */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'

const EMPTY = { items: [], updatedAt: 0 }
const MIN_DELAY_MS = 5_000
const MAX_AHEAD_MS = 366 * 24 * 3_600_000

/** 全角数字/冒号先归一，后面的正则只认半角。 */
function normalize(text) {
  return String(text || '')
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/：/g, ':')
    .replace(/[ \t\u3000]+/g, ' ')
    .trim()
}

const CN_DIGIT = Object.freeze({ 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 })

/** 「九」「十一」「二十三」「半」→ 数字；不认识的返回 NaN。 */
export function cnNumber(raw) {
  const text = String(raw || '').trim()
  if (!text) return Number.NaN
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text)
  if (text === '半') return 30
  if (text === '十') return 10
  if (!/^[零〇一二两三四五六七八九十]+$/.test(text)) return Number.NaN
  // 只处理 0~59 这种两段式；「二十三」= 2*10+3，「十一」= 10+1
  const tenAt = text.indexOf('十')
  if (tenAt === -1) return CN_DIGIT[text] ?? Number.NaN
  const head = text.slice(0, tenAt)
  const tail = text.slice(tenAt + 1)
  const tens = head ? CN_DIGIT[head] : 1
  const ones = tail ? CN_DIGIT[tail] : 0
  if (tens === undefined || ones === undefined) return Number.NaN
  return tens * 10 + ones
}

function pad(n) {
  return String(n).padStart(2, '0')
}

/** 本地时间的一句话：今天 09:00 / 明天 09:00 / 11-08 09:00 */
export function describeAt(at, now = Date.now()) {
  const value = Number(at)
  if (!Number.isFinite(value)) return '这个时间'
  const target = new Date(value)
  const base = new Date(now)
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOf(target) - startOf(base)) / 86_400_000)
  const clock = `${pad(target.getHours())}:${pad(target.getMinutes())}`
  if (days === 0) return `今天 ${clock}`
  if (days === 1) return `明天 ${clock}`
  if (days === 2) return `后天 ${clock}`
  if (days === -1) return `昨天 ${clock}`
  const year = target.getFullYear() === base.getFullYear() ? '' : `${target.getFullYear()}-`
  return `${year}${pad(target.getMonth() + 1)}-${pad(target.getDate())} ${clock}`
}

/** 解析「几点」：返回 {hour, minute, period, text, index, end, nextDay} */
function parseClock(body) {
  // 先认 9:30 / 9点 / 九点半 / 晚上八点一刻
  const re = /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|晚间)?\s*(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*(?:[:：点时])\s*(?:(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*分?)?\s*(半|一刻|三刻)?/g
  const m = re.exec(body)
  if (!m) return null
  const hour = cnNumber(m[2])
  if (!Number.isFinite(hour) || hour > 24) return null
  let minute = m[3] ? cnNumber(m[3]) : 0
  if (m[4] === '半') minute = 30
  else if (m[4] === '一刻') minute = 15
  else if (m[4] === '三刻') minute = 45
  if (!Number.isFinite(minute) || minute > 59) return null
  const period = m[1] || ''
  let h = hour
  let nextDay = false
  if (period === '凌晨') {
    if (h === 12) { h = 0; nextDay = true }
  } else if (/^(早上|早晨|上午)$/.test(period)) {
    if (h === 12) h = 0
  } else if (period === '中午') {
    if (h > 0 && h < 6) h += 12
  } else if (/^(下午|傍晚)$/.test(period)) {
    if (h > 0 && h < 12) h += 12
  } else if (/^(晚上|夜里|晚间)$/.test(period)) {
    if (h === 12) { h = 0; nextDay = true }
    else if (h > 0 && h < 12) h += 12
  }
  return { hour: h, minute, period, text: m[0].trim(), index: m.index, end: m.index + m[0].length, nextDay }
}

/** 解析日期：绝对日期、今天/明天/后天、下周几。返回 {y,m,d,text,index,end,periodHint} */
function parseDay(body, now) {
  const base = new Date(now)
  let m = body.match(/(\d{4})\s*[年/-]\s*(\d{1,2})\s*[月/-]\s*(\d{1,2})\s*[日号]?/)
  if (m) {
    const y = Number(m[1])
    const mo = Number(m[2])
    const d = Number(m[3])
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return { y, m: mo - 1, d, text: m[0], index: m.index, end: m.index + m[0].length, periodHint: '' }
    }
  }
  m = body.match(/(\d{1,2})\s*[月/-]\s*(\d{1,2})\s*[日号]?/)
  if (m) {
    const mo = Number(m[1])
    const d = Number(m[2])
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      let y = base.getFullYear()
      const guess = new Date(y, mo - 1, d)
      // 「11 月 8 日」已经过去半年以上，按明年算；否则按今年。
      if (guess.getTime() < new Date(y, base.getMonth(), base.getDate()).getTime() - 180 * 86_400_000) y += 1
      return { y, m: mo - 1, d, text: m[0], index: m.index, end: m.index + m[0].length, periodHint: '' }
    }
  }
  const rel = body.match(/大后天|后天|明天|明日|明早|明晚|今天|今日|今晚|今早|今儿/)
  if (rel) {
    const word = rel[0]
    const offset = /大后天/.test(word) ? 3 : /后天/.test(word) ? 2 : /明天|明日|明早|明晚/.test(word) ? 1 : 0
    const target = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset)
    const periodHint = /明早|今早/.test(word) ? '早上' : /明晚|今晚/.test(word) ? '晚上' : /明日|明天/.test(word) ? '早上' : ''
    return {
      y: target.getFullYear(),
      m: target.getMonth(),
      d: target.getDate(),
      text: word,
      index: rel.index,
      end: rel.index + word.length,
      periodHint,
    }
  }
  const week = body.match(/(下)?(?:周|星期|礼拜)([一二三四五六日天])/)
  if (week) {
    const order = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }
    const want = order[week[2]]
    const current = base.getDay()
    let delta = (want - current + 7) % 7
    if (delta === 0) delta = 7
    // 「下周一」按最近的未来周一算；周几本身已经足够表达，不再机械加 7 天
    const target = new Date(base.getFullYear(), base.getMonth(), base.getDate() + delta)
    return {
      y: target.getFullYear(),
      m: target.getMonth(),
      d: target.getDate(),
      text: week[0],
      index: week.index,
      end: week.index + week[0].length,
      periodHint: '',
    }
  }
  return null
}

/**
 * 把一句话解析成一个绝对时间。
 *
 * 支持：
 *   5 分钟后 / 半小时后 / 2 小时之后 / 3 天后
 *   明天早上 9 点 / 今晚 8 点半 / 后天中午 12 点
 *   11 月 8 日 9:00 / 2026-11-08 09:00 / 9 点（下一次）
 *   1783...（毫秒或秒级时间戳）
 *
 * @returns {{ok:true, at:number, ms:number, matched:string, label:string}|{ok:false, error:string}}
 */
export function parseWhen(input, now = Date.now()) {
  const body = normalize(input)
  if (!body) return { ok: false, error: '没说什么时候提醒' }

  // 时间戳：10 位按秒，13 位按毫秒
  const digits = body.replace(/[^\d]/g, '')
  if (/^\d{10,13}$/.test(body.trim())) {
    const raw = Number(digits)
    const at = digits.length <= 10 ? raw * 1000 : raw
    if (at > now + MIN_DELAY_MS && at <= now + MAX_AHEAD_MS) {
      return { ok: true, at, ms: at - now, matched: body, label: describeAt(at, now) }
    }
    return { ok: false, error: '这个时间已经过去了，或者太远了' }
  }

  // 相对时长：必须带「后/之后/以后」，避免把「9 点」当分钟
  const rel = body.match(/(半|(?:\d+(?:\.\d+)?))\s*(个)?\s*(分钟|分|小时|钟头|天|周|星期)\s*(?:后|之后|以后)/)
  if (rel) {
    const n = rel[1] === '半' ? 0.5 : Number(rel[1])
    const unit = rel[3]
    const ms = unit === '天' ? n * 86_400_000
      : unit === '周' || unit === '星期' ? n * 7 * 86_400_000
        : /小时|钟头/.test(unit) ? n * 3_600_000
          : n * 60_000
    if (!(ms >= MIN_DELAY_MS)) return { ok: false, error: '提醒至少要设在 5 秒以后' }
    if (ms > MAX_AHEAD_MS) return { ok: false, error: '提醒最多只能设一年以内' }
    const at = now + ms
    return { ok: true, at, ms, matched: rel[0], label: describeAt(at, now) }
  }

  const clock = parseClock(body)
  const day = parseDay(body, now)
  if (!clock && !day) return { ok: false, error: '没看懂时间；写成「明天早上 9 点」或「5 分钟后」都行' }

  let y
  let m
  let d
  if (day) {
    y = day.y
    m = day.m
    d = day.d
  } else {
    const base = new Date(now)
    y = base.getFullYear()
    m = base.getMonth()
    d = base.getDate()
  }

  let hour = clock ? clock.hour : 9
  let minute = clock ? clock.minute : 0
  let nextDay = clock?.nextDay === true
  if (!clock) {
    if (day?.periodHint === '晚上') hour = 20
  } else if (!clock.period && day?.periodHint === '晚上') {
    // 「今晚 8 点」里的「晚」被日期词吃掉了，这里补回来
    if (hour === 12) { hour = 0; nextDay = true }
    else if (hour > 0 && hour < 12) hour += 12
  } else if (!clock.period && day?.periodHint === '中午') {
    if (hour > 0 && hour < 6) hour += 12
  }
  let at = new Date(y, m, d, hour, minute, 0, 0).getTime()
  if (nextDay) at += 86_400_000
  if (!day && at <= now + MIN_DELAY_MS) {
    // 只说了「9 点」：今天已经过了就顺延到明天
    at += 86_400_000
  }
  if (!(at > now + MIN_DELAY_MS)) return { ok: false, error: '这个时间已经过去了' }
  if (at > now + MAX_AHEAD_MS) return { ok: false, error: '提醒最多只能设一年以内' }
  const start = Math.min(day?.index ?? Infinity, clock?.index ?? Infinity)
  const end = Math.max(day?.end ?? -1, clock?.end ?? -1)
  const matched = Number.isFinite(start) && end > start ? body.slice(start, end) : (clock?.text || day?.text || body)
  return { ok: true, at, ms: at - now, matched, label: describeAt(at, now) }
}

/** 从聊天原话里抽出提醒内容和绝对时间。没有提醒意图时返回 null。 */
export function parseReminder(text, now = Date.now()) {
  const body = normalize(text)
  if (!body) return null
  const intent = /提醒我|叫我|记得|别忘了|别忘|提醒/.test(body)
  const relative = /(半|\d+(?:\.\d+)?)\s*(个)?\s*(分钟|分|小时|钟头|天|周|星期)\s*(?:后|之后|以后)/.test(body)
  if (!intent && !relative) return null

  const when = parseWhen(body, now)
  if (!when.ok) return null
  const intentRe = /(?:提醒我|叫我|记得|别忘了?|提醒)/
  // 不能拿整句去剥时间：一句话里常有「继续先测其他的」这种前文，
  // 也有「买苹果会写进提醒里嘛」这种后文。先按句号/逗号切成小分句，
  // 取**同时含时间词和提醒动词**的那一小句，再从动词后取内容。
  const pieces = body
    .split(/[。！？!?\n；;]/)
    .flatMap((line) => line.split(/[，,]/))
    .map((one) => one.trim())
    .filter(Boolean)
  const timed = pieces.filter((one) => one.includes(when.matched))
  const target = timed.find((one) => intentRe.test(one)) || timed[0] || body
  let rest = target.replace(when.matched, ' ')
  // 只剥到第一个提醒动词为止：前面的「要求 / 你给我定个」都是指令壳。
  rest = rest.replace(/^.*?(?:提醒我|叫我|记得|别忘了?|提醒)[，,：:\s]*/, '')
  rest = rest.replace(/^(?:你|我|给我|帮我|请|要求|要|定个|设个|定一个|设一个|一个)+[，,：:\s]*/, '')
  rest = rest.replace(/^[，,：:\s]+/, '').replace(/[，,：:\s]+$/, '').trim()
  // 「提醒我，明天9点，带文件」这种时间单独占一个分句：正文在相邻分句里。
  if (!rest) {
    const at = pieces.indexOf(target)
    const neighbour = [pieces[at + 1], pieces[at - 1]]
      .find((one) => one && !one.includes(when.matched) && !intentRe.test(one))
    if (neighbour) rest = neighbour
  }
  // 目标分句里没有正文时，退回整句去掉时间，至少别丢掉用户原话。
  if (!rest && target === body) rest = body.replace(when.matched, '').trim()
  if (!rest) rest = '时间到了'
  return { at: when.at, text: rest.slice(0, 180), ms: when.ms, matched: when.matched, label: when.label }
}

export class Reminders {
  constructor(options = {}) {
    this.file = path.join(String(options.dir || '.'), 'reminders.json')
    this.now = options.now || (() => Date.now())
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!Array.isArray(this.data.items)) this.data = { ...EMPTY, items: [] }
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

  /**
   * 记一条提醒。同一个人、同一时间（60 秒内）、同样内容只留一条 ——
   * 模型重试、用户连说两遍，都不该在到点时收到两遍一样的话。
   */
  add({ at, text, to }) {
    const when = Number(at) || 0
    const body = String(text || '').trim().slice(0, 180)
    const target = String(to || '')
    if (!when || !body || !target) return { ok: false, error: '提醒内容不完整' }
    const key = body.replace(/[\s，。！？、,.!?~～…—]/g, '')
    const duplicate = this.data.items.find((row) => {
      if (row.sent || String(row.to || '') !== target) return false
      if (Math.abs(Number(row.at) - when) > 60_000) return false
      return String(row.text || '').replace(/[\s，。！？、,.!?~～…—]/g, '') === key
    })
    if (duplicate) return { ok: true, item: duplicate, duplicated: true }
    const item = {
      id: 'R-' + this.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      at: when,
      text: body,
      to: target,
      sent: false,
      createdAt: this.now(),
    }
    this.data.items.push(item)
    // 条数上限只裁「已经发过的历史」，不能裁没发出去的提醒。
    // 以前是无差别 slice(-100)：攒到第 101 条时，最老的那条未发送提醒会静默消失，
    // 用户到点等不到，日志里也没有任何记录。
    if (this.data.items.length > 100) {
      const pending = this.data.items.filter((row) => !row.sent)
      const sent = this.data.items.filter((row) => row.sent)
      const room = Math.max(0, 100 - pending.length)
      const keep = room > 0 ? sent.slice(-room) : []
      this.data.items = [...keep, ...pending].sort((a, b) => {
        const left = Number(a.createdAt) || Number(a.at) || 0
        const right = Number(b.createdAt) || Number(b.at) || 0
        return left - right
      })
    }
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
