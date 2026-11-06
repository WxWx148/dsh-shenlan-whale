/**
 * 面板性能基线（开发用，不进 npm test）。
 *
 * 为什么要有这个脚本：
 *   「优化运行逻辑」不能只凭感觉。面板每开一次都会重算状态、技能、审计、会话，
 *   这些数字背后是同步读文件 + JSON.parse。改之前先量一遍，改完再量一遍，
 *   才知道是真快了，还是只是代码变短了。
 *
 * 做法：造一个真实数据目录（事件 5000 条、审计 2000 条、行为 1000 条、思维链 500 条），
 * 用真的 Runtime / Usage 跑 panelView 与 detailView，取 20 次的中位数。
 *
 * 用法：node scripts/bench-panel.mjs [--json]
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { Runtime } from '../lib/runtime.mjs'
import { Usage } from '../lib/usage.mjs'
import { Guard } from '../lib/guard.mjs'
import { Chat } from '../lib/chat.mjs'
import { panelView, detailView } from '../lib/panel-view.mjs'

const EVENTS = Number(process.env.BENCH_EVENTS) || 5000
const ROUNDS = Number(process.env.BENCH_ROUNDS) || 20

function seed(file, count, make) {
  const lines = []
  for (let i = 0; i < count; i += 1) lines.push(JSON.stringify(make(i)))
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
}

function seedDir(dir) {
  const now = Date.now()
  seed(path.join(dir, 'events.jsonl'), EVENTS, (i) => ({
    ts: now - (EVENTS - i) * 1000,
    at: now - (EVENTS - i) * 1000,
    kind: 'event',
    id: `e${i}`,
    type: i % 7 === 0 ? 'image' : 'message',
    scope: i % 3 === 0 ? 'group' : 'private',
    from: `u${i % 40}`,
    conversation: i % 3 === 0 ? `group:${9000 + (i % 5)}` : `private:${1000 + (i % 40)}`,
    tags: ['to-me'],
    text: `第 ${i} 条消息，内容长度按真实聊天写一点。`,
    sender: `用户${i % 40}`,
    group: i % 3 === 0 ? String(9000 + (i % 5)) : undefined,
  }))
  seed(path.join(dir, 'audit.jsonl'), Math.max(200, Math.round(EVENTS / 2.5)), (i) => ({
    ts: now - (EVENTS - i) * 2000,
    at: now - (EVENTS - i) * 2000,
    id: `a${i}`,
    kind: i % 13 === 0 ? 'config_reject' : 'config',
    label: `设置项 ${i}`,
    key: 'guard.perMinute',
    before: 15,
    after: 16,
  }))
  seed(path.join(dir, 'behaviors.jsonl'), Math.max(100, Math.round(EVENTS / 5)), (i) => ({
    ts: now - (EVENTS - i) * 3000,
    at: now - (EVENTS - i) * 3000,
    id: `b${i}`,
    kind: 'behavior',
    behavior: 'reply',
    ok: i % 11 !== 0,
  }))
  seed(path.join(dir, 'cot.jsonl'), Math.max(50, Math.round(EVENTS / 10)), (i) => ({
    ts: now - (EVENTS - i) * 4000,
    at: now - (EVENTS - i) * 4000,
    id: `c${i}`,
    summary: `第 ${i} 轮`,
    text: `这一轮想了 ${i} 件事`,
    conversation: `private:${1000 + (i % 40)}`,
  }))
  seed(path.join(dir, 'activity.jsonl'), 80, (i) => ({
    ts: now - (EVENTS - i) * 5000,
    at: now - (EVENTS - i) * 5000,
    id: `x${i}`,
    kind: 'wonder',
    text: `想了点事 ${i}`,
  }))
}

/** 取中位数，避免一次 GC 抖动把结论带偏 */
function median(list) {
  const sorted = [...list].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const dir = mkdtempSync(path.join(tmpdir(), 'whale-bench-'))
try {
  seedDir(dir)
  const runtime = new Runtime({ dir })
  const usage = new Usage({ config: runtime.config, journal: runtime.audit, file: path.join(dir, 'usage.json') })
  const guard = new Guard({ config: runtime.config })
  const channel = { state: () => 'online' }
  const chat = new Chat({ runtime, generate: null })

  const inputs = { runtime, chat, usage, guard, channel, at: Date.now() }

  // 预热：第一次要把日志读进缓存，不能算进稳态
  for (let i = 0; i < 3; i += 1) panelView(inputs)

  const panelTimes = []
  for (let i = 0; i < ROUNDS; i += 1) {
    const start = performance.now()
    const page = panelView(inputs)
    panelTimes.push(performance.now() - start)
    if (!page.ok) throw new Error('panelView 没算出来')
  }

  const detailIds = ['process.audit', 'process.cot', 'talk.qq', 'skills.all', 'settings.sandbox', 'usage.today']
  const detailTimes = {}
  for (const id of detailIds) {
    const times = []
    for (let i = 0; i < Math.max(5, Math.floor(ROUNDS / 2)); i += 1) {
      const start = performance.now()
      const one = detailView({ ...inputs, id })
      times.push(performance.now() - start)
      if (!one.ok) throw new Error(`detailView(${id}) 没算出来`)
    }
    detailTimes[id] = Number(median(times).toFixed(2))
  }

  // 面板背后最常被重复调用的两个方法：状态与技能清单。
  // 它们各自的缓存有没有生效，看这两个数最直接。
  const runtimeTimes = {}
  for (const [name, fn] of [['status', () => runtime.status()], ['skills', () => runtime.skills()]]) {
    for (let i = 0; i < 3; i += 1) fn()
    const times = []
    for (let i = 0; i < ROUNDS; i += 1) {
      const start = performance.now()
      fn()
      times.push(performance.now() - start)
    }
    runtimeTimes[name] = Number(median(times).toFixed(3))
  }

  const result = {
    events: EVENTS,
    rounds: ROUNDS,
    panelMedianMs: Number(median(panelTimes).toFixed(2)),
    panelP95Ms: Number([...panelTimes].sort((a, b) => a - b)[Math.floor(panelTimes.length * 0.95)].toFixed(2)),
    detailMedianMs: detailTimes,
    runtimeMedianMs: runtimeTimes,
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`事件 ${EVENTS} 条 · ${ROUNDS} 次`)
    console.log(`panelView 中位数 ${result.panelMedianMs} ms · P95 ${result.panelP95Ms} ms`)
    for (const [id, ms] of Object.entries(detailTimes)) console.log(`detailView(${id}) 中位数 ${ms} ms`)
    console.log(`runtime.status() ${runtimeTimes.status} ms · runtime.skills() ${runtimeTimes.skills} ms`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
