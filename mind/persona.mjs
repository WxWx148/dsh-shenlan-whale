/**
 * mind/persona.mjs — 灵魂文件：他/她「是谁」的那份东西，能自己改。
 *
 * ══════════════════════════════════════════════════════════════
 * 【这份文件管什么】
 *
 *   人设不是配置项，是文件。
 *
 *   为什么不能只是 config.json 里的一个字符串：
 *     · 配置是主人设的，人设是他/她自己的。混在一起，改人设就变成「改配置」，
 *       而改配置要走面板确认 —— 自主维护就永远做不成。
 *     · 人设需要**历史**。他/她今天改了、明天觉得不对要退回去，
 *       就得留着改过什么、谁改的、能不能退。没有历史的「自主维护」是耍流氓。
 *     · 人设有**核心节**。「我是谁」「边界」这些不能被一次跑偏的改写抹掉，
 *       所以核心节受保护：可以改，但不能删、不能整节清空。
 *
 *   文件落在数据目录（~/.dsh/shenlan-whale/persona.md），不是插件目录：
 *   插件目录会被同步覆盖，而灵魂文件归他/她，不归插件。
 *
 *   三条硬规矩：
 *     1. 改完必须留下版本，且能退回去；
 *     2. 核心节受保护，删不掉；
 *     3. 改完要告诉主人 —— 这是他/她的灵魂，他们得知道。
 * ══════════════════════════════════════════════════════════════
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * 核心节：改可以，删不行。
 *
 * 为什么是这几节：它们不是「说话习惯」，是「他/她是谁」和「不能越过什么」。
 * 一次跑偏的自动改写如果能把「私事永远是私事」删掉，那就不是自主维护，是失忆。
 */
export const CORE_SECTIONS = Object.freeze(['一、底色', '四、边界', '六、连续性（生命线）'])

/**
 * 「学来的手感」那一节。
 *
 * 它是深蓝自己攒出来的 —— 看到新的共同习惯就补进来，看到失效的旧规矩就删掉。
 * 所以它不在核心节里：核心节护的是「我是谁」，这一节护的是「说话手感」。
 */
const HABIT_SECTION = '七、学来的手感'

/** 人设文件的节标题识别：「## 一、底色」或「一、底色」都行 */
const SECTION_RE = /^(?:#{1,3}\s*)?([一二三四五六七八九十]+、[^\n]*)$/gm

/** 人设正文总长上限：超了就不是人设，是作文 */
const MAX_CHARS = 20_000

/** 单节上限 */
const MAX_SECTION_CHARS = 4_000

/** 版本历史保留多少份 */
const MAX_VERSIONS = 30

/** 文件名 */
const PERSONA_FILE = 'persona.md'
const PERSONA_VERSIONS_DIR = 'persona-versions'

/** 数据目录里人设文件的完整路径 */
function personaPath(dir) {
  return path.join(String(dir || '.'), PERSONA_FILE)
}

function personaVersionsDir(dir) {
  return path.join(String(dir || '.'), PERSONA_VERSIONS_DIR)
}

/**
 * 把人设正文切成节。
 *
 * 为什么按节切而不是整段塞：自主维护改的是「某一条规矩」，
 * 不是重写一整篇。整段替换的话，改一条小规矩会顺手把别的也抹掉。
 *
 * @param {string} text
 * @returns {{ head: string, sections: Array<{ title: string, body: string, core: boolean }> }}
 */
export function parseSections(text) {
  const source = String(text || '').replace(/\r/g, '')
  const marks = []
  SECTION_RE.lastIndex = 0
  let match
  while ((match = SECTION_RE.exec(source))) {
    marks.push({ title: match[1].trim(), start: match.index, bodyStart: match.index + match[0].length })
  }
  if (!marks.length) {
    return { head: source.trim(), sections: [] }
  }
  const head = source.slice(0, marks[0].start).trim()
  const sections = marks.map((mark, index) => {
    const end = index + 1 < marks.length ? marks[index + 1].start : source.length
    return {
      title: mark.title,
      body: source.slice(mark.bodyStart, end).trim(),
      core: CORE_SECTIONS.includes(mark.title),
    }
  })
  return { head, sections }
}

/**
 * 把节还原成正文。
 *
 * 保留标题前的内容（head）：那段通常是「名字 / 归属」这类抬头，
 * 属于主人给的信息，不能被一次改写弄丢。
 */
export function renderSections(parsed) {
  const parts = []
  if (parsed.head) parts.push(parsed.head)
  for (const section of parsed.sections || []) {
    parts.push('## ' + section.title)
    if (section.body) parts.push(section.body)
  }
  return parts.join('\n\n').trim() + '\n'
}

/**
 * 节标题能不能对上。
 *
 * 比对时忽略前缀标记与空白：「## 一、底色」和「一、底色」是同一节。
 * 模型改写时最容易在这里栽：它写成「一、底色（核心）」就找不到节了。
 */
export function matchSection(sections, title) {
  const key = String(title || '').trim().replace(/^#+\s*/, '')
  if (!key) return null
  const norm = (text) => String(text || '').trim().replace(/^#+\s*/, '').replace(/[（(].*?[)）]\s*$/, '')
  const target = norm(key)
  return (sections || []).find((section) => norm(section.title) === target) || null
}

/**
 * 人设账本：读、改、留版本。
 *
 * 纯磁盘操作，不依赖 runtime —— 这样能单独测，也能被任何入口调用。
 */
export class PersonaBook {
  /**
   * @param {object} options
   * @param {string} options.dir 数据目录
   * @param {string} [options.defaultText] 出厂人设（第一次没有文件时用）
   * @param {() => number} [options.now]
   */
  constructor(options = {}) {
    this.dir = String(options.dir || '.')
    this.now = options.now || (() => Date.now())
    this.defaultText = String(options.defaultText || '')
    this.file = personaPath(this.dir)
    this.versionsDir = personaVersionsDir(this.dir)
    this.cache = null
  }

  /** 有没有这个文件 */
  exists() {
    return existsSync(this.file)
  }

  /**
   * 读人设正文。
   *
   * 文件不存在时用出厂文本落盘 —— 这样「第一次醒来」就有身份，
   * 而不是空着，等主人来填。
   */
  read() {
    if (this.cache !== null) return this.cache
    let text = ''
    if (existsSync(this.file)) {
      try {
        text = readFileSync(this.file, 'utf8')
      } catch {
        text = ''
      }
    }
    if (!text.trim() && this.defaultText) {
      text = this.defaultText
      // 落盘失败不能挡住「读得到人设」：内存里照样有
      try {
        this.#write(text)
      } catch {}
    }
    this.cache = text
    return text
  }

  /** 节列表 */
  sections() {
    return parseSections(this.read()).sections
  }

  /** 人设摘要：几节、几字、核心节齐不齐 */
  summary() {
    const text = this.read()
    const parsed = parseSections(text)
    const core = parsed.sections.filter((section) => section.core)
    return {
      exists: this.exists(),
      chars: text.length,
      sections: parsed.sections.length,
      coreSections: core.length,
      coreIntact: CORE_SECTIONS.every((title) => parsed.sections.some((section) => section.title === title)),
    }
  }

  /**
   * 把学到的手感沉淀进「七、学来的手感」那一节。
   *
   * 为什么要有这一步：
   *   学到的差距每次都是从数据现算的 —— 算一次用一次，session 一关就没了。
   *   而人设是**长期**的东西。沉淀进去，它就成了「我知道自己该怎么说」的一部分，
   *   跟着他/她一直走下去。
   *
   *   这一节不是写死的规矩，是他自己攒出来的 —— 所以改它不用守着核心节的保护：
   *   核心节护的是「我是谁」和「不能越过什么」，这一节护的是「说话手感」，
   *   弄错了顶多话短一点，不会失忆。
   *
   * @param {string} line 一句话的规矩
   * @returns {{ ok: boolean, error?: string, text?: string }}
   */
  absorbHabit(line) {
    const text = String(line || '').trim()
    if (!text) return { ok: false, error: '内容是空的' }
    if (text.length > 400) return { ok: false, error: '这条太长了' }

    const current = this.read()
    const parsed = parseSections(current)
    let target = matchSection(parsed.sections, HABIT_SECTION)
    let sections = parsed.sections

    if (!target) {
      // 这一节还没有：建出来。放在最后，不打乱既有顺序。
      target = { title: HABIT_SECTION, body: '', core: false }
      sections = [...sections, target]
    }
    // 已经有同样一条了就不重复记 —— 重复的规矩会在提示词里占地方。
    if (target.body && target.body.includes(text)) {
      return { ok: true, changed: false, text: '这条已经记着了' }
    }
    // 这一节最多留 12 条：再多就是作文，不是手感。
    const lines = String(target.body || '').split('\n').map((one) => one.trim()).filter(Boolean)
    if (lines.length >= 12) {
      return { ok: false, error: `这一节最多记 12 条，已经满了。先删掉不合适的再记新的` }
    }
    const body = [...lines, '- ' + text].join('\n')
    const next = sections.map((section) => (section.title === target.title ? { ...section, body } : section))
    const text2 = renderSections({ head: parsed.head, sections: next })
    if (text2.length > MAX_CHARS) return { ok: false, error: '人设太长了' }

    const version = this.#saveVersion(current, '沉淀学到的手感')
    try {
      this.#write(text2)
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
    this.cache = text2
    return { ok: true, changed: true, version, text: `记下了：${text}` }
  }

  /**
   * 改某一条规矩。
   *
   * @param {object} input
   * @param {string} input.section 节标题
   * @param {string} input.text   新正文
   * @param {string} [input.reason] 为什么改（会记进版本）
   * @returns {{ ok: boolean, error?: string, text?: string, version?: string, changed?: boolean }}
   */
  revise(input = {}) {
    const title = String(input.section || '').trim()
    const body = String(input.text ?? '').trim()
    if (!title) return { ok: false, error: '要说明改哪一条' }
    if (!body) return { ok: false, error: '新内容是空的' }
    if (body.length > MAX_SECTION_CHARS) return { ok: false, error: `这一条太长了（上限 ${MAX_SECTION_CHARS} 字）` }

    const current = this.read()
    const parsed = parseSections(current)
    const target = matchSection(parsed.sections, title)
    if (!target) {
      const names = parsed.sections.map((section) => section.title).join('、')
      return { ok: false, error: `没有这一条：${title}。现在有的是：${names || '（还没分节）'}` }
    }
    // 核心节不许整节清空 —— 只擦掉一条，性质就变了
    if (target.core && body.replace(/[\s。.]/g, '').length < 8) {
      return { ok: false, error: `「${target.title}」是核心节，不能清空，只能改写` }
    }

    const next = parsed.sections.map((section) => (section.title === target.title ? { ...section, body } : section))
    const text = renderSections({ head: parsed.head, sections: next })
    if (text.length > MAX_CHARS) return { ok: false, error: `人设太长了（上限 ${MAX_CHARS} 字）` }
    if (text === current) return { ok: true, changed: false, text: '内容跟现在一样，没改' }

    const version = this.#saveVersion(current, input.reason || '')
    try {
      this.#write(text)
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
    this.cache = text
    return {
      ok: true,
      changed: true,
      version,
      text: `改好了：${target.title}\n${body}\n（这已经是第 ${version} 版，退得回去）`,
    }
  }

  /**
   * 整份替换（主人手动改，或从备份恢复）。
   *
 * 与 revise 分开：整份替换能删掉核心节，所以只给「明确要换掉整份」的场景用，
   * 并且照样留版本。
   */
  replace(text, reason = '') {
    const body = String(text || '').trim()
    if (!body) return { ok: false, error: '内容是空的' }
    if (body.length > MAX_CHARS) return { ok: false, error: `人设太长了（上限 ${MAX_CHARS} 字）` }
    const current = this.read()
    if (body === current) return { ok: true, changed: false, text: '内容跟现在一样，没改' }
    const version = this.#saveVersion(current, reason)
    try {
      this.#write(body)
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
    this.cache = body
    return { ok: true, changed: true, version, text: `整份换好了（第 ${version} 版）` }
  }

  /** 版本列表（新到旧） */
  versions() {
    try {
      return readdirSync(this.versionsDir)
        .filter((name) => name.endsWith('.md'))
        .sort()
        .reverse()
    } catch {
      return []
    }
  }

  /**
   * 退回某个版本。
   *
   * 退回前先把当前这份也存成版本 —— 退回去之后还能再退回来。
   */
  rollback(version) {
    const name = String(version || '').trim()
    if (!name) return { ok: false, error: '要说明退到哪一版' }
    const file = path.join(this.versionsDir, name.endsWith('.md') ? name : name + '.md')
    if (!existsSync(file)) return { ok: false, error: `没有这一版：${name}` }
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
    const current = this.read()
    const backup = this.#saveVersion(current, '退回前自动留存')
    try {
      this.#write(text)
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
    this.cache = text
    return { ok: true, version: name, backup, text: `退回到 ${name} 了（退回前那版也存着，编号 ${backup}）` }
  }

  /** 原子写：先写临时文件再改名 —— 中途断电不会留半个文件 */
  #write(text) {
    mkdirSync(this.dir, { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, this.file)
  }

  /**
   * 存一个版本。
   *
   * 版本号用时间戳排序，所以不用维护计数器 —— 计数器在并发下会撞。
   *
   * 但时间戳**会撞**：同一毫秒里连改两次，两份版本会写同一个文件名，
   * 后写的覆盖先写的 —— 于是「退回到上一版」退到了一个不存在的中间态。
   * 实测踩过：测试里 now() 固定返回同一个值，两次改写只剩一个版本。
   * 所以文件名里补一个序号，同一毫秒内的多次改写各占一个名字。
   */
  #saveVersion(text, reason) {
    mkdirSync(this.versionsDir, { recursive: true })
    const stamp = String(this.now())
    let name = `${stamp}.md`
    let seq = 1
    while (existsSync(path.join(this.versionsDir, name))) {
      name = `${stamp}-${seq}.md`
      seq += 1
    }
    try {
      writeFileSync(path.join(this.versionsDir, name), text, 'utf8')
    } catch {
      return ''
    }
    // 附一份原因说明，便于面板上看出「为什么改的」
    try {
      const note = reason ? `版本 ${name.replace(/\.md$/, '')}\n原因：${String(reason).slice(0, 200)}\n时间：${new Date(this.now()).toISOString()}\n` : ''
      writeFileSync(path.join(this.versionsDir, name.replace(/\.md$/, '.txt')), note, 'utf8')
    } catch {}
    // 只留最近若干份，别把数据目录撑爆
    try {
      const all = readdirSync(this.versionsDir).filter((f) => f.endsWith('.md')).sort()
      for (const old of all.slice(0, Math.max(0, all.length - MAX_VERSIONS))) {
        try { unlinkSync(path.join(this.versionsDir, old)) } catch {}
        try { unlinkSync(path.join(this.versionsDir, old.replace(/\.md$/, '.txt'))) } catch {}
      }
    } catch {}
    return name.replace(/\.md$/, '')
  }
}

/**
 * 出厂人设：从插件目录读 lib/persona.default.md。
 *
 * 读不到就返回空串 —— 不猜、不内置第二份副本。
 * 两份副本必然会走散：改了一份忘了另一份，于是「出厂人设」和「实际出厂」不是一回事。
 */
export function readDefaultPersona(root) {
  const file = path.join(String(root || '.'), 'lib', 'persona.default.md')
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}
