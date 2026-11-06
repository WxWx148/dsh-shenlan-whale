/**
 * lib/napcat.mjs — NapCat 登录：怎么启动、现在走到哪一步、失败之后怎么办。
 *
 * 为什么要有这一层：
 *   面板上曾经摆着「登录方式」「票据失效时自动出二维码」两个开关，却没有任何代码去读。
 *   用户改完只看到「已保存」，NapCat 那边仍然按启动脚本里的 `-q` 走 ——
 *   这就是最伤人的那种假开关：看起来能改，改完什么都不会发生。
 *
 * 这一层把「登录」变成一条可核对的状态机，而不是一个进程黑盒：
 *   1. 启动：按配置决定带不带 `-q`、带不带密码环境变量；密码只进环境，不进命令行。
 *   2. 观察：优先问 NapCat WebUI 的 `CheckLoginStatus`（阶段、错误原文都拿得到）；
 *      WebUI 不可用时退回「二维码文件 + 通道状态」，绝不假装知道。
 *   3. 处理：票据失败时按 `autoQr` 决定自动出码还是等用户点；重试/刷新走 WebUI，
 *      不必每次杀掉 QQ 再重启。
 *
 * 三条纪律：
 *   · 密码、令牌不写日志、不进快照、不进命令行；
 *   · 任何一步失败都返回人话原因，不抛到宿主；
 *   · 不认识的阶段就说「不知道」，不猜成「在线」。
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { connect as netConnect } from 'node:net'
import { promisify } from 'node:util'
import path from 'node:path'

const execFileAsync = promisify(execFile)

/** 登录方式：与 panel.mjs 的枚举保持一致 */
const LOGIN_MODES = Object.freeze(['ticket', 'password', 'qr'])
export const MODE_LABELS = Object.freeze({ ticket: '票据', password: '密码', qr: '扫码' })
/** 二维码图片由宿主路由转发，前端只认这个地址 */
const QR_ROUTE = '/api/shenlan/napcat/qr'
const DEFAULT_NAPCAT_ROOT = path.join(homedir(), '.dsh', 'qq-fish', 'napcat')
/** 一张二维码 3 分钟后基本就废了；超过这个时间只提示「过期」，不替用户判定失败 */
const QR_FRESH_MS = 180_000
const QR_USABLE_MS = 300_000
const WEBUI_CREDENTIAL_TTL = 45 * 60_000
const START_COOLDOWN_MS = 20_000
/** 两次端口探活之间至少隔这么久：面板每 4 秒轮询一次，不必每次都去连一下 */
const PROBE_GAP_MS = 5000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const text = (value) => String(value === null || value === undefined ? '' : value)
const digits = (value) => text(value).replace(/\D/g, '')

/**
 * ws://127.0.0.1:3001 → { host, port, secure }
 * 认不出来就返回 null —— 「地址写错了」和「服务端没开」是两回事，不能混成一句。
 */
export function endpointOf(wsUrl) {
  const raw = text(wsUrl).trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    const secure = url.protocol === 'wss:' || url.protocol === 'https:'
    const port = Number(url.port) || (secure ? 443 : 80)
    const host = url.hostname || '127.0.0.1'
    if (!port) return null
    return { host, port, secure }
  } catch {
    return null
  }
}

/**
 * 端口探活。
 *
 * 「通道连不上」有四种完全不同的原因，面板以前全给同一句话（去查地址和令牌），
 * 于是最省事的那种（NapCat 根本没开 WebSocket 服务端）反而最难想到。
 * 连一下就知道分岔在哪：
 *   ECONNREFUSED → 那个端口上没有程序（服务端没开 / 端口不对 / 换了账号配置没跟过来）
 *   连上了       → 服务端在，收发不了就是握手（令牌）或协议的事
 */
export async function probeTcp(endpoint, options = {}) {
  if (!endpoint) return { ok: false, error: '没有可探测的地址', code: 'NO_TARGET' }
  const timeoutMs = Math.max(200, Number(options.timeoutMs) || 1200)
  const connectImpl = typeof options.connect === 'function' ? options.connect : netConnect
  return new Promise((resolve) => {
    let settled = false
    let socket = null
    let timer = null
    const done = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try { socket?.destroy() } catch {}
      resolve(value)
    }
    timer = setTimeout(() => done({ ok: false, error: '探测超时', code: 'ETIMEDOUT' }), timeoutMs)
    timer.unref?.()
    try {
      socket = connectImpl({ host: endpoint.host, port: endpoint.port })
    } catch (error) {
      done({ ok: false, error: String(error?.message || error), code: text(error?.code) })
      return
    }
    socket.once('connect', () => done({ ok: true }))
    socket.once('error', (error) => done({ ok: false, error: String(error?.message || error), code: text(error?.code) }))
  })
}


/** NapCat WebUI 的登录哈希：sha256(token + '.napcat') */
export function napcatHash(token) {
  return createHash('sha256').update(text(token) + '.napcat').digest('hex')
}

/** QQ 密码在 NapCat 侧是 MD5；32 位十六进制原样使用，其余现算 */
export function passwordDigest(value) {
  const raw = text(value).trim()
  if (!raw) return ''
  if (/^[a-fA-F0-9]{32}$/.test(raw)) return raw.toLowerCase()
  return createHash('md5').update(raw, 'utf8').digest('hex')
}

/** 从启动脚本里认 QQ 号：`-q 123` / `--qq 123` 两种写法 */
export function uinFromLauncher(script) {
  const match = /(?:^|\s)(?:-q|--qq)\s+["']?(\d{5,12})["']?/i.exec(text(script))
  return match ? match[1] : ''
}

/**
 * 从启动脚本里认 NapCat 安装目录。
 * 只看两处：`cd /d "..."` 和脚本里出现的 `...\napcat\<版本>` 路径。
 * 认不出来就返回空串，交给 resolveInstall 去扫默认目录。
 */
export function installFromLauncher(script) {
  const source = text(script)
  const cd = /cd\s+\/d\s+["']([^"']+)["']/i.exec(source)
  if (cd && /napcat/i.test(cd[1])) return cd[1].replace(/[\\/]+$/, '')
  const inline = /([A-Za-z]:\\[^"'\r\n]*?\\napcat\\\d+(?:\.\d+){1,3})/i.exec(source)
  return inline ? inline[1] : ''
}

/**
 * 找 NapCat 装在哪。
 * 顺序：启动脚本里写明的 → 启动脚本自己所在目录 → `~/.dsh/qq-fish/napcat/<版本>` 里最新的一个。
 * 不联网、不猜版本号；找不到就说找不到。
 */
export function resolveInstall(input = {}) {
  const home = input.home || homedir()
  const launcherPath = text(input.launcherPath)
  let launcherText = text(input.launcherText)
  if (!launcherText && launcherPath) {
    try {
      if (existsSync(launcherPath)) launcherText = readFileSync(launcherPath, 'utf8')
    } catch {}
  }

  const fromScript = installFromLauncher(launcherText)
  if (fromScript && existsSync(path.join(fromScript, 'napcat.bat'))) {
    return { ok: true, dir: fromScript, launcherPath, launcherText, source: 'launcher' }
  }

  if (launcherPath && existsSync(path.join(path.dirname(launcherPath), 'napcat.bat'))) {
    return { ok: true, dir: path.dirname(launcherPath), launcherPath, launcherText, source: 'launcher-dir' }
  }

  const root = path.join(home, '.dsh', 'qq-fish', 'napcat')
  try {
    const versions = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
    for (const version of versions) {
      const dir = path.join(root, version)
      if (existsSync(path.join(dir, 'napcat.bat'))) {
        return { ok: true, dir, launcherPath, launcherText, source: 'scan' }
      }
    }
  } catch {}

  return {
    ok: false,
    dir: '',
    launcherPath,
    launcherText,
    error: '找不到 NapCat：启动脚本路径和 ' + root + ' 下都没有 napcat.bat',
  }
}

export function qrPathOf(installDir) {
  if (!installDir) return ''
  return path.join(installDir, 'napcat', 'cache', 'qrcode.png')
}

/**
 * 纯函数：把配置翻译成「这次该怎么启动」。
 * 不碰磁盘、不启动进程 —— 测试可以直接断言参数与环境变量。
 */
export function planLogin(input = {}) {
  const mode = LOGIN_MODES.includes(input.mode) ? input.mode : 'ticket'
  const autoQr = input.autoQr !== false
  const uin = digits(input.selfId) || uinFromLauncher(input.launcherText)
  const password = text(input.password).trim()
  const passwordMd5 = passwordDigest(password)
  const warnings = []
  const env = {}

  if (mode !== 'qr' && !uin) {
    warnings.push('没填机器人 QQ 号，票据和密码都用不了')
  }
  if (mode === 'password' && !password) {
    warnings.push('密码方式没填密码：会先试票据，票据失效后只能扫码')
  }
  if (password) {
    // 密码只进环境变量，不进命令行：进程列表里看不到，日志也不打。
    // 只有密码方式才需要；扫码方式即使配置里留着旧密码，也不该顺手做快速登录。
    if (mode === 'password') {
      env.NAPCAT_QUICK_ACCOUNT = uin
      if (/^[a-fA-F0-9]{32}$/.test(password)) env.NAPCAT_QUICK_PASSWORD_MD5 = password.toLowerCase()
      else env.NAPCAT_QUICK_PASSWORD = password
    }
  }

  const args = mode === 'qr' ? [] : uin ? ['-q', uin] : []
  return {
    ok: mode === 'qr' || !!uin,
    mode,
    modeLabel: MODE_LABELS[mode],
    autoQr,
    uin,
    passwordSet: !!password,
    passwordMd5,
    args,
    env,
    warnings,
    error: mode !== 'qr' && !uin ? '没填机器人 QQ 号，无法用票据或密码登录' : '',
  }
}

/** 「多久以前」的人话；登录页只需要三档 */
export function ageText(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return '刚刚'
  if (n < 60_000) return '刚刚'
  if (n < 3_600_000) return `${Math.floor(n / 60_000)} 分钟前`
  return `${Math.floor(n / 3_600_000)} 小时前`
}

/**
 * 纯函数：把 NapCat 的阶段、通道状态、二维码文件合成一句能看懂的话。
 *
 * 关键判断只有一条：**票据/密码方式下出现二维码，本身就是「前一种方式没成」**。
 * 这时 `autoQr` 才真正有意义 ——
 *   开：把码摆出来，告诉用户扫；
 *   关：不替用户出码，明说「点扫码登录才出码」。
 */
export function describeLogin(input = {}) {
  const mode = LOGIN_MODES.includes(input.mode) ? input.mode : 'ticket'
  const autoQr = input.autoQr !== false
  const channelState = text(input.channelState) || 'unknown'
  const raw = input.raw && typeof input.raw === 'object' ? input.raw : null
  const reachable = input.reachable === true
  const plan = input.plan || {}
  const now = Number(input.now) || Date.now()
  const startedAt = Number(input.startedAt) || 0
  const lastAttempt = input.lastAttempt || null
  const qr = input.qr && typeof input.qr === 'object' ? input.qr : null
  const socket = input.socket && typeof input.socket === 'object' ? input.socket : null
  const loginError = text(raw?.loginError) || text(input.error)
  const online = channelState === 'online'

  let phase = 'unknown'
  if (channelState === 'off') phase = 'off'
  else if (online) phase = 'online'
  else if (!plan.ok) phase = 'not_ready'
  else if (raw?.isLogin === true && raw?.coreReady !== true) phase = 'initializing'
  else if (text(raw?.loginPhase) === 'qrcode_scanned') phase = 'scanned'
  else if (text(raw?.loginPhase) === 'waiting_qrcode') phase = 'waiting_qr'
  else if (text(raw?.loginPhase) === 'generating_qrcode') phase = 'generating_qr'
  else if (text(raw?.loginPhase) === 'reconnecting') phase = 'reconnecting'
  else if (text(raw?.loginPhase) === 'ready') phase = 'connecting'
  else if (text(raw?.loginPhase) === 'offline') phase = 'offline'
  else if (!reachable && startedAt && now - startedAt < 30_000) phase = 'starting'
  else if (!reachable && qr?.exists && Number(qr.ageMs) < QR_USABLE_MS) phase = 'waiting_qr'
  else if (!reachable) phase = 'unknown'

  // 票据/密码方式下出现二维码 = 前一种方式没成
  const fallback = ['waiting_qr', 'generating_qr'].includes(phase) && mode !== 'qr'
  const qrSuppressed = fallback && !autoQr
  if (qrSuppressed) phase = 'qr_blocked'
  const qrAllowed = !qrSuppressed

  const labels = {
    online: ['在线', 'ok', '已登录，通道也连着'],
    off: ['通道已关闭', 'idle', '去设置里打开「启用 QQ 通道」'],
    not_ready: ['还差一项配置', 'bad', plan.error || '登录方式缺少必要配置'],
    initializing: ['登录成功，正在初始化', 'ok', 'QQ 正在拉起，稍等几秒'],
    connecting: ['登录成功，等通道连上', 'warn', '检查 OneBot 地址和令牌；连上就能收发'],
    scanned: ['已扫码，等手机确认', 'warn', '在手机 QQ 上点「允许登录」'],
    waiting_qr: [
      '等扫码',
      'warn',
      mode === 'qr'
        ? '用手机 QQ 扫一下；码会过期，过期点刷新'
        : mode === 'password'
          ? '票据和密码都没成功，已自动出二维码；用手机 QQ 扫一下'
          : '票据没成功，已自动出二维码；用手机 QQ 扫一下',
    ],
    generating_qr: ['正在生成二维码', 'warn', '向 QQ 要一张新码，通常几秒'],
    reconnecting: ['登录服务在重连', 'warn', 'NapCat 正在重启登录服务，稍等'],
    offline: ['还没登录', 'bad', loginError || '协议端在跑，但没有登录'],
    starting: ['正在启动协议端', 'warn', '正在拉起 NapCat，通常 10–20 秒'],
    unknown: ['不知道登录到哪一步', 'warn', '点「再试一次」查一下，或者直接扫码'],
    qr_blocked: [
      '需要扫码（自动出码已关）',
      'warn',
      '票据/密码没成功。自动二维码关着，点「改用扫码」才会出码',
    ],
  }
  const [phaseLabel, tone, baseHint] = labels[phase] || labels.unknown

  let hint = baseHint
  if (hint.length > 180) hint = hint.slice(0, 180) + '…'
  // 「登录成了、通道没连上」是四个原因共用的一个表情：没开服务端、端口写错、令牌不对、协议端崩了。
  // 探过端口就能把它们分开 —— 这句话比「去检查 OneBot 地址和令牌」值钱得多，
  // 因为最常见的那种（换了 QQ 号，OneBot 网络配置是按号存的，新号那份是空的）根本不在地址和令牌上。
  if (phase === 'connecting' && socket) {
    const where = text(socket.host || '127.0.0.1') + ':' + text(socket.port || '')
    if (socket.ok === true) {
      hint = '端口在听，但握手没通过：多半两边令牌不一致（config.json 的 channel.token 与 NapCat 服务端里的 token 要一字不差）。改完保存立即生效。'
    } else if (text(socket.code) === 'ECONNREFUSED' || /refused|拒绝/i.test(text(socket.error))) {
      hint = '登录成了，但 ' + where + ' 上没有程序在听 —— NapCat 没开 WebSocket 服务端。OneBot 网络配置是按 QQ 号分开存的，换过账号就要在新账号里加一个服务端（端口 ' + text(socket.port || '') + '，令牌与这里一致），保存后立刻能连。'
    } else {
      hint = '登录成了，但 ' + where + ' 连不上（' + (text(socket.code) || text(socket.error) || '原因不明') + '）。先确认地址与端口，以及协议端确实监听在本机。'
    }
  }
  if (phase === 'waiting_qr' && mode === 'password' && !plan.passwordSet) {
    hint = '密码方式没填密码，已经退回扫码；用手机 QQ 扫一下'
  }
  if (lastAttempt?.message && ['offline', 'unknown', 'qr_blocked', 'waiting_qr'].includes(phase)) {
    hint = lastAttempt.message + '。' + hint
  }
  if (loginError && phase !== 'online' && phase !== 'off' && phase !== 'offline') {
    // 错误原文照说；截断只防一条超长堆栈把面板撑破
    hint = hint + '｜' + loginError.slice(0, 120)
  }

  return {
    phase,
    phaseLabel,
    tone,
    hint,
    online,
    reachable,
    socket,
    mode,
    modeLabel: MODE_LABELS[mode],
    autoQr,
    qrAllowed,
    qrSuppressed,
    qr,
    error: loginError,
    warnings: Array.isArray(plan.warnings) ? plan.warnings : [],
    lastAttempt,
    canStart: !online && channelState !== 'off',
    canRetry: !online && phase !== 'off' && plan.ok !== false,
    canRefreshQr: !online && phase !== 'off',
    canShowQr: phase !== 'off',
    at: now,
  }
}

/**
 * 登录管理器。
 *
 * 依赖全部可注入：测试不碰真的 NapCat、真的 QQ、真的网络。
 * 生产环境只依赖三样：`fetch`（问 WebUI）、`spawn`（拉进程）、`stat`（看二维码文件）。
 */
export class NapCatLogin {
  constructor(input = {}) {
    this.config = input.config || {}
    this.channel = input.channel || null
    this.log = typeof input.log === 'function' ? input.log : () => {}
    this.now = typeof input.now === 'function' ? input.now : () => Date.now()
    this.fetchImpl = typeof input.fetch === 'function' ? input.fetch : (...args) => fetch(...args)
    this.spawnImpl = typeof input.spawn === 'function' ? input.spawn : spawn
    this.execImpl = typeof input.exec === 'function' ? input.exec : execFileAsync
    this.platform = input.platform || process.platform
    // 端口探活也做成可注入：测试不该真的去连 127.0.0.1:3001
    this.probeImpl = typeof input.probe === 'function' ? input.probe : probeTcp
    this.socket = null
    this.socketAt = 0
    this.socketKey = ''

    this.timer = null
    this.polling = false
    this.last = null
    this.lastAttempt = null
    this.startedAt = 0
    this.lastStartAt = 0
    this.starting = false
    this.credential = ''
    this.credentialAt = 0
    this.lastQrRefreshAt = 0
    this.cachedWebui = null
    this.cachedWebuiAt = 0
    this.cachedInstall = null
    this.cachedInstallKey = ''
  }

  /** 配置对象换了（面板改完配置）之后重新读，不重启管理器 */
  relink(config) {
    this.config = config || this.config
    this.cachedInstall = null
    this.cachedInstallKey = ''
    this.cachedWebui = null
    this.cachedWebuiAt = 0
    this.credential = ''
    this.credentialAt = 0
  }

  get channelConfig() {
    return this.config.channel || {}
  }

  install() {
    const launcherPath = text(this.channelConfig.napcatBat)
    const key = launcherPath
    if (this.cachedInstall && this.cachedInstallKey === key) return this.cachedInstall
    const found = resolveInstall({ launcherPath })
    this.cachedInstall = found
    this.cachedInstallKey = key
    return found
  }

  plan(overrides = {}) {
    const login = this.channelConfig.login || {}
    const install = this.install()
    const launcherPath = text(this.channelConfig.napcatBat)
    const plan = planLogin({
      mode: overrides.mode || login.mode,
      autoQr: overrides.autoQr === undefined ? login.autoQr : overrides.autoQr,
      selfId: this.channelConfig.selfId,
      password: login.password,
      launcherText: install.launcherText,
    })
    // 安装目录认不出来、启动脚本也不在，就别装成「能启动」——
    // 否则用户点「启动协议端」只会得到一句「协议端还没准备好」。
    const direct = install.ok ? path.join(install.dir, 'napcat.bat') : ''
    const directUsable = !!direct && existsSync(direct)
    const launcherUsable = !!launcherPath && existsSync(launcherPath)
    // 优先直接调 NapCat 自己的 napcat.bat：用户的启动脚本里常常写死了 `-q`，
    // 绕不过去的话「扫码方式」会被它偷偷改成快速登录，开关就白改了。
    const launchTarget = directUsable ? direct : launcherUsable ? launcherPath : ''
    return {
      ...plan,
      ok: plan.ok,
      startable: !!launchTarget,
      error: plan.ok ? plan.error : plan.error || install.error || '找不到 NapCat 安装目录或启动脚本',
      install: install.dir,
      launcherPath,
      launchTarget,
      qrPath: qrPathOf(install.dir) || qrPathOf(path.dirname(launcherPath)),
      installError: install.ok ? '' : install.error,
    }
  }

  qrInfo(plan = this.plan()) {
    const file = plan.qrPath || qrPathOf(this.install().dir)
    let exists = false
    let at = 0
    try {
      const stat = statSync(file)
      if (stat.isFile()) {
        exists = true
        at = stat.mtimeMs
      }
    } catch {}
    const ageMs = exists ? Math.max(0, this.now() - at) : null
    return {
      path: file,
      exists,
      at,
      ageMs,
      ageText: exists ? ageText(ageMs) : '',
      fresh: exists && ageMs !== null ? ageMs < QR_FRESH_MS : false,
      usable: exists && ageMs !== null ? ageMs < QR_USABLE_MS : false,
      src: QR_ROUTE,
    }
  }

  webui() {
    const install = this.install()
    if (!install.ok) return { ok: false, error: install.error }
    const file = path.join(install.dir, 'napcat', 'config', 'webui.json')
    let mtime = 0
    try {
      mtime = statSync(file).mtimeMs
    } catch {
      return { ok: false, error: 'NapCat 没有 webui.json，问不到登录阶段（只能用二维码文件判断）' }
    }
    if (this.cachedWebui && this.cachedWebuiAt === mtime) return this.cachedWebui
    let data = {}
    try {
      data = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return { ok: false, error: 'webui.json 读不动，问不到登录阶段' }
    }
    if (data.disableWebUI === true) return { ok: false, error: 'NapCat WebUI 被关掉了，问不到登录阶段' }
    const token = text(data.token)
    if (!token) return { ok: false, error: 'NapCat WebUI 没设令牌，问不到登录阶段' }
    const port = Number(data.port) || 6099
    // 注意字段名别写成 webui.token：扫描器会把它误认成插件自己的配置项
    this.cachedWebui = { ok: true, port, secret: token, origin: 'http://127.0.0.1:' + port }
    this.cachedWebuiAt = mtime
    return this.cachedWebui
  }

  async credentialFor(webui, force = false) {
    if (!force && this.credential && this.now() - this.credentialAt < WEBUI_CREDENTIAL_TTL) return this.credential
    const response = await this.fetchImpl(webui.origin + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash: napcatHash(webui.secret) }),
      signal: AbortSignal.timeout(8000),
    })
    const payload = await response.json().catch(() => null)
    const credential = text(payload?.data?.Credential || payload?.Credential)
    if (!credential) throw new Error(text(payload?.message) || 'NapCat WebUI 登录失败')
    this.credential = credential
    this.credentialAt = this.now()
    return credential
  }

  /** 调一个 NapCat WebUI 的 QQLogin 接口。永远返回 {ok,data|error}，不抛。 */
  async call(action, body = {}, options = {}) {
    const webui = this.webui()
    if (!webui.ok) return { ok: false, error: webui.error, unreachable: true }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const credential = await this.credentialFor(webui, attempt > 0)
        const response = await this.fetchImpl(webui.origin + '/api/QQLogin/' + action, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + credential },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeout || 12_000),
        })
        const payload = await response.json().catch(() => null)
        if (!payload) return { ok: false, error: 'WebUI 回了一个读不懂的包' }
        if (Number(payload.code) !== 0) {
          const message = text(payload.message) || 'WebUI 返回失败'
          if (/unauth|authorization/i.test(message) && attempt === 0) {
            this.credential = ''
            continue
          }
          return { ok: false, error: message, unreachable: false }
        }
        return { ok: true, data: payload.data }
      } catch (error) {
        return {
          ok: false,
          error: String(error?.message || error),
          unreachable: true,
        }
      }
    }
    return { ok: false, error: 'WebUI 鉴权失败' }
  }

  channelState() {
    try {
      return text(this.channel?.state?.() || 'unknown')
    } catch {
      return 'unknown'
    }
  }

  /**
   * 探一下 OneBot 那个端口到底有没有人在听。
   *
   * 只在「已经登录、通道还没连上」时探：这时候用户最需要一句话告诉他该动哪儿。
   * 结果按地址缓存 5 秒 —— 面板 4 秒轮询一次，没必要每次都建一次连接。
   */
  async probeChannel(force = false) {
    const endpoint = endpointOf(this.channelConfig.wsUrl)
    if (!endpoint) {
      this.socket = { ok: false, error: '地址不是合法的 ws:// 地址', code: 'NO_TARGET', host: '', port: 0, at: this.now() }
      return this.socket
    }
    const key = endpoint.host + ':' + endpoint.port
    const fresh = this.socketKey === key && this.now() - this.socketAt < PROBE_GAP_MS
    if (!force && fresh) return this.socket
    const result = await this.probeImpl(endpoint, { timeoutMs: 1200 })
    this.socketKey = key
    this.socketAt = this.now()
    this.socket = { ...result, host: endpoint.host, port: endpoint.port, at: this.socketAt }
    return this.socket
  }

  /**
   * 协议端在不在跑。
   *
   * 以前只看 QQ.exe：NapCat 自己是一个 node 进程，QQ 在无头模式下也不一定叫 QQ.exe，
   * 于是「明明在跑」被判成「没跑」，看门狗隔一阵就再拉一份 —— 两三个 NapCat 抢同一个端口，
   * 谁都没法正常提供服务。除了 QQ.exe，再看 WebUI 端口有没有人在听。
   */
  async agentRunning() {
    if (await this.qqRunning()) return true
    const webui = this.webui()
    if (!webui.ok) return false
    const probe = await this.probeImpl({ host: '127.0.0.1', port: webui.port }, { timeoutMs: 800 })
    return probe.ok === true
  }

  /** 查一次，更新 last。并发调用合并成一次。 */
  async poll() {
    if (this.polling) return this.snapshot()
    this.polling = true
    try {
      if (this.channelConfig.enabled === false) {
        // 通道关着就不去敲 NapCat 的门：没意义，也会让日志看起来像在反复登录。
        const plan = this.plan()
        this.last = {
          ...describeLogin({
            mode: plan.mode,
            autoQr: plan.autoQr,
            channelState: 'off',
            plan,
            qr: this.qrInfo(plan),
            startedAt: this.startedAt,
            now: this.now(),
            lastAttempt: this.lastAttempt,
          }),
          startedAt: this.startedAt,
          reachable: false,
          at: this.now(),
        }
        return this.last
      }
      const plan = this.plan()
      const qr = this.qrInfo(plan)
      let raw = null
      let reachable = false
      let error = ''
      if (plan.ok) {
        const result = await this.call('CheckLoginStatus')
        if (result.ok && result.data) {
          raw = result.data
          reachable = true
        } else {
          error = result.error
        }
      } else {
        error = plan.error || plan.installError
      }
      const state = this.channelState()
      // 登录成了、通道没连上：这时候探一下端口，把「服务端没开」和「令牌不对」分开。
      // 其它阶段不探 —— 还没登录时端口本来就不该通，探了只会给出误导。
      if (state !== 'online' && state !== 'off' && String(raw?.loginPhase || '') === 'ready') {
        await this.probeChannel().catch(() => null)
      } else if (state === 'online') {
        this.socket = null
        this.socketKey = ''
      }
      const described = describeLogin({
        mode: plan.mode,
        autoQr: plan.autoQr,
        channelState: state,
        raw,
        reachable,
        socket: this.socket,
        plan,
        qr,
        error,
        startedAt: this.startedAt,
        now: this.now(),
        lastAttempt: this.lastAttempt,
      })
      this.last = {
        ...described,
        startedAt: this.startedAt,
        reachable,
        at: this.now(),
      }
      return this.last
    } finally {
      this.polling = false
    }
  }

  /** 同步快照：面板每次渲染都要读，绝不能在这里发网络请求 */
  snapshot() {
    if (this.last) return { ...this.last, at: this.now() }
    const plan = this.plan()
    return {
      ...describeLogin({
        mode: plan.mode,
        autoQr: plan.autoQr,
        channelState: this.channelState(),
        socket: this.socket,
        plan,
        qr: this.qrInfo(plan),
        startedAt: this.startedAt,
        now: this.now(),
        lastAttempt: this.lastAttempt,
      }),
      startedAt: this.startedAt,
      reachable: false,
    }
  }

  startPolling(intervalMs = 4000) {
    if (this.timer) return
    const tick = async () => {
      try {
        const snapshot = await this.poll()
        // 二维码大约两分钟就废了。自动出码开着时，四分钟还没人扫就换一张；
        // 不替用户反复刷新（那会把刚要扫的码作废），只按 4 分钟节流。
        const waiting = snapshot.phase === 'waiting_qr' || snapshot.phase === 'generating_qr'
        const age = Number(snapshot.qr?.ageMs)
        if (waiting && snapshot.autoQr && Number.isFinite(age) && age > 240_000 && this.now() - this.lastQrRefreshAt > 240_000) {
          this.lastQrRefreshAt = this.now()
          await this.call('RefreshQRcode', {})
          await this.poll()
        }
      } catch (error) {
        this.log('[napcat] 查询登录状态失败：' + String(error?.message || error))
      }
    }
    this.timer = setInterval(tick, intervalMs)
    this.timer.unref?.()
    tick()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async qqRunning() {
    if (this.platform !== 'win32') return false
    try {
      const { stdout } = await this.execImpl('tasklist.exe', ['/FI', 'IMAGENAME eq QQ.exe', '/NH'], {
        timeout: 5000,
        windowsHide: true,
      })
      return /QQ\.exe/i.test(text(stdout))
    } catch {
      return false
    }
  }

  /**
   * 用 VBS 的 window style 0 真正隐藏控制台。
   * 参数从计划里来，密码只走环境变量；VBS 与命令行里都不会出现密码。
   */
  start(options = {}) {
    if (this.platform !== 'win32') return { ok: false, error: 'NapCat 启动只支持 Windows' }
    if (this.starting) return { ok: false, error: '正在启动，别连点' }
    const plan = this.plan(options.mode ? { mode: options.mode } : {})
    if (!plan.ok) return { ok: false, error: plan.error || plan.installError || '登录方式还不完整' }
    if (!plan.install && !plan.launcherPath) {
      return { ok: false, error: plan.installError || '找不到 NapCat 安装目录' }
    }
    const now = this.now()
    if (!options.force && now - this.lastStartAt < START_COOLDOWN_MS) {
      return { ok: false, error: '刚启动过，先等它自己起来' }
    }

    const launcher = plan.launchTarget || plan.launcherPath || path.join(plan.install, 'napcat.bat')
    if (!launcher) {
      return { ok: false, error: plan.installError || '找不到 NapCat 安装目录' }
    }
    if (!existsSync(launcher)) {
      return { ok: false, error: '启动脚本不存在：' + launcher }
    }

    const command = [
      'conhost.exe',
      '--headless',
      'cmd.exe',
      '/d',
      '/s',
      '/c',
      'call',
      quoteCmd(launcher),
      ...plan.args.map(quoteCmd),
    ].join(' ')
    const vbs = path.join(tmpdir(), 'whale-napcat-' + process.pid + '-' + Math.random().toString(36).slice(2, 8) + '.vbs')
    const script = 'Set sh=CreateObject("WScript.Shell")\r\nsh.Run "' + command.replace(/"/g, '""') + '", 0, False\r\n'
    try {
      writeFileSync(vbs, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(script, 'utf16le')]))
      const child = this.spawnImpl('wscript.exe', [vbs], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ...plan.env },
      })
      child.unref?.()
      this.starting = true
      this.startedAt = now
      this.lastStartAt = now
      // 启动动作本身很快；给 15 秒的“正在启动”窗口，之后还没消息就按未知处理
      setTimeout(() => {
        this.starting = false
      }, 15_000).unref?.()
      this.log('[napcat] 已启动｜方式 ' + plan.modeLabel + (plan.uin ? '｜QQ ' + plan.uin : ''))
      return { ok: true, mode: plan.mode, uin: plan.uin, launcher, args: plan.args }
    } catch (error) {
      this.starting = false
      return { ok: false, error: '启动 NapCat 失败：' + String(error?.message || error) }
    }
  }

  /**
   * 保证协议端在跑。
   * 只负责「把进程拉起来」，不负责登录 —— 登录失败重试是 retry 的事。
   * 已经在等扫码/等确认时绝不重启：那会把用户正要扫的码作废。
   */
  async ensure(options = {}) {
    const cfg = this.channelConfig
    if (cfg.enabled === false) return { ok: false, skipped: 'channel-disabled' }
    if (options.reason === 'boot' && cfg.autoStartNapcat !== true) {
      return { ok: false, skipped: 'autostart-off', message: '开机自启关着；需要时点「启动协议端」' }
    }
    await this.poll()
    const snapshot = this.snapshot()
    if (snapshot.online) return { ok: true, online: true, snapshot }
    if (snapshot.reachable) return { ok: true, running: true, snapshot }
    if (this.now() - this.lastStartAt < START_COOLDOWN_MS) {
      return { ok: true, skipped: 'recent', snapshot }
    }
    if (await this.agentRunning()) {
      return { ok: true, running: true, message: '协议端在跑，但 WebUI 问不到阶段；可以用「刷新二维码」或重启协议端', snapshot }
    }
    const started = this.start()
    return {
      ...started,
      message: started.ok ? '已启动 NapCat，正在等它起来' : started.error,
      snapshot: this.snapshot(),
    }
  }

  /** 关掉 NapCat/QQ，给「重启换一张码」用；只有真的重启才走这里 */
  /**
   * 重启协议端。
   *
   * force=true 时不再拿「通道在线」拦人：通道在线只证明 WebSocket 还在，
   * 不证明 QQ 内核活着。实测过 `result: 1006514 网络连接异常` 的状态 ——
   * 消息收不到、发不出，但通道照样 online、心跳照样跳，
   * 面板点「重启协议端」却回一句「QQ 已在线，不需要重启」，等于把唯一的自救路堵死。
   * 用户明确点了按钮，就该真重启；自动流程仍然走默认的这道闸。
   */
  async restart(options = {}) {
    const force = options.force === true
    if (!force && this.channelState() === 'online') return { ok: true, online: true, message: 'QQ 已在线，不需要重启' }
    const killed = await this.kill()
    if (!killed.ok) return killed
    await sleep(900)
    const started = this.start({ force: true })
    if (!started.ok) return started
    for (let i = 0; i < 20; i += 1) {
      await sleep(1000)
      await this.poll()
      if (this.snapshot().reachable) break
    }
    await this.poll()
    return {
      ok: true,
      message: '已重启协议端，正在等登录',
      login: this.snapshot(),
    }
  }

  async kill() {
    if (this.platform !== 'win32') return { ok: false, error: '只支持 Windows' }
    const script = [
      // 只认协议端自己的入口（...\napcat\napcat.mjs）。
      // 早先这里写的是 -match 'napcat'，任何命令行里带这三个字母的 node 进程都会被误杀 ——
      // 包括名字叫 napcat-probe.test.mjs 的用例，它把自己杀掉了。
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'napcat[\\\\/]napcat\\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      'Get-Process QQ -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue',
    ].join('; ')
    try {
      await this.execImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: 20_000,
        windowsHide: true,
      })
    } catch {
      // 杀不干净也继续判断：下面用 QQ.exe 是否还在来给结论
    }
    await sleep(1200)
    if (await this.qqRunning()) {
      return { ok: false, error: 'QQ 没关掉，可能开了多个客户端或权限不够；先手动退出 QQ 再试' }
    }
    return { ok: true }
  }

  /**
   * 按当前（或指定）方式再登录一次。
   * 优先走 WebUI 的快捷/密码/刷新接口，不重启协议端 —— 已登录的会话不会被顺手踢掉。
   */
  async retry(options = {}) {
    const mode = LOGIN_MODES.includes(options.mode) ? options.mode : this.plan().mode
    const plan = this.plan({ mode })
    if (this.channelState() === 'off') return { ok: false, error: 'QQ 通道关着，先在设置里打开', login: this.snapshot() }
    if (this.channelState() === 'online') return { ok: true, online: true, message: 'QQ 已在线，不用再登录', login: this.snapshot() }
    if (!plan.ok) return { ok: false, error: plan.error || plan.installError, login: this.snapshot() }

    const ensured = await this.ensure({ reason: 'manual' })
    if (ensured.started || ensured.skipped === 'recent') {
      for (let i = 0; i < 15; i += 1) {
        await sleep(1000)
        await this.poll()
        if (this.snapshot().reachable) break
      }
    }

    let result
    if (mode === 'ticket') result = await this.retryTicket(plan)
    else if (mode === 'password') result = await this.retryPassword(plan)
    else result = await this.retryQr()

    // 失败且允许自动出码：NapCat 自己也会出，但这里再要一张，避免它停在旧码上。
    // 只在 WebUI 还应答时做；问不到阶段就别顺手重启，那会把用户正在扫的码作废。
    if (!result.ok && plan.autoQr && mode !== 'qr' && this.snapshot().reachable) {
      const refreshed = await this.retryQr()
      if (refreshed.ok) result.message = (result.error || result.message || '登录没成功') + '；已自动出二维码'
    }
    await sleep(800)
    await this.poll()
    // 「接口接受了」不等于「登上了」：最终以登录阶段为准，免得面板写「成功」其实在等扫码。
    const after = this.snapshot()
    const settled = after.online || ['scanned', 'initializing', 'connecting'].includes(after.phase)
    this.lastAttempt = {
      mode,
      at: this.now(),
      ok: result.ok === true && settled,
      message: result.message || result.error || '',
    }
    this.last = { ...after, lastAttempt: this.lastAttempt }
    return { ...result, login: this.last }
  }

  async retryTicket(plan) {
    if (!plan.uin) return { ok: false, error: '没填机器人 QQ 号，票据登录用不了' }
    if (!this.snapshot().reachable) return { ok: false, error: '协议端还没准备好，等它起来再试' }
    const result = await this.call('SetQuickLogin', { uin: plan.uin })
    if (!result.ok) return { ok: false, error: '票据登录没成功：' + result.error }
    return { ok: true, message: '正在用票据登录 ' + plan.uin }
  }

  async retryPassword(plan) {
    if (!plan.passwordSet) return { ok: false, error: '密码方式没填密码；去「设置 → QQ 连接」填，或改用扫码' }
    if (!plan.uin) return { ok: false, error: '没填机器人 QQ 号，密码登录用不了' }
    if (!this.snapshot().reachable) return { ok: false, error: '协议端还没准备好，等它起来再试' }
    const result = await this.call('PasswordLogin', { uin: plan.uin, passwordMd5: plan.passwordMd5 })
    if (!result.ok) return { ok: false, error: '密码登录没成功：' + result.error }
    if (result.data?.needCaptcha) {
      return {
        ok: false,
        error: 'QQ 要验证码，面板里填不了；去 NapCat WebUI 完成，或改用扫码',
      }
    }
    if (result.data?.needNewDevice) {
      return {
        ok: false,
        error: 'QQ 要新设备验证，去 NapCat WebUI 完成，或改用扫码',
      }
    }
    return { ok: true, message: '正在用密码登录 ' + plan.uin }
  }

  async retryQr(options = {}) {
    const force = options.force === true
    if (!force && this.channelState() === 'online') return { ok: true, online: true, message: 'QQ 已在线，不需要二维码' }
    if (!this.snapshot().reachable) {
      // 已经在跑但问不到阶段（WebUI 关了）：只能重启一次，绝不能并行再拉一个 NapCat
      if (await this.agentRunning()) {
        const restarted = await this.restart({ force })
        if (!restarted.ok) return { ok: false, error: restarted.error }
        return { ok: true, message: restarted.message, login: restarted.login }
      }
      const started = this.start({ force: true })
      if (!started.ok) return { ok: false, error: started.error }
      for (let i = 0; i < 15; i += 1) {
        await sleep(1000)
        await this.poll()
        if (this.snapshot().reachable) break
      }
    }
    if (!this.snapshot().reachable) return { ok: false, error: '协议端还没准备好，等它起来再刷新' }
    const result = await this.call('RefreshQRcode', {})
    if (!result.ok) {
      // 刷新接口失败（登录服务没初始化）时，重启是唯一还能出码的路
      const restarted = await this.restart({ force })
      if (!restarted.ok) return { ok: false, error: restarted.error || result.error }
      return { ok: true, message: restarted.message, login: restarted.login }
    }
    if (result.data?.restarting) {
      return { ok: true, message: '登录服务正在重启，几秒后出码' }
    }
    return { ok: true, message: '二维码已刷新' }
  }
}

/** cmd 参数引号：路径里有空格也能跑 */
function quoteCmd(value) {
  return '"' + text(value).replace(/"/g, '""') + '"'
}
