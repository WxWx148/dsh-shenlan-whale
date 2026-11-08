/**
 * 「登录成了，通道连不上」这一段的用例。
 *
 * 这一段以前只有一个表情：面板写「检查 OneBot 地址和令牌」。
 * 但真正的原因常常既不是地址也不是令牌 —— 而是 NapCat 那个 QQ 号的
 * OneBot 网络配置里压根没加 WebSocket 服务端（配置按号分开存，换号就空）。
 * 所以这里钉两件事：
 *   1. 端口探活能把「没人听」和「握手没过」分开；
 *   2. 面板那句提示会跟着探活结果变，而不是永远一句话。
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NapCatLogin, describeLogin, endpointOf, probeTcp } from '../channel/index.mjs'

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

const reply = (body) => ({ json: async () => body })

/** 假 socket：像 net.connect 那样返回一个能 emit 的对象 */
function fakeConnect(outcome, capture = () => {}) {
  return (options) => {
    capture(options)
    const socket = new EventEmitter()
    socket.destroy = () => {}
    setImmediate(() => {
      if (outcome === 'connect') socket.emit('connect')
      else socket.emit('error', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3001'), { code: 'ECONNREFUSED' }))
    })
    return socket
  }
}

console.log('\n通道探活')

await check('ws 地址拆成 host/port；写错了要返回 null，不能瞎猜', () => {
  assert.deepEqual(endpointOf('ws://127.0.0.1:3001'), { host: '127.0.0.1', port: 3001, secure: false })
  assert.deepEqual(endpointOf('wss://example.com'), { host: 'example.com', port: 443, secure: true })
  assert.deepEqual(endpointOf('ws://127.0.0.1'), { host: '127.0.0.1', port: 80, secure: false })
  assert.equal(endpointOf(''), null)
  assert.equal(endpointOf('127.0.0.1:3001'), null)
})

await check('端口没人听：返回 ECONNREFUSED，不当成「超时」', async () => {
  let got = null
  const result = await probeTcp({ host: '127.0.0.1', port: 3001 }, { connect: fakeConnect('refused', (o) => { got = o }) })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ECONNREFUSED')
  assert.deepEqual(got, { host: '127.0.0.1', port: 3001 })
})

await check('端口在听：ok = true', async () => {
  const result = await probeTcp({ host: '127.0.0.1', port: 3001 }, { connect: fakeConnect('connect') })
  assert.equal(result.ok, true)
})

await check('没有地址：说「没有可探测的地址」，不去连', async () => {
  const result = await probeTcp(null)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'NO_TARGET')
})

console.log('\n面板那句提示')

const base = { mode: 'qr', channelState: 'offline', reachable: true, plan: { ok: true }, qr: { exists: true, ageMs: 1 } }
const ready = { isLogin: true, coreReady: true, loginPhase: 'ready' }

await check('没探过端口：还是老话（提 OneBot），不编原因', () => {
  const info = describeLogin({ ...base, raw: ready })
  assert.equal(info.phase, 'connecting')
  assert.match(info.hint, /OneBot/)
})

await check('端口没人听：直说 NapCat 没开 WebSocket 服务端，并点出「配置按号分开存」', () => {
  const info = describeLogin({
    ...base,
    raw: ready,
    socket: { ok: false, code: 'ECONNREFUSED', host: '127.0.0.1', port: 3001, error: 'connect ECONNREFUSED' },
  })
  assert.equal(info.phase, 'connecting')
  assert.match(info.hint, /WebSocket 服务端/)
  assert.match(info.hint, /127\.0\.0\.1:3001/)
  assert.match(info.hint, /QQ 号/)
  assert.ok(info.hint.length <= 200)
})

await check('端口在听：指向令牌不一致，而不是让人去改端口', () => {
  const info = describeLogin({ ...base, raw: ready, socket: { ok: true, host: '127.0.0.1', port: 3001 } })
  assert.match(info.hint, /令牌/)
  assert.doesNotMatch(info.hint, /没有程序在听/)
})

await check('别的错（超时）：原文带上，不硬套「服务端没开」', () => {
  const info = describeLogin({ ...base, raw: ready, socket: { ok: false, code: 'ETIMEDOUT', host: '10.0.0.2', port: 3001 } })
  assert.match(info.hint, /ETIMEDOUT/)
  assert.doesNotMatch(info.hint, /WebSocket 服务端/)
})

console.log('\n登录轮询：探活结果要进快照')

const root = mkdtempSync(path.join(tmpdir(), 'whale-probe-test-'))
mkdirSync(path.join(root, 'napcat', 'config'), { recursive: true })
writeFileSync(path.join(root, 'napcat.bat'), '@echo off\r\n', 'utf8')
writeFileSync(
  path.join(root, 'napcat', 'config', 'webui.json'),
  JSON.stringify({ port: 6099, token: 'webui-token-for-test', disableWebUI: false }),
  'utf8',
)
const launcher = path.join(root, '启动NapCat.bat')
writeFileSync(launcher, 'cd /d "' + root + '"\r\ncall napcat.bat\r\n', 'utf8')

const config = {
  channel: {
    enabled: true,
    wsUrl: 'ws://127.0.0.1:3001',
    token: '',
    selfId: '10001',
    napcatBat: launcher,
    login: { mode: 'qr', autoQr: true, password: '' },
  },
}

await check('已登录但通道掉线：快照里带 socket，提示按探活结果改口径', async () => {
  let probed = 0
  const login = new NapCatLogin({
    config,
    channel: { state: () => 'offline' },
    fetch: async (url) => {
      if (String(url).includes('/api/auth/login')) return reply({ data: { Credential: 'cred' } })
      return reply({ code: 0, data: ready })
    },
    probe: async (endpoint) => {
      probed += 1
      return { ok: false, code: 'ECONNREFUSED', error: 'connect ECONNREFUSED ' + endpoint.host + ':' + endpoint.port }
    },
    platform: 'linux',
  })
  const snap = await login.poll()
  assert.equal(probed, 1)
  assert.equal(snap.phase, 'connecting')
  assert.equal(snap.socket.code, 'ECONNREFUSED')
  assert.match(snap.hint, /WebSocket 服务端/)
  // 端口探活不许多嘴：密码、令牌都不该出现在快照里
  assert.doesNotMatch(JSON.stringify(snap), /webui-token-for-test/)
})

await check('通道在线：不探端口（在线时端口当然通，探了没意义）', async () => {
  let probed = 0
  const login = new NapCatLogin({
    config,
    channel: { state: () => 'online' },
    fetch: async (url) => {
      if (String(url).includes('/api/auth/login')) return reply({ data: { Credential: 'cred' } })
      return reply({ code: 0, data: ready })
    },
    probe: async () => {
      probed += 1
      return { ok: true }
    },
    platform: 'linux',
  })
  await login.poll()
  assert.equal(probed, 0)
})

await check('还没登录：也不探（那时候端口本来就不通）', async () => {
  let probed = 0
  const login = new NapCatLogin({
    config,
    channel: { state: () => 'offline' },
    fetch: async (url) => {
      if (String(url).includes('/api/auth/login')) return reply({ data: { Credential: 'cred' } })
      return reply({ code: 0, data: { isLogin: false, loginPhase: 'waiting_qrcode' } })
    },
    probe: async () => {
      probed += 1
      return { ok: false, code: 'ECONNREFUSED' }
    },
    platform: 'linux',
  })
  await login.poll()
  assert.equal(probed, 0)
})

await check('WebUI 端口有人在听 = 协议端在跑，看门狗不许再拉一份', async () => {
  let started = 0
  const login = new NapCatLogin({
    config,
    channel: { state: () => 'offline' },
    // WebUI 问不到阶段（模拟 webui.json 被关），但端口是通的
    fetch: async () => {
      throw new Error('ECONNREFUSED')
    },
    probe: async (endpoint) => (endpoint.port === 6099 ? { ok: true } : { ok: false, code: 'ECONNREFUSED' }),
    spawn: () => {
      started += 1
      return { unref() {} }
    },
    exec: async () => ({ stdout: '' }),
    platform: 'win32',
  })
  const result = await login.ensure({ reason: 'watchdog' })
  assert.equal(started, 0)
  assert.equal(result.running, true)
})

console.log('\n「通道在线但账号已死」时还能不能自救')

await check('默认闸门：通道在线就不重启（避免自动流程乱重启）', async () => {
  const login = new NapCatLogin({
    config,
    channel: { state: () => 'online' },
    fetch: async () => reply({ code: 0, data: {} }),
    probe: async () => ({ ok: true }),
    platform: 'win32',
  })
  let killed = 0
  login.kill = async () => { killed += 1; return { ok: true } }
  const result = await login.restart()
  assert.equal(result.online, true)
  assert.equal(killed, 0, '没强制就不该动协议端')
})

await check('强制重启：通道在线也照做（1006514 网络异常时唯一的自救路）', async () => {
  const login = new NapCatLogin({
    config,
    channel: { state: () => 'online' },
    fetch: async () => reply({ code: 0, data: {} }),
    probe: async () => ({ ok: true }),
    platform: 'win32',
  })
  let killed = 0
  login.kill = async () => { killed += 1; return { ok: true } }
  login.start = () => ({ ok: true })
  login.poll = async () => {}
  const result = await login.restart({ force: true })
  assert.equal(result.ok, true)
  assert.equal(killed, 1, '强制重启必须真的杀掉再起')
})

await check('强制刷新二维码：通道在线也去要一张新的', async () => {
  const login = new NapCatLogin({
    config,
    channel: { state: () => 'online' },
    fetch: async (url) => {
      if (String(url).includes('/api/auth/login')) return reply({ data: { Credential: 'cred' } })
      return reply({ code: 0, data: {} })
    },
    probe: async () => ({ ok: true }),
    platform: 'win32',
  })
  // 这三行不是为了「让测试过」，是为了不让用例真去杀本机的协议端：
  // kill 走的是 PowerShell，真跑起来会把用户正在用的 NapCat 停掉。
  login.kill = async () => ({ ok: true })
  login.start = () => ({ ok: true })
  login.poll = async () => {}
  login.call = async () => ({ ok: true, data: {} })
  const result = await login.retryQr({ force: true })
  assert.equal(result.ok, true)
  assert.notEqual(result.online, true, '强制刷新不该再回「已在线，不需要二维码」')
})

rmSync(root, { recursive: true, force: true })

console.log(`\n通道探活：${passed} 过 / ${failed.length} 挂`)
if (failed.length) {
  for (const item of failed) console.error('  ✗ ' + item.name + '\n    ' + (item.error?.stack || item.error))
  process.exit(1)
}
