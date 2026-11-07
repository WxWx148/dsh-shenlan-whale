/**
 * ability/cdp.mjs — 本机浏览器的 CDP 通道
 * ============================================================================
 * 「网页渲染」和「浏览器操作」共用这一层：
 *   - 找浏览器（Chrome 优先、Edge 兜底、配置可指定）；
 *   - 起一个带调试端口的实例（headless 或 headed），或连到已有实例；
 *   - 极简 CDP 会话（Node 22+ 自带 WebSocket，不引第三方依赖）；
 *   - 收进程树、关标签页、探空闲端口。
 *
 * 注意：桌面版是 Electron，spawn 的 stdio 一律用 'ignore'，不抓管道。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

/** 找一个能开调试端口的浏览器；找不到返回空串 */
export function findBrowser(preferred = '') {
  const explicit = String(preferred || process.env.DSH_RENDER_BROWSER || '').trim()
  if (explicit && existsSync(explicit)) return explicit
  for (const candidate of BROWSER_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return ''
}

/** 拿一个空闲端口（只用于 127.0.0.1 调试端口） */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

/** 轮询 /json/version，等浏览器把调试端口挂起来 */
export async function waitForDevTools(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })
      if (response.ok) {
        const info = await response.json()
        if (info && info.webSocketDebuggerUrl) return info
      }
    } catch {}
    await sleep(200)
  }
  return null
}

/** Windows 上要连子进程一起收掉，否则 headless 会留在后台 */
export function killTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      const child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      child.on('error', () => {})
      return
    }
    process.kill(pid, 'SIGKILL')
  } catch {}
}

/**
 * 起一个浏览器实例。
 * @param {{browserPath:string, userDataDir:string, headless?:boolean, port:number}} options
 * @returns {import('node:child_process').ChildProcess}
 */
export function launchBrowser(options) {
  const headless = options.headless !== false
  const args = [
    headless ? '--headless=new' : '--start-maximized',
    '--disable-gpu',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--metrics-recording-only',
    `--user-data-dir=${options.userDataDir}`,
    `--remote-debugging-port=${options.port}`,
    'about:blank',
  ]
  if (headless) args.splice(2, 0, '--hide-scrollbars')
  return spawn(options.browserPath, args, { stdio: 'ignore', windowsHide: true })
}

/** 新开一个标签页，返回 { id, webSocketDebuggerUrl } */
export async function newTarget(port) {
  const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: 'PUT',
    signal: AbortSignal.timeout(8000),
  }).then((response) => response.json())
  return { id: String(created.id || ''), webSocketDebuggerUrl: String(created.webSocketDebuggerUrl || '') }
}

export async function closeTarget(port, id) {
  if (!id) return
  try {
    await fetch(`http://127.0.0.1:${port}/json/close/${id}`, { signal: AbortSignal.timeout(3000) })
  } catch {}
}

/** 极简 CDP 会话 */
export class CdpSession {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.closed = false
    socket.addEventListener('message', (event) => this.handle(event.data))
    socket.addEventListener('close', () => {
      this.closed = true
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer)
        reject(new Error('CDP 连接已断开'))
      }
      this.pending.clear()
    })
  }

  static async open(wsUrl, timeoutMs = 10_000) {
    const socket = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), timeoutMs)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('CDP 连接失败'))
      })
    })
    return new CdpSession(socket)
  }

  handle(raw) {
    let message
    try {
      message = JSON.parse(String(raw))
    } catch {
      return
    }
    if (message.id && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(message.error.message || 'CDP 返回错误'))
      else entry.resolve(message.result)
      return
    }
    if (message.method) {
      for (const handler of this.listeners.get(message.method) || []) {
        try {
          handler(message.params)
        } catch {}
      }
    }
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set())
    this.listeners.get(method).add(handler)
  }

  off(method, handler) {
    const set = this.listeners.get(method)
    if (set) set.delete(handler)
  }

  send(method, params = {}, timeoutMs = 15_000) {
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} 超时`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  /** 执行一段 JS，返回它的值 */
  async evaluate(expression, timeoutMs = 15_000) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs)
    if (result && result.exceptionDetails) {
      const message = result.exceptionDetails.text || '页面脚本执行失败'
      throw new Error(String(message).slice(0, 160))
    }
    return result && result.result ? result.result.value : undefined
  }

  once(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const handler = (params) => {
        clearTimeout(timer)
        this.off(method, handler)
        resolve(params)
      }
      const timer = setTimeout(() => {
        this.off(method, handler)
        reject(new Error(`等待 ${method} 超时`))
      }, timeoutMs)
      this.on(method, handler)
    })
  }

  close() {
    try {
      this.socket.close()
    } catch {}
  }
}
