/**
 * 登录层用例。
 *
 * 这一层最怕两件事：
 *   1. 面板上写着「票据/密码/扫码」，实际启动参数还是老样子 —— 假开关；
 *   2. 票据失效后不说清楚，用户盯着一张不知道过没过期的码。
 * 所以这里把「启动计划」和「阶段翻译」拆成纯函数逐条钉住，
 * 再用一个假 WebUI 走一遍完整轮询，确认密码/令牌不会漏进快照。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  MODE_LABELS,
  NapCatLogin,
  ageText,
  describeLogin,
  installFromLauncher,
  napcatHash,
  passwordDigest,
  planLogin,
  qrPathOf,
  resolveInstall,
  uinFromLauncher,
} from '../channel/index.mjs'

let passed = 0
const failed = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed.push({ name, error })
    console.log(`  ✗ ${name}\n    ${error?.message ?? error}`)
  }
}

const LAUNCHER = '@echo off\r\nchcp 65001 >nul\r\ncd /d "%USERPROFILE%\\.dsh\\qq-fish\\napcat\\4.18.41"\r\ncall napcat.bat -q 1000000001\r\nexit /b 0'

/** 假的 WebUI 响应：Node 的 fetch 只用到 json() */
const reply = (body) => ({ json: async () => body })

console.log('\n登录层')

await check('票据方式：带 -q，不碰密码环境变量', () => {
  const plan = planLogin({ mode: 'ticket', selfId: '1000000001', autoQr: true })
  assert.equal(plan.ok, true)
  assert.equal(plan.mode, 'ticket')
  assert.deepEqual(plan.args, ['-q', '1000000001'])
  assert.deepEqual(plan.env, {})
  assert.equal(plan.passwordSet, false)
})

await check('密码方式：密码只进环境变量，不进命令行', () => {
  const plan = planLogin({ mode: 'password', selfId: '1000000001', password: 'pw-secret', autoQr: true })
  assert.deepEqual(plan.args, ['-q', '1000000001'], '命令行里只该有 QQ 号')
  assert.equal(plan.env.NAPCAT_QUICK_PASSWORD, 'pw-secret')
  assert.ok(!JSON.stringify(plan.args).includes('pw-secret'))
  assert.equal(plan.passwordMd5, passwordDigest('pw-secret'))
})

await check('密码也可以直接填 32 位 MD5：不再二次哈希，也不发明文变量', () => {
  const md5 = '0123456789abcdef0123456789abcdef'
  const plan = planLogin({ mode: 'password', selfId: '1', password: md5 })
  assert.equal(plan.env.NAPCAT_QUICK_PASSWORD_MD5, md5)
  assert.equal(plan.env.NAPCAT_QUICK_PASSWORD, undefined)
})

await check('密码方式没填密码：明确降级提示，而不是假装能用', () => {
  const plan = planLogin({ mode: 'password', selfId: '1000000001' })
  assert.equal(plan.ok, true, '票据还能试，所以整体不算失败')
  assert.equal(plan.passwordSet, false)
  assert.match(plan.warnings.join(''), /没填密码/)
})

await check('扫码方式：不带 -q，也不设置快速登录账号', () => {
  const plan = planLogin({ mode: 'qr', selfId: '1000000001', password: 'pw' })
  assert.deepEqual(plan.args, [])
  assert.equal(plan.env.NAPCAT_QUICK_ACCOUNT, undefined)
  assert.equal(plan.modeLabel, MODE_LABELS.qr)
})

await check('没填 QQ 号：票据/密码直接说缺什么；扫码不拦', () => {
  const ticket = planLogin({ mode: 'ticket', selfId: '' })
  assert.equal(ticket.ok, false)
  assert.match(ticket.error, /QQ 号/)
  const qr = planLogin({ mode: 'qr', selfId: '' })
  assert.equal(qr.ok, true)
})

await check('QQ 号能从启动脚本里认出来（老配置只写了 -q）', () => {
  assert.equal(uinFromLauncher(LAUNCHER), '1000000001')
  const plan = planLogin({ mode: 'ticket', selfId: '', launcherText: LAUNCHER })
  assert.equal(plan.uin, '1000000001')
  assert.equal(plan.ok, true)
})

await check('安装目录：从启动脚本的 cd /d 认，认不出就返回空而不是瞎猜', () => {
  assert.equal(installFromLauncher(LAUNCHER), '%USERPROFILE%\\.dsh\\qq-fish\\napcat\\4.18.41')
  assert.equal(installFromLauncher('@echo off\r\ncall somewhere\\napcat.bat'), '')
  const missing = resolveInstall({ launcherPath: path.join(tmpdir(), 'no-such-launcher-' + Date.now() + '.bat'), home: path.join(tmpdir(), 'no-such-home-' + Date.now()) })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /找不到 NapCat/)
})

await check('二维码路径跟着安装目录走，不再把版本号写死在两处', () => {
  assert.equal(qrPathOf('C:\\x\\napcat\\4.18.41'), path.join('C:\\x\\napcat\\4.18.41', 'napcat', 'cache', 'qrcode.png'))
  assert.equal(qrPathOf(''), '')
})

await check('NapCat WebUI 的登录哈希 = sha256(token + ".napcat")', () => {
  assert.equal(napcatHash('abc'), '42e5515d256cb0ab3de18017ee3adefc15aa70229c27788bab5aee39d5d439e6')
  assert.equal(napcatHash('napcat'), 'fab552ce31e45b51288bb374b7e08d720f1d612e20fb7361246139c1e476f0b0')
  assert.equal(napcatHash(''), '9321a78bf9c95f3d2b7ade7f2d02a4608c92bfa68f3fd7c18622d82bc93080cd')
})

await check('通道在线：登录阶段就是在线，不再看二维码旧不旧', () => {
  const info = describeLogin({
    mode: 'ticket',
    channelState: 'online',
    reachable: true,
    raw: { isLogin: false, loginPhase: 'waiting_qrcode' },
    plan: { ok: true },
    qr: { exists: true, ageMs: 999_999 },
  })
  assert.equal(info.phase, 'online')
  assert.equal(info.online, true)
  assert.equal(info.tone, 'ok')
})

await check('票据方式出现二维码：明确说「票据没成功，已自动出码」', () => {
  const info = describeLogin({
    mode: 'ticket',
    autoQr: true,
    channelState: 'offline',
    reachable: true,
    raw: { isLogin: false, loginPhase: 'waiting_qrcode', loginError: '' },
    plan: { ok: true },
    qr: { exists: true, ageMs: 10_000 },
  })
  assert.equal(info.phase, 'waiting_qr')
  assert.equal(info.qrSuppressed, false)
  assert.match(info.hint, /票据没成功/)
  assert.match(info.hint, /二维码/)
})

await check('自动出码关掉：不替用户出码，但保留「扫码登录」这条路', () => {
  const info = describeLogin({
    mode: 'ticket',
    autoQr: false,
    channelState: 'offline',
    reachable: true,
    raw: { isLogin: false, loginPhase: 'waiting_qrcode' },
    plan: { ok: true },
    qr: { exists: true, ageMs: 10_000 },
  })
  assert.equal(info.phase, 'qr_blocked')
  assert.equal(info.qrSuppressed, true)
  assert.equal(info.qrAllowed, false)
  assert.match(info.hint, /自动二维码关着/)
  assert.equal(info.canShowQr, true, '关掉的是自动出码，不是禁止扫码')
})

await check('扫码方式：出码是正常流程，不该被说成「票据没成功」', () => {
  const info = describeLogin({
    mode: 'qr',
    autoQr: false,
    channelState: 'unknown',
    reachable: true,
    raw: { isLogin: false, loginPhase: 'waiting_qrcode' },
    plan: { ok: true },
    qr: { exists: true, ageMs: 10_000 },
  })
  assert.equal(info.phase, 'waiting_qr')
  assert.equal(info.qrSuppressed, false)
  assert.doesNotMatch(info.hint, /票据没成功/)
})

await check('已扫码、初始化、等通道：三个阶段各自说不同的话', () => {
  const base = { mode: 'qr', channelState: 'offline', reachable: true, plan: { ok: true }, qr: { exists: true, ageMs: 1 } }
  const scanned = describeLogin({ ...base, raw: { isLogin: false, loginPhase: 'qrcode_scanned' } })
  assert.equal(scanned.phase, 'scanned')
  assert.match(scanned.hint, /手机/)
  const initializing = describeLogin({ ...base, raw: { isLogin: true, coreReady: false, loginPhase: 'ready' } })
  assert.equal(initializing.phase, 'initializing')
  const connecting = describeLogin({ ...base, raw: { isLogin: true, coreReady: true, loginPhase: 'ready' } })
  assert.equal(connecting.phase, 'connecting')
  assert.match(connecting.hint, /OneBot/)
})

await check('登录失败：错误原文要说出来，但截断防撑破面板', () => {
  const info = describeLogin({
    mode: 'ticket',
    channelState: 'offline',
    reachable: true,
    raw: { isLogin: false, loginPhase: 'offline', loginError: '错误'.repeat(200) },
    plan: { ok: true },
    qr: { exists: false },
  })
  assert.equal(info.phase, 'offline')
  assert.equal(info.tone, 'bad')
  assert.ok(info.hint.length < 260)
  assert.match(info.hint, /错误/)
})

await check('问不到 WebUI，但刚启动：说「正在启动」，不猜成在线', () => {
  const now = 1_800_000_000_000
  const info = describeLogin({
    mode: 'ticket',
    channelState: 'offline',
    reachable: false,
    raw: null,
    plan: { ok: true },
    qr: { exists: false },
    startedAt: now - 5000,
    now,
  })
  assert.equal(info.phase, 'starting')
  assert.match(info.hint, /10–20 秒/)
})

await check('通道关了：登录说得再多也没用，直接说关了', () => {
  const info = describeLogin({ mode: 'ticket', channelState: 'off', reachable: true, plan: { ok: true } })
  assert.equal(info.phase, 'off')
  assert.equal(info.tone, 'idle')
})

await check('配置不完整：先说说缺什么，而不是显示一个「未知」', () => {
  const info = describeLogin({
    mode: 'ticket',
    channelState: 'unknown',
    reachable: false,
    plan: { ok: false, error: '没填机器人 QQ 号，无法用票据或密码登录' },
  })
  assert.equal(info.phase, 'not_ready')
  assert.match(info.hint, /QQ 号/)
})

await check('「多久以前」三档：刚刚 / 分钟 / 小时', () => {
  assert.equal(ageText(5000), '刚刚')
  assert.equal(ageText(125_000), '2 分钟前')
  assert.equal(ageText(3 * 3_600_000), '3 小时前')
})

// ── 假 WebUI：走一遍真实轮询，证明阶段与快照能对上 ──────────────
const root = mkdtempSync(path.join(tmpdir(), 'whale-napcat-test-'))
const install = path.join(root, '4.18.41')
mkdirSync(path.join(install, 'napcat', 'config'), { recursive: true })
mkdirSync(path.join(install, 'napcat', 'cache'), { recursive: true })
writeFileSync(path.join(install, 'napcat.bat'), '@echo off\r\n', 'utf8')
writeFileSync(path.join(install, 'napcat', 'config', 'webui.json'), JSON.stringify({ port: 6099, token: 'webui-secret-token', disableWebUI: false }), 'utf8')
writeFileSync(path.join(install, 'napcat', 'cache', 'qrcode.png'), 'fake-png', 'utf8')
const launcher = path.join(root, '启动NapCat.bat')
writeFileSync(launcher, 'cd /d "' + install + '"\r\ncall napcat.bat -q 1000000001\r\n', 'utf8')

function configOf(over = {}) {
  return {
    channel: {
      enabled: true,
      napcatBat: launcher,
      selfId: '1000000001',
      login: { mode: 'ticket', autoQr: true, password: '', ...over },
    },
  }
}

function fakeFetch(log = []) {
  return async (url, options) => {
    log.push({ url, options })
    if (url.endsWith('/api/auth/login')) return reply({ code: 0, data: { Credential: 'cred-1' } })
    if (url.endsWith('/api/QQLogin/CheckLoginStatus')) {
      return reply({ code: 0, data: { isLogin: false, isOffline: false, loginPhase: 'waiting_qrcode', loginError: '' } })
    }
    return reply({ code: 0, data: {} })
  }
}

await check('启动目标优先直接调 NapCat 的 napcat.bat，不被用户脚本里写死的 -q 带跑', () => {
  const login = new NapCatLogin({
    config: configOf({ mode: 'qr' }),
    channel: { state: () => 'offline' },
    fetch: fakeFetch(),
    platform: 'win32',
    now: () => 1_800_000_000_000,
  })
  const plan = login.plan()
  assert.equal(plan.ok, true)
  assert.equal(plan.launchTarget, path.join(install, 'napcat.bat'))
  assert.ok(!plan.launchTarget.includes('启动NapCat'), '不该再调那个写死 -q 的用户脚本')
  const spawned = []
  const started = new NapCatLogin({
    config: configOf({ mode: 'qr' }),
    channel: { state: () => 'offline' },
    fetch: fakeFetch(),
    platform: 'win32',
    now: () => 1_800_000_000_000,
    spawn: (command, args, options) => {
      spawned.push({ command, args, options })
      return { unref() {} }
    },
  }).start({ force: true })
  assert.equal(started.ok, true)
  assert.deepEqual(started.args, [], '扫码方式不该带 -q')
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].command, 'wscript.exe')
})

await check('轮询：从 WebUI 读到阶段、带上二维码文件，不泄露密码与 WebUI 令牌', async () => {
  const calls = []
  const login = new NapCatLogin({
    config: configOf({ password: 'pw-should-not-leak' }),
    channel: { state: () => 'offline' },
    fetch: fakeFetch(calls),
    now: () => 1_800_000_000_000,
  })
  const snapshot = await login.poll()
  assert.equal(snapshot.phase, 'waiting_qr')
  assert.equal(snapshot.reachable, true)
  assert.equal(snapshot.qr.exists, true)
  assert.ok(calls.some((one) => one.url.endsWith('/api/auth/login')))
  const text = JSON.stringify(snapshot)
  assert.ok(!text.includes('pw-should-not-leak'), '密码不能进快照')
  assert.ok(!text.includes('webui-secret-token'), 'WebUI 令牌不能进快照')
})

await check('改配置后重新读：autoQr 关掉，下一次轮询就变成「等你点扫码」', async () => {
  const login = new NapCatLogin({
    config: configOf(),
    channel: { state: () => 'offline' },
    fetch: fakeFetch(),
    now: () => 1_800_000_000_000,
  })
  const first = await login.poll()
  assert.equal(first.qrSuppressed, false)
  login.relink(configOf({ autoQr: false }))
  const second = await login.poll()
  assert.equal(second.phase, 'qr_blocked')
  assert.equal(second.qrSuppressed, true)
})

await check('在线时不启动协议端；通道关着时也不启动', async () => {
  let spawned = 0
  const login = new NapCatLogin({
    config: configOf(),
    channel: { state: () => 'online' },
    fetch: fakeFetch(),
    spawn: () => { spawned += 1; return { unref() {} } },
  })
  const online = await login.ensure({ reason: 'watchdog' })
  assert.equal(online.online, true)
  assert.equal(spawned, 0, '在线时不该再拉一份 NapCat')

  const off = new NapCatLogin({
    config: { channel: { ...configOf().channel, enabled: false } },
    channel: { state: () => 'off' },
    fetch: fakeFetch(),
    spawn: () => { spawned += 1; return { unref() {} } },
  })
  const disabled = await off.ensure({ reason: 'watchdog' })
  assert.equal(disabled.skipped, 'channel-disabled')
  assert.equal(spawned, 0)
})

await check('开机自启关着：开机时不替用户拉进程', async () => {
  let spawned = 0
  const login = new NapCatLogin({
    config: configOf(),
    channel: { state: () => 'offline' },
    fetch: fakeFetch(),
    spawn: () => { spawned += 1; return { unref() {} } },
  })
  const result = await login.ensure({ reason: 'boot' })
  assert.equal(result.skipped, 'autostart-off')
  assert.equal(spawned, 0)
})

console.log(`\n${failed.length ? '✗' : '✓'} 登录层用例：${passed} 项通过`)
if (failed.length) {
  for (const { name, error } of failed) console.log(`  ${name}: ${error.message}`)
  process.exit(1)
}
rmSync(root, { recursive: true, force: true })
