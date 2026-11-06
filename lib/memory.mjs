/**
 * lib/memory.mjs — 深蓝鲸的本地长期记忆（版权：用户）
 * ============================================================================
 * 只做三件事：记住事实、记住人、按当前对话取一小段。
 *   - 不自动猜，不把整段聊天塞进去；
 *   - 所有内容只在本机 ~/.dsh/shenlan-whale/memory.json；
 *   - 读坏文件不炸插件，回退空记忆。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const EMPTY = { facts: [], people: {}, groups: {}, self: [], updatedAt: 0 }

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s，。！？、,.!?;；:："'“”‘’()（）【】\[\]-]/g, '')
}

function brief(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/** 中文用相邻二字估算相关度，避免只靠“包含整句”导致旧记忆永远取不到 */
function grams(text) {
  const value = normalize(text)
  const out = []
  for (let i = 0; i < value.length - 1; i += 1) out.push(value.slice(i, i + 2))
  return out
}

function overlap(a, b) {
  const left = new Set(grams(a))
  let hits = 0
  for (const token of new Set(grams(b))) if (left.has(token)) hits += 1
  return hits
}

export class WhaleMemory {
  constructor(options = {}) {
    this.dir = String(options.dir || '.')
    this.file = path.join(this.dir, 'memory.json')
    this.now = options.now || (() => Date.now())
    this.maxEntries = Math.max(100, Math.min(100_000, Number(options.maxEntries) || 8000))
    this.summaryEvery = Math.max(20, Math.min(2000, Number(options.summaryEvery) || 200))
    this.netEntries = Math.max(1, Math.min(6, Number(options.netEntries) || 2))
    this.netHops = Math.max(1, Math.min(12, Number(options.netHops) || 6))
    this.netDecay = Math.max(0.5, Math.min(1, Number(options.netDecay) || 0.82))
    this.data = this.#load()
  }

  #load() {
    try {
      if (!existsSync(this.file)) return { ...EMPTY, facts: [], people: {}, groups: {} }
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      return {
        facts: Array.isArray(parsed.facts) ? parsed.facts : [],
        people: parsed.people && typeof parsed.people === 'object' ? parsed.people : {},
        groups: parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {},
        self: Array.isArray(parsed.self) ? parsed.self : [],
        updatedAt: Number(parsed.updatedAt) || 0,
      }
    } catch {
      return { ...EMPTY, facts: [], people: {}, groups: {} }
    }
  }

  #save() {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      this.data.updatedAt = this.now()
      writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8')
      renameSync(tmp, this.file)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }

  facts() {
    return Array.isArray(this.data.facts) ? this.data.facts : []
  }

  rememberFact(text, meta = {}) {
    const body = brief(text, 300)
    if (!body) return { ok: false, error: '空内容' }
    const key = normalize(body)
    const existing = this.facts().find((item) => normalize(item.text) === key)
    if (existing) {
      existing.at = this.now()
      existing.hits = (Number(existing.hits) || 1) + 1
      this.#save()
      return { ok: true, duplicated: true, item: existing }
    }
    const item = { id: `F-${this.now().toString(36)}`, text: body, at: this.now(), hits: 1, source: brief(meta.source, 80) }
    this.data.facts.push(item)
    this.data.facts = this.data.facts.slice(-this.maxEntries)
    if (this.data.facts.length % this.summaryEvery === 0) {
      const chunk = this.data.facts.slice(-this.summaryEvery)
      this.data.summaries = Array.isArray(this.data.summaries) ? this.data.summaries : []
      this.data.summaries.push({ at: this.now(), text: chunk.map((item) => item.text).join('；').slice(0, 2000) })
      this.data.summaries = this.data.summaries.slice(-20)
    }
    this.#save()
    return { ok: true, item }
  }

  forgetFact(target) {
    const key = String(target || '').trim()
    // 空键必须在这里挡住：下面用的是 `includes(normalize(key))`，
    // 而任何字符串都 includes('') —— 放过去就不是「没找到一条」，
    // 而是把整本事实清空。面板漏传一个字段就能触发，代价是全部记忆。
    if (!normalize(key)) return { ok: false, error: '没说要忘哪条' }
    const before = this.facts()
    const next = before.filter((item) => item.id !== key && !normalize(item.text).includes(normalize(key)))
    if (next.length === before.length) return { ok: false, error: '没找到' }
    this.data.facts = next
    this.#save()
    return { ok: true, removed: before.length - next.length }
  }

  clearFacts() {
    const count = this.facts().length
    this.data.facts = []
    this.#save()
    return { ok: true, removed: count }
  }

  person(uin) {
    return this.data.people[String(uin || '')] || null
  }

  group(groupId) {
    return this.data.groups[String(groupId || '')] || null
  }

  /** 每个群只留最近 5 个话题，重启后仍能知道这里聊过什么 */
  rememberGroup(groupId, patch = {}) {
    const id = String(groupId || '').replace(/\D/g, '')
    if (!id) return { ok: false, error: '没有群号' }
    const entry = this.data.groups[id] || { groupId: id, label: '', topics: [], lastAt: 0 }
    if (patch.label) entry.label = brief(patch.label, 40)
    const topic = brief(patch.topic, 120)
    if (topic && !entry.topics.some((item) => normalize(item) === normalize(topic))) entry.topics.push(topic)
    entry.topics = entry.topics.slice(-5)
    entry.lastAt = this.now()
    this.data.groups[id] = entry
    this.#save()
    return { ok: true, group: entry }
  }

  rememberPerson(uin, patch = {}) {
    const id = String(uin || '').replace(/\D/g, '')
    if (!id) return { ok: false, error: '没有 QQ 号' }
    const person = this.data.people[id] || { uin: id, name: '', notes: [], impression: '', lastAt: 0 }
    if (patch.name) person.name = brief(patch.name, 40)
    if (patch.impression) person.impression = brief(patch.impression, 120)
    if (patch.note) {
      const note = brief(patch.note, 160)
      if (note && !person.notes.some((item) => normalize(item) === normalize(note))) person.notes.push(note)
      person.notes = person.notes.slice(-20)
    }
    person.lastAt = this.now()
    this.data.people[id] = person
    this.#save()
    return { ok: true, person }
  }

  /** 给提示词用：只取少量事实和当前这个人 */
  digest(options = {}) {
    const query = normalize(options.query)
    const now = Number(options.at) || this.now()
    const all = this.facts().map((item) => {
      const text = String(item.text || '')
      const related = query ? overlap(query, text) : 0
      const exact = query && (normalize(text).includes(query) || query.includes(normalize(text))) ? 12 : 0
      const ageDays = Math.max(0, now - (Number(item.at) || now)) / 86_400_000
      const recency = 2 / (1 + ageDays / 7)
      const hits = Math.min(8, Number(item.hits) || 1) * 0.6
      return { item, score: related * 2 + exact + recency + hits }
    })
    const ordered = all.filter((row) => (query ? row.score > 1 : true)).sort((a, b) => b.score - a.score)
    const picked = ordered.slice(0, 6).map((row) => row.item)
    const network = []
    const seen = new Set(picked.map((item) => item.id))
    let frontier = picked.slice(0, this.netEntries)
    let weight = 1
    for (let hop = 0; hop < this.netHops && frontier.length; hop += 1) {
      weight *= this.netDecay
      const next = []
      for (const item of frontier) {
        const neighbors = all
          .filter((row) => !seen.has(row.item.id) && overlap(normalize(item.text), row.item.text) > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, this.netEntries)
        for (const row of neighbors) {
          seen.add(row.item.id)
          network.push({ ...row.item, score: weight })
          next.push(row.item)
        }
      }
      frontier = next
    }
    if (picked.length) {
      for (const item of picked) item.hits = (Number(item.hits) || 1) + 1
      this.#save()
    }
    const related = all
      .filter((row) => !picked.includes(row.item))
      .filter((row) => (query ? overlap(query, row.item.text) > 0 : false))
      .slice(0, 3)
      .map((row) => row.item)
    const person = options.forUser ? this.person(options.forUser) : null
    return {
      facts: picked,
      summary: Array.isArray(this.data.summaries) && this.data.summaries.length ? this.data.summaries[this.data.summaries.length - 1].text : '',
      network: network.slice(0, 12),
      related,
      self: this.selfNotes(),
      person: person ? { ...person, notes: [...(person.notes || [])].slice(-6) } : null,
      group: options.groupId ? this.group(options.groupId) : null,
    }
  }

  /** 用已有群事件回填群快照（只补 topic，不碰事实/人物） */
  backfillGroups(eventsFile) {
    try {
      if (!existsSync(eventsFile)) return { changed: 0 }
      const rows = readFileSync(eventsFile, 'utf8').split('\n')
      let changed = 0
      for (const line of rows) {
        if (!line.trim()) continue
        try {
          const row = JSON.parse(line)
          const groupId = String(row?.group || row?.payload?.groupId || '').replace(/\D/g, '')
          if (row?.scope !== 'group' || !groupId || !row?.text) continue
          const entry = this.data.groups[groupId] || { groupId, label: '', topics: [], lastAt: 0 }
          if (!entry.topics.includes(row.text)) {
            entry.topics.push(row.text)
            entry.topics = entry.topics.slice(-5)
            entry.lastAt = Math.max(Number(entry.lastAt) || 0, Number(row.at) || 0)
            this.data.groups[groupId] = entry
            changed += 1
          }
        } catch {}
      }
      if (changed) this.#save()
      return { changed }
    } catch {
      return { changed: 0 }
    }
  }

  selfNotes() {
    return (this.data.self || []).slice(-12)
  }

  rememberSelf(text) {
    const value = brief(text, 160)
    if (!value) return { ok: false, error: '内容是空的' }
    if (!this.data.self) this.data.self = []
    if (!this.data.self.some((item) => normalize(item.text) === normalize(value))) {
      this.data.self.push({ text: value, at: this.now() })
      this.data.self = this.data.self.slice(-40)
      this.#save()
    }
    return { ok: true, text: value }
  }

  forgetSelf(text) {
    const before = this.data.self?.length || 0
    this.data.self = (this.data.self || []).filter((item) => normalize(item.text) !== normalize(text))
    if (this.data.self.length !== before) this.#save()
    return { ok: before !== this.data.self.length }
  }

  updateSelf(oldText, newText) {
    const item = (this.data.self || []).find((row) => normalize(row.text) === normalize(oldText))
    if (!item) return { ok: false, error: '没有这条自我记忆' }
    item.text = brief(newText, 160)
    item.at = this.now()
    this.#save()
    return { ok: true, text: item.text }
  }

  updateFact(oldText, newText) {
    const item = this.data.facts.find((row) => normalize(row.text) === normalize(oldText))
    if (!item) return { ok: false, error: '没有这条事实' }
    const text = brief(newText, 160)
    if (!text) return { ok: false, error: '不能改成空的' }
    item.text = text
    item.at = this.now()
    this.#save()
    return { ok: true, text }
  }

  updatePerson(uin, patch = {}) {
    const id = String(uin || '').replace(/\D/g, '')
    const person = this.data.people[id]
    if (!id || !person) return { ok: false, error: '没有这个人' }
    if (patch.name) person.name = brief(patch.name, 40)
    if (patch.impression) person.impression = brief(patch.impression, 120)
    if (patch.note) {
      const note = brief(patch.note, 160)
      if (note) person.notes = [...(person.notes || []), note].slice(-20)
    }
    person.lastAt = this.now()
    this.#save()
    return { ok: true, person }
  }

  updateGroup(groupId, patch = {}) {
    const id = String(groupId || '').replace(/\D/g, '')
    const entry = this.data.groups[id]
    if (!id || !entry) return { ok: false, error: '没有这个群' }
    if (patch.label) entry.label = brief(patch.label, 40)
    if (patch.topic) entry.topics = [...(entry.topics || []), brief(patch.topic, 120)].slice(-5)
    entry.lastAt = this.now()
    this.#save()
    return { ok: true, group: entry }
  }

  forgetPerson(uin) {
    const id = String(uin || '').replace(/\D/g, '')
    if (!id || !this.data.people[id]) return { ok: false, error: '没有这个人' }
    delete this.data.people[id]
    this.#save()
    return { ok: true, removed: id }
  }

  forgetGroup(groupId) {
    const id = String(groupId || '').replace(/\D/g, '')
    if (!id || !this.data.groups[id]) return { ok: false, error: '没有这个群' }
    delete this.data.groups[id]
    this.#save()
    return { ok: true, removed: id }
  }

  stats() {
    return { facts: this.facts().length, people: Object.keys(this.data.people || {}).length, groups: Object.keys(this.data.groups || {}).length, updatedAt: this.data.updatedAt || 0 }
  }
}

/** 主人私聊里的记忆命令；识别就返回要直接发的话，不经过模型 */
export function memoryCommand(text, memory) {
  if (!memory) return null
  const body = String(text || '').trim()
  if (!body) return null
  if (/^(记住|请记住)(了)?[，,：:]?/.test(body)) {
    const fact = body.replace(/^(记住|请记住)(了)?[，,：:]?\s*/, '')
    if (!fact) return { text: '要记什么？' }
    memory.rememberFact(fact, { source: 'owner' })
    return { text: '记住了：' + fact.slice(0, 80) }
  }
  if (/^(忘记一切|清空记忆)/.test(body)) {
    const result = memory.clearFacts()
    return { text: result.removed ? `清掉了 ${result.removed} 条事实记忆。` : '现在没有事实记忆。' }
  }
  if (/^(忘掉|忘记)[，,：:]?\s*(.+)$/.test(body)) {
    const target = body.replace(/^(忘掉|忘记)[，,：:]?\s*/, '')
    const result = memory.forgetFact(target)
    return { text: result.ok ? `忘了：${target.slice(0, 60)}` : '没找到这条记忆。' }
  }
  if (/^(你记得|记得什么|记忆|你都记得)/.test(body)) {
    const facts = memory.facts().slice(-8)
    const people = Object.values(memory.data.people || {}).slice(-5)
    const lines = []
    if (facts.length) lines.push('事实：', ...facts.map((item) => `- ${item.text}`))
    if (people.length) lines.push('人物：', ...people.map((item) => `- ${item.name || item.uin}`))
    return { text: lines.length ? lines.join('\n').slice(0, 900) : '记忆还是空的。' }
  }
  return null
}
