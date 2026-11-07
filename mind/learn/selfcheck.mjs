/**
 * mind/selfcheck.mjs — 自查复盘的结论账本。
 *
 * 参考实现里「鱼」的做法：它查出代码里的问题会写一份报告交给主人，
 * 自己不改代码；主人处理完要写一个 done 标记，否则它下次查
 * my_patch_proposals 仍是 pending，会把同一个问题再提一遍。
 *
 * 这个闭环的价值不在「存了份文件」，而在**同一问题不会反复被提出**：
 * 截图中主人连说三次「查代码给结论」，如果每次都从零开始，就永远是
 * 「在查」而没有结论。所以这里做三件事：报告落盘、状态标记、内容去重。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const STATUS = Object.freeze({
  PENDING: 'pending',
  DONE: 'done',
  REJECTED: 'rejected',
  DUPLICATE: 'duplicate',
})

function digest(text) {
  return createHash('sha1').update(String(text || '').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16)
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

export class SelfCheckBook {
  constructor({ dir, now, log } = {}) {
    this.dir = path.join(String(dir || '.'), 'selfcheck')
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.log = typeof log === 'function' ? log : () => {}
    try { mkdirSync(this.dir, { recursive: true }) } catch {}
    this.seq = 0
  }

  #file(id, suffix = '.md') {
    return path.join(this.dir, id + suffix)
  }

  /** 提一份结论。内容相同且还没处理时直接判重复，不新建文件 */
  propose({ title = '自查结论', body = '', source = 'owner' } = {}) {
    const text = String(body || '').trim()
    if (!text) return { ok: false, error: '结论是空的' }
    const hash = digest(text)
    const existing = this.list().find((row) => row.hash === hash && row.status === STATUS.PENDING)
    if (existing) return { ok: true, duplicate: true, id: existing.id, status: STATUS.PENDING }

    this.seq += 1
    const at = this.now()
    const id = `check-${at}-${this.seq}`
    const front = `---\ntitle: ${String(title).replace(/[\r\n]/g, ' ')}\nstatus: ${STATUS.PENDING}\nsource: ${source}\nhash: ${hash}\nat: ${at}\n---\n\n`
    try {
      writeFileSync(this.#file(id), front + text + '\n', 'utf8')
      this.log('selfcheck_proposed', { id, hash, source })
      return { ok: true, id, status: STATUS.PENDING, duplicate: false }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }

  /** 主人处理完写标记。没有这一步，同一个问题会一直被重复提交 */
  markDone(id, status = STATUS.DONE, note = '') {
    const file = this.#file(String(id || ''))
    if (!existsSync(file)) return { ok: false, error: '没有这份结论' }
    const final = [STATUS.DONE, STATUS.REJECTED, STATUS.DUPLICATE].includes(status) ? status : STATUS.DONE
    try {
      writeFileSync(this.#file(String(id), '.done.json'), JSON.stringify({ status: final, note: String(note || ''), at: this.now() }, null, 2), 'utf8')
      this.log('selfcheck_closed', { id: String(id), status: final })
      return { ok: true, status: final }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }

  list() {
    let files = []
    try { files = readdirSync(this.dir).filter((name) => name.endsWith('.md')) } catch { return [] }
    return files.map((name) => {
      const id = name.slice(0, -3)
      const raw = readFileSync(this.#file(id), 'utf8')
      const meta = Object.fromEntries(
        (raw.match(/^---\n([\s\S]*?)\n---/) || ['', ''])[1]
          .split('\n')
          .filter((line) => line.includes(': '))
          .map((line) => {
            const cut = line.indexOf(': ')
            return [line.slice(0, cut), line.slice(cut + 2)]
          }),
      )
      const done = readJson(this.#file(id, '.done.json'), null)
      const body = raw.replace(/^---\n[\s\S]*?\n---\n\n/, '').trim()
      return {
        id,
        title: meta.title || id,
        hash: meta.hash || digest(body),
        source: meta.source || '',
        at: Number(meta.at) || 0,
        status: done?.status || STATUS.PENDING,
        note: done?.note || '',
        preview: body.slice(0, 160),
      }
    }).sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
  }

  summary() {
    const rows = this.list()
    return {
      total: rows.length,
      pending: rows.filter((row) => row.status === STATUS.PENDING).length,
      done: rows.filter((row) => row.status === STATUS.DONE).length,
      latest: rows[0] || null,
    }
  }
}
