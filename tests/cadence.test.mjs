/**
 * tests/cadence.test.mjs — 说话节奏
 *
 * 这个模块管的是「主动开口别像闹钟」。
 *
 * 最要紧的一条：**间隔必须随机**。
 * 固定 180 分钟整点报时，主人看两天时间就知道它是机器 ——
 * 那比复读还明显，因为复读还有可能是手滑，连着报时不会。
 */

import assert from 'node:assert/strict'
import {
  Cadence,
  DEFAULT_MAX_GAP_MINUTES,
  DEFAULT_MIN_GAP_MINUTES,
  DEFAULT_SKIP_CHANCE,
  pickGapMs,
  shouldSpeak,
} from '../decide/index.mjs'

const check = async (name, fn) => {
  try {
    await fn()
    console.log('✓ ' + name)
  } catch (error) {
    console.log('✗ ' + name)
    console.log('  ' + String(error?.message || error).split('\n').slice(0, 4).join('\n  '))
    process.exitCode = 1
  }
}

/** 可复现的随机源 */
const seeded = (seed = 42) => {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
}

// ── 间隔 ─────────────────────────────────────────────────────
await check('间隔：落在设定的区间里', () => {
  const rnd = seeded()
  for (let i = 0; i < 200; i += 1) {
    const gap = pickGapMs(45, 120, rnd)
    assert.ok(gap >= 45 * 60_000, '不能比下限短：' + gap)
    assert.ok(gap <= 120 * 60_000, '不能比上限长：' + gap)
  }
})

await check('间隔：不是固定值（这是这一层的全部意义）', () => {
  const rnd = seeded()
  const gaps = new Set()
  for (let i = 0; i < 50; i += 1) gaps.add(pickGapMs(45, 120, rnd))
  assert.ok(gaps.size > 20, `50 次要抽出多种间隔，实际只有 ${gaps.size} 种`)
})

await check('间隔：偏向短的一端，但保留长尾', () => {
  // 平方分布 → 多数落在区间下半段
  const rnd = seeded()
  let low = 0
  const mid = (DEFAULT_MIN_GAP_MINUTES + DEFAULT_MAX_GAP_MINUTES) / 2
  for (let i = 0; i < 200; i += 1) {
    if (pickGapMs(DEFAULT_MIN_GAP_MINUTES, DEFAULT_MAX_GAP_MINUTES, rnd) / 60_000 < mid) low += 1
  }
  assert.ok(low > 120, '多数间隔该落在下半段，实际 ' + low + '/200')
})

await check('间隔：区间反了也不会出错', () => {
  const rnd = seeded()
  const gap = pickGapMs(120, 45, rnd)
  assert.ok(gap >= 45 * 60_000 && gap <= 120 * 60_000, '上限小于下限时该自动纠正')
})

// ── 概率 ─────────────────────────────────────────────────────
await check('概率：到点了也可能忍住', () => {
  const rnd = seeded()
  let spoke = 0
  for (let i = 0; i < 1000; i += 1) if (shouldSpeak({ skipChance: 0.35, random: rnd })) spoke += 1
  assert.ok(spoke > 550 && spoke < 750, `开口率该在 65% 上下，实际 ${(spoke / 10).toFixed(1)}%`)
})

await check('概率：skipChance=0 就是每次都说', () => {
  const rnd = seeded()
  for (let i = 0; i < 20; i += 1) {
    assert.equal(shouldSpeak({ skipChance: 0, random: rnd }), true, '不该有机会忍住')
  }
})

await check('概率：skipChance=1 就是永远不说', () => {
  const rnd = seeded()
  for (let i = 0; i < 20; i += 1) {
    assert.equal(shouldSpeak({ skipChance: 1, random: rnd }), false, '该一直忍住')
  }
})

// ── Cadence ──────────────────────────────────────────────────
await check('节奏：第一次总能开口（新装上不用等 45 分钟）', () => {
  const c = new Cadence({ now: () => 1000, random: seeded() })
  assert.equal(c.check(1000).ok, true, '第一次该能说')
})

await check('节奏：说完之后间隔没到就不说', () => {
  let at = 1000
  const c = new Cadence({ now: () => at, random: seeded(), minMinutes: 45, maxMinutes: 120 })
  c.markSpoke(at)
  at += 60_000
  const gate = c.check(at)
  assert.equal(gate.ok, false, '1 分钟后不该说')
  assert.equal(gate.why, 'wait', '原因该是「还在等」')
  assert.ok(gate.remainingMs > 0, '该告诉调用方还要等多久')
})

await check('节奏：到点了也可能忍住，但原因要说清是「skip」不是「wait」', () => {
  let at = 1000
  // random 落在 skipChance 之下 → 该忍住
  const c = new Cadence({ now: () => at, random: () => 0.10, minMinutes: 45, maxMinutes: 120, skipChance: 0.9 })
  c.markSpoke(at)
  at += 999_999_999
  const gate = c.check(at)
  assert.equal(gate.ok, false, '概率该起作用')
  assert.equal(gate.why, 'skip', '原因该是「这轮忍住了」')
  assert.equal(c.skipped, 1, '忍住的次数要记下来')
})

await check('节奏：状态能存能取（重启后间隔不能丢）', () => {
  let at = 1000
  const c = new Cadence({ now: () => at, random: seeded(), minMinutes: 45, maxMinutes: 120 })
  c.markSpoke(at)
  const snap = c.snapshot()
  assert.ok(snap.lastAt === 1000, '上次开口的时刻要存')
  assert.ok(snap.gapMs > 0, '抽到的间隔要存')
  // 换一个实例恢复
  const c2 = new Cadence({ now: () => at, random: seeded(), minMinutes: 45, maxMinutes: 120 })
  c2.restore(snap)
  assert.equal(c2.lastAt, 1000, '恢复后时间要对')
  assert.equal(c2.gapMs, snap.gapMs, '恢复后间隔要对')
  assert.equal(c2.check(at + 1000).ok, false, '恢复后不该立刻又说')
})

await check('节奏：老状态没有间隔也能补上（老配置不许卡死）', () => {
  let at = 1000
  const c = new Cadence({ now: () => at, random: seeded(), minMinutes: 45, maxMinutes: 120 })
  c.restore({ lastAt: 1000 })
  const gate = c.check(at + 1000)
  assert.equal(gate.ok, false, '没有间隔信息时要补抽一个，不能变成「永远能说」')
  assert.ok(c.gapMs > 0, '该把间隔补上')
})

await check('节奏：默认区间落在实测值附近', () => {
  // 实测自发发言间隔中位 89 分钟，参考实现给 60~120。
  assert.ok(DEFAULT_MIN_GAP_MINUTES >= 30 && DEFAULT_MIN_GAP_MINUTES <= 60, '下限该在 30~60 分钟')
  assert.ok(DEFAULT_MAX_GAP_MINUTES >= 90 && DEFAULT_MAX_GAP_MINUTES <= 180, '上限该在 90~180 分钟')
  assert.ok(DEFAULT_SKIP_CHANCE > 0 && DEFAULT_SKIP_CHANCE < 0.6, '忍住的机会不该太大，否则等于关掉主动开口')
})
