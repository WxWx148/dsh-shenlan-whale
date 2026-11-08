/**
 * 掉线自愈用例（0.42.0）。
 *
 * 钉四件事：
 *   1. 用户自己的 QQ.exe 不算「NapCat 在跑」——这是旧版「掉线后再也回不来」的根因；
 *   2. 掉线不到 2 分钟、正在等扫码、二维码还新，都不许重启；
 *   3. 重启只杀 NapCat 自己的进程，绝不碰用户的 QQ 客户端；
 *   4. 每小时最多 2 次，计数落盘，DSH 重启不重置。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NapCatLogin } from '../channel/index.mjs'

let passed = 0
const failed = []
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed.push({ name, error })
    console.log(`  ✗ ${name}`)
  }
}

const config = {
  channel: {
    enabled: true,
    selfId: '1000000001',
    wsUrl: 'ws://127.0.0.1:3001',
    token: 't',
    autoStartNapcat: true,
    watchdogEnabled: true,
    watchdogMinutes: 2,
    login: { mode: 'ticket', autoQr: true, password: 'x' },
  },
}

function base(over = {}) {
  return new NapCatLogin({
    config,
    platform: 'win32',
    now: () => over.now || 1_000_000,
    sleep: async () => {},
    exec: async () => ({ stdout: '' }),
    probe: async () => ({ ok: false, code: 'ECONNREFUSED' }),
    fetch: async () => { throw new Error('WebUI 没开') },
    ...over,
  })
}

await check('agentRunning 不把用户自己的 QQ.exe 当成 NapCat', async () => {
  // 旧实现先问 tasklist 里有没有 QQ.exe：用户 QQ 常开，于是永远认为「协议端在跑」。
  const login = base()
  assert.equal(await login.agentRunning(), false)
})

await check('agentRunning 认 NapCat 自己的 node 进程', async () => {
  const login = base({
    exec: async () => ({ stdout: '4321\r\n' }),
  })
  assert.equal(await login.agentRunning(), true)
})

await check('agentRunning 认 WebUI 6099 有应答', async () => {
  const login = base({
    exec: async () => ({ stdout: '' }),
    probe: async (endpoint) => ({ ok: endpoint.port === 6099 }),
  })
  login.webui = () => ({ ok: true, port: 6099 })
  assert.equal(await login.agentRunning(), true)
})

await check('掉线不到 2 分钟：不动它', async () => {
  const login = base()
  let restarted = 0
  login.poll = async () => {}
  login.snapshot = () => ({ online: false, reachable: true, phase: 'offline', qr: { exists: false } })
  login.restart = async () => { restarted += 1; return { ok: true } }
  const result = await login.recover({ downMs: 60_000 })
  assert.equal(result.skipped, 'too-early')
  assert.equal(restarted, 0)
})

await check('正在等扫码：不重启，别把用户正扫的码作废', async () => {
  const login = base()
  let restarted = 0
  login.poll = async () => {}
  login.snapshot = () => ({ online: false, reachable: true, phase: 'waiting_qr', qr: { exists: true, ageMs: 30_000 } })
  login.restart = async () => { restarted += 1; return { ok: true } }
  const result = await login.recover({ downMs: 180_000 })
  assert.equal(result.skipped, 'waiting-login')
  assert.equal(restarted, 0)
})

await check('等扫码超过 5 分钟：不再无限等，强制重启', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-recover-wait-'))
  try {
    let now = 1_000_000
    let restarted = 0
    const login = base({ dir })
    login.now = () => now
    login.poll = async () => {}
    login.snapshot = () => ({ online: false, reachable: true, phase: 'waiting_qr', qr: { exists: true, ageMs: 30_000 } })
    login.restart = async () => { restarted += 1; now += 40_000; return { ok: true } }
    const first = await login.recover({ downMs: 600_000 })
    assert.equal(first.skipped, 'waiting-login')
    now += 5 * 60_000 + 1
    const second = await login.recover({ downMs: 600_000 })
    assert.equal(second.restarted, true)
    assert.equal(restarted, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('二维码还新：也不重启', async () => {
  const login = base()
  let restarted = 0
  login.poll = async () => {}
  login.snapshot = () => ({ online: false, reachable: true, phase: 'unknown', qr: { exists: true, ageMs: 60_000 } })
  login.restart = async () => { restarted += 1; return { ok: true } }
  const result = await login.recover({ downMs: 180_000 })
  assert.equal(result.skipped, 'qr-recent')
  assert.equal(restarted, 0)
})

await check('掉线 3 分钟、没在扫码：重启一次并等到恢复', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-recover-'))
  try {
    let phase = 'offline'
    const login = base({ dir })
    login.poll = async () => {}
    login.snapshot = () => ({ online: phase === 'online', reachable: false, phase, qr: { exists: false } })
    login.restart = async () => { phase = 'online'; return { ok: true } }
    const result = await login.recover({ downMs: 180_000 })
    assert.equal(result.restarted, true)
    assert.equal(result.online, true)
    assert.equal(result.attempt, 1)
    assert.ok(existsSync(path.join(dir, 'napcat-recovery.json')), '恢复计数要落盘')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('每小时最多 2 次：第 3 次直接跳过', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-recover-limit-'))
  try {
    let phase = 'offline'
    let restarted = 0
    const login = base({ dir })
    login.poll = async () => {}
    login.snapshot = () => ({ online: phase === 'online', reachable: false, phase, qr: { exists: false } })
    login.restart = async () => { restarted += 1; phase = 'online'; return { ok: true } }
    await login.recover({ downMs: 180_000 })
    phase = 'offline'
    await login.recover({ downMs: 180_000 })
    phase = 'offline'
    const third = await login.recover({ downMs: 180_000 })
    assert.equal(restarted, 2)
    assert.equal(third.skipped, 'rate-limit')
    assert.equal(third.attempts, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('重启只杀 NapCat 的进程，命令行里没有「杀 QQ」', async () => {
  let captured = ''
  const login = base({
    exec: async (_bin, args) => { captured = String(args?.[3] || ''); return { stdout: '' } },
  })
  login.napcatRunning = async () => false
  login.webui = () => ({ ok: false })
  const result = await login.kill()
  assert.equal(result.ok, true)
  assert.match(captured, /qq-fish/)
  assert.match(captured, /napcat/)
  assert.doesNotMatch(captured, /Get-Process QQ/i, '不许再一刀切杀用户 QQ')
})

console.log(`\n${failed.length ? '✗' : '✓'} 掉线自愈用例：${passed} 项通过`)
if (failed.length) {
  for (const { name, error } of failed) console.log(`  ${name}: ${error.message}`)
  process.exit(1)
}
