/**
 * ability/browser.mjs — 操控本机浏览器
 * ============================================================================
 * 和「截图」的区别：截图只要一张图；这里是**有状态的浏览**——打开、读页面、
 * 点第 N 个控件、往第 N 个输入框打字、滚动、前进后退，会话保持到你关掉或超时。
 *
 * 两种接法：
 *   1. 自己起一个（默认）：独立 user-data-dir，登录态留在本机，关掉不影响你日常浏览器；
 *   2. 连你正在用的（`browserCdpUrl`，例如 http://127.0.0.1:9222）：需要你启动 Chrome 时
 *      加 `--remote-debugging-port=9222`；这样能用你已登录的网站。
 *
 * 页面是「纯文本 + 编号控件」，不靠截图；默认拒绝本机/内网地址，避免变成打内网服务的通道。
 * ============================================================================
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path, { join } from 'node:path'

import { CdpSession, closeTarget, findBrowser, freePort, killTree, launchBrowser, newTarget, waitForDevTools } from './cdp.mjs'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function checkTargetUrl(raw) {
  try {
    const u = new URL(String(raw || ''))
    if (!/^https?:$/.test(u.protocol)) return { ok: false, why: '只允许 http(s)' }
    const host = u.hostname.toLowerCase()
    if (/^(localhost|127\.|0\.0\.0\.0|::1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || /\.local$/.test(host)) return { ok: false, why: '拒绝本机/内网地址' }
    return { ok: true, url: u.toString() }
  } catch { return { ok: false, why: '链接不合法' } }
}
import { homedir } from 'node:os'
const stateHome = () => process.env.DSH_HOME || path.join(homedir(), '.dsh')

let session = null

/** 页面里收集编号控件的脚本（每次快照重排，编号只在本次有效） */
const SNAPSHOT_JS = `(() => {
  const selector = 'a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]'
  const visible = (el) => {
    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    if (rect.width < 2 || rect.height < 2) return false
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false
    if (rect.bottom < -200 || rect.top > innerHeight + 2000) return false
    return true
  }
  // 先清掉上一轮的编号，避免「旧元素还带着 3，新元素也叫 3」导致点错
  document.querySelectorAll('[data-qqfish-idx]').forEach((el) => el.removeAttribute('data-qqfish-idx'))
  const nodes = [...document.querySelectorAll(selector)].filter(visible).slice(0, 80)
  const items = nodes.map((el, index) => {
    el.setAttribute('data-qqfish-idx', String(index))
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || el.id || '').replace(/\\s+/g, ' ').trim().slice(0, 60)
    return {
      i: index,
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute('type') || '').toLowerCase(),
      text: label,
      href: el.href ? String(el.href).slice(0, 120) : '',
    }
  })
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim()
  return { title: document.title, url: location.href, text: text.slice(0, 12000), items }
})()`

function idleMs(config) {
  return Math.min(120, Math.max(1, Number(config && config.browserIdleMinutes) || 10)) * 60_000
}

/** 会话还活着吗（进程没退、CDP 没断） */
function sessionAlive() {
  if (!session) return false
  if (session.cdp && session.cdp.closed) return false
  if (session.child && session.child.exitCode !== null) return false
  return true
}

/** 关掉当前会话（自己起的会连进程一起收掉） */
export async function closeSession() {
  const current = session
  session = null
  if (!current) return
  try {
    await closeTarget(current.port, current.targetId)
  } catch {}
  try {
    current.cdp.close()
  } catch {}
  if (current.mode === 'launch') {
    if (current.child && current.child.pid) killTree(current.child.pid)
    await sleep(150)
    try {
      rmSync(current.userDataDir, { recursive: true, force: true })
    } catch {}
  }
}

/** 从 browserCdpUrl 里拆出 host/port */
function parseCdpUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim())
    const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80)
    return { host: parsed.hostname || '127.0.0.1', port }
  } catch {
    return null
  }
}

/**
 * 保证有一个可用的浏览器会话。
 * @param {object} config
 * @returns {Promise<{ok:true, cdp:CdpSession} | {ok:false, code:string, error:string}>}
 */
async function ensureSession(config = {}) {
  if (sessionAlive()) {
    if (Date.now() - session.lastUsedAt > idleMs(config)) await closeSession()
    else {
      session.lastUsedAt = Date.now()
      return { ok: true, cdp: session.cdp }
    }
  }
  if (session) await closeSession()

  const headless = config.browserHeadless !== false
  const cdpUrl = String(config.browserCdpUrl || '').trim()
  let child = null
  let userDataDir = ''
  let port = 0
  let mode = 'launch'
  let targetId = ''

  try {
    if (cdpUrl) {
      const parsed = parseCdpUrl(cdpUrl)
      if (!parsed) return { ok: false, code: 'bad-config', error: '浏览器 CDP 地址不合法（例：http://127.0.0.1:9222）' }
      mode = 'attach'
      port = parsed.port
      const info = await waitForDevTools(port, 6000)
      if (!info) {
        return {
          ok: false,
          code: 'not-running',
          error: `连不上 ${cdpUrl}：先用 --remote-debugging-port=${parsed.port} 启动 Chrome，或把面板里的「浏览器 CDP 地址」清空，让它自己起一个`,
        }
      }
    } else {
      const browser = findBrowser(config.renderBrowserPath)
      if (!browser) return { ok: false, code: 'no-browser', error: '没找到 Chrome / Edge：装一个，或者在面板「设置 → 能力开关 → 浏览器程序」里指定它的位置' }
      userDataDir =
        String(config.browserProfileDir || '').trim() || join(stateHome(), 'browser-profile')
      mkdirSync(userDataDir, { recursive: true })
      port = await freePort()
      child = launchBrowser({ browserPath: browser, userDataDir, headless, port })
      const info = await waitForDevTools(port, 15_000)
      if (!info) return { ok: false, code: 'launch-failed', error: '浏览器没起来（可能被安全软件拦住）' }
    }

    const created = await newTarget(port)
    targetId = created.id
    if (!created.webSocketDebuggerUrl) return { ok: false, code: 'no-target', error: '浏览器没有返回可调试的标签页' }
    const cdp = await CdpSession.open(created.webSocketDebuggerUrl, 10_000)
    await cdp.send('Page.enable', {}, 8000)
    session = { mode, port, targetId, cdp, child, userDataDir, headless, lastUsedAt: Date.now() }
    return { ok: true, cdp }
  } catch (error) {
    if (child && child.pid) killTree(child.pid)
    return { ok: false, code: 'launch-failed', error: String((error && error.message) || error).slice(0, 200) }
  }
}

/** 等一次页面加载（点击/导航后调用；等不到就按超时算） */
async function settle(cdp, timeoutMs = 8000) {
  const loaded = cdp.once('Page.loadEventFired', timeoutMs).catch(() => null)
  await loaded
  await sleep(350)
}

async function readPage(cdp, maxChars) {
  const page = await cdp.evaluate(SNAPSHOT_JS, 15_000)
  if (!page) throw new Error('页面没有返回内容')
  return {
    title: String(page.title || '').slice(0, 120),
    url: String(page.url || ''),
    text: String(page.text || '').slice(0, maxChars),
    items: Array.isArray(page.items) ? page.items : [],
  }
}

function requiresTarget(args = {}) {
  const index = Number(args.index)
  if (!Number.isInteger(index) || index < 0) return { ok: false, code: 'bad-args', error: '要给一个控件编号（先「看看」页面）' }
  return { ok: true, index }
}

/** 打开地址并读回页面 */
export async function openUrl(url, config = {}) {
  // 配额就在这里判。以前 `takeBrowserSlot` 写好了却没人调 —— 面板上
  // 「每小时最多开几次」这个开关改了什么都不会发生，是典型的假开关。
  const slot = takeBrowserSlot(config.browserMaxPerHour)
  if (!slot.ok) {
    const quota = browserQuota(config.browserMaxPerHour)
    return {
      ok: false,
      code: 'quota',
      error: `这一小时已经开了 ${quota.used} 次，到上限（${quota.max}）了；过一会儿再开，或者去设置里调高`,
    }
  }
  const target = checkTargetUrl(url, { allowPrivate: config.browserAllowPrivate === true })
  if (!target.ok) return target
  const ready = await ensureSession(config)
  if (!ready.ok) return ready
  try {
    const loaded = ready.cdp.once('Page.loadEventFired', 15_000).catch(() => null)
    await ready.cdp.send('Page.navigate', { url: target.url }, 12_000)
    await loaded
    await sleep(600)
    const page = await readPage(ready.cdp, 6000)
    return { ok: true, page }
  } catch (error) {
    return { ok: false, code: 'open-failed', error: String((error && error.message) || error).slice(0, 200) }
  }
}

/** 截当前页面为 PNG；返回文件路径 */
export async function screenshot(file, config = {}) {
  const ready = await ensureSession(config)
  if (!ready.ok) return ready
  try {
    await ready.cdp.send('Page.enable', {}, 5000)
    const shot = await ready.cdp.send('Page.captureScreenshot', { format: 'png' }, 15000)
    if (!shot?.data) return { ok: false, error: '浏览器没有返回截图' }
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    return { ok: true, file }
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 200) }
  }
}

/** 把本地文件塞进当前页面的第一个 file input，再读页面 */
export async function uploadFile(file, config = {}) {
  const ready = await ensureSession(config)
  if (!ready.ok) return ready
  try {
    const doc = await ready.cdp.send('DOM.getDocument', { depth: -1 })
    const input = await ready.cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' })
    if (!input || !input.nodeId) return { ok: false, error: '页面里没有上传控件' }
    await ready.cdp.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] })
    await sleep(5000)
    const page = await readPage(ready.cdp, 6000)
    return { ok: true, page }
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 200) }
  }
}

/** 读当前页面（标题 / 地址 / 正文 / 编号控件） */
export async function readCurrent(config = {}) {
  const ready = await ensureSession(config)
  if (!ready.ok) return ready
  try {
    const page = await readPage(ready.cdp, Math.max(500, Number(config.browserMaxChars) || 2000))
    return { ok: true, page }
  } catch (error) {
    return { ok: false, code: 'read-failed', error: String((error && error.message) || error).slice(0, 200) }
  }
}

/** 点第 N 个控件 */
export async function clickIndex(index, config = {}) {
  const target = requiresTarget({ index })
  if (!target.ok) return target
  const ready = await ensureSession(config)
  if (!ready.ok) return ready
  try {
    const clicked = await ready.cdp.evaluate(
      `(() => { const el = document.querySelector('[data-qqfish-idx="${target.index}"]'); if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true })()`,
      8000,
    )
    if (!clicked) return { ok: false, code: 'no-element', error: `页面上没有编号 ${target.index} 的控件（重新「看看」再点）` }
    await settle(ready.cdp, 4000)
    const page = await readPage(ready.cdp, Math.max(500, Number(config.browserMaxChars) || 2000))
    return { ok: true, page }
  } catch (error) {
    return { ok: false, code: 'click-failed', error: String((error && error.message) || error).slice(0, 200) }
  }
}

/** 往第 N 个输入框写字 */
export async function typeInto(index, text, config = {}) {
  const target = requiresTarget({ index })
  if (!target.ok) return target
  const value = String(text || '').slice(0, 2000)
  const ready = await ensureSession(config)
  if (!ready.ok) return ready
  try {
    const focused = await ready.cdp.evaluate(
      `(() => {
        const el = document.querySelector('[data-qqfish-idx="${target.index}"]')
        if (!el) return false
        el.scrollIntoView({ block: 'center' })
        if (typeof el.focus === 'function') el.focus()
        if (el.isContentEditable) {
          const range = document.createRange()
          range.selectNodeContents(el)
          const sel = getSelection()
          sel.removeAllRanges()
          sel.addRange(range)
        } else if (typeof el.select === 'function') {
          try { el.select() } catch {}
        }
        return true
      })()`,
      8000,
    )
    if (!focused) return { ok: false, code: 'no-element', error: `页面上没有编号 ${target.index} 的输入框` }

    // 真实输入：Input.insertText 会走浏览器输入管线，受控组件也能收到 input 事件
    let inserted = false
    try {
      await ready.cdp.send('Input.insertText', { text: value }, 8000)
      inserted = true
    } catch {}

    // 校验并兜底：少数站点会拦合成输入，退回原生 setter
    const state = await ready.cdp
      .evaluate(
        `(() => {
          const el = document.querySelector('[data-qqfish-idx="${target.index}"]')
          if (!el) return null
          return { current: String((el.isContentEditable ? el.textContent : el.value) || ''), editable: !!(el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') }
        })()`,
        6000,
      )
      .catch(() => null)
    const probe = value.slice(0, Math.min(4, value.length))
    if (state && state.editable && (!inserted || !String(state.current).includes(probe))) {
      await ready.cdp.evaluate(
        `(() => {
          const el = document.querySelector('[data-qqfish-idx="${target.index}"]')
          if (!el) return false
          const text = ${JSON.stringify(value)}
          if (el.isContentEditable) el.textContent = text
          else {
            const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text)
          }
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          return true
        })()`,
        8000,
      )
    }
    await sleep(200)
    const page = await readPage(ready.cdp, Math.max(500, Number(config.browserMaxChars) || 2000))
    return { ok: true, page }
  } catch (error) {
    return { ok: false, code: 'type-failed', error: String((error && error.message) || error).slice(0, 200) }
  }
}

/** 滚动：up / down / top / bottom */
export async function scrollPage(direction = 'down', config = {}) {
  const ready = await ensureSession(config)
  if (!ready.ok) return ready
  const how = ['up', 'down', 'top', 'bottom'].includes(direction) ? direction : 'down'
  const expression = {
    up: 'window.scrollBy(0, -Math.round(innerHeight * 0.8))',
    down: 'window.scrollBy(0, Math.round(innerHeight * 0.8))',
    top: 'window.scrollTo(0, 0)',
    bottom: 'window.scrollTo(0, document.body.scrollHeight)',
  }[how]
  try {
    await ready.cdp.evaluate(expression, 5000)
    await sleep(350)
    const page = await readPage(ready.cdp, Math.max(500, Number(config.browserMaxChars) || 2000))
    return { ok: true, page, how }
  } catch (error) {
    return { ok: false, code: 'scroll-failed', error: String((error && error.message) || error).slice(0, 200) }
  }
}

/** 历史：back / forward / reload */
export async function historyAction(action, config = {}) {
  const ready = await ensureSession(config)
  if (!ready.ok) return ready
  try {
    if (action === 'back') await ready.cdp.evaluate('history.back()', 5000)
    else if (action === 'forward') await ready.cdp.evaluate('history.forward()', 5000)
    else await ready.cdp.send('Page.reload', {}, 8000)
    await settle(ready.cdp, 8000)
    const page = await readPage(ready.cdp, Math.max(500, Number(config.browserMaxChars) || 2000))
    return { ok: true, page }
  } catch (error) {
    return { ok: false, code: 'history-failed', error: String((error && error.message) || error).slice(0, 200) }
  }
}

/**
 * 每小时操作次数闸（进程内共享）。
 */
const actionTimes = []
function prune(now = Date.now()) {
  while (actionTimes.length && now - actionTimes[0] > 3_600_000) actionTimes.shift()
}

function takeBrowserSlot(maxPerHour = 60) {
  const max = Math.max(1, Math.min(600, Number(maxPerHour) || 60))
  const now = Date.now()
  prune(now)
  if (actionTimes.length >= max) return { ok: false, max, remaining: 0 }
  actionTimes.push(now)
  return { ok: true, max, remaining: Math.max(0, max - actionTimes.length) }
}

function browserQuota(maxPerHour = 60) {
  const max = Math.max(1, Math.min(600, Number(maxPerHour) || 60))
  prune()
  return { max, used: actionTimes.length, remaining: Math.max(0, max - actionTimes.length) }
}

/** 把页面压成给人看的文字 */
export function formatPage(page, options = {}) {
  if (!page) return ''
  const maxChars = Math.max(200, Number(options.maxChars) || 1800)
  const maxItems = Math.max(0, Math.min(30, Number(options.maxItems) || 12))
  const lines = []
  if (page.title) lines.push(`《${page.title}》`)
  if (page.url) lines.push(page.url)
  if (page.items && page.items.length && maxItems) {
    const controls = page.items.slice(0, maxItems).map((item) => {
      const kind = item.tag === 'a' ? '链接' : item.tag === 'input' || item.tag === 'textarea' ? '输入' : '按钮'
      const label = item.text || item.href || '(无文字)'
      return `${item.i}. [${kind}] ${label}`
    })
    lines.push('控件：')
    lines.push(...controls)
  }
  if (page.text) {
    lines.push('正文：')
    lines.push(page.text.slice(0, maxChars))
  }
  const text = lines.join('\n')
  return text.length > maxChars + 600 ? text.slice(0, maxChars + 600) + '…' : text
}
