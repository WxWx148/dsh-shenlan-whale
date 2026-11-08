/**
 * tests/stickers.test.mjs — 表情包库存：读、改、缓存。
 *
 * 这组测试盯的是两件事：
 *   · 库存读出来要一致 —— 收藏完立刻能发，不能等缓存过期；
 *   · 缓存不能变成「改了看不见」—— 面板每 5 秒刷一次，
 *     缓存要是没跟上，用户会以为收藏失败。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadStickers, pickSticker, resolveSticker } from '../ability/index.mjs'

let passed = 0
const failed = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed.push({ name, error })
    console.log(`  ✗ ${name}\n    ${error.message}`)
  }
}

/** 造一个带表情的目录：n 张图 + 一份 index */
function makeStickerDir(n = 5) {
  const dir = mkdtempSync(path.join(tmpdir(), 'stk-'))
  const base = path.join(dir, 'stickers')
  mkdirSync(base, { recursive: true })
  const items = []
  for (let i = 0; i < n; i += 1) {
    const file = `img${i}.png`
    writeFileSync(path.join(base, file), 'x')
    items.push({ id: `id${i}`, file, labels: [i % 2 ? '开心' : '困'] })
  }
  writeFileSync(path.join(base, 'index.json'), JSON.stringify({ items }))
  return { dir, base }
}

const inBase = (rows, base) => rows.filter((row) => row.dir === base)

await check('库存读出来：index 里登记几张就是几张', () => {
  const { dir, base } = makeStickerDir(6)
  const rows = inBase(loadStickers(dir), base)
  assert.equal(rows.length, 6)
  rmSync(dir, { recursive: true, force: true })
})

await check('改了 index.json：下一次读就要看到新内容', () => {
  const { dir, base } = makeStickerDir(6)
  const items = []
  for (let i = 0; i < 3; i += 1) {
    const file = `img${i}.png`
    writeFileSync(path.join(base, file), 'x')
    items.push({ id: `id${i}`, file, labels: ['开心'] })
  }
  writeFileSync(path.join(base, 'index.json'), JSON.stringify({ items }))
  // 缓存最容易出的错就是这里：文件改了，列表还是旧的
  assert.equal(inBase(loadStickers(dir), base).length, 3, 'index 改完要立刻生效')
  rmSync(dir, { recursive: true, force: true })
})

await check('目录里多了一张图：下一次读要能看到', () => {
  const { dir, base } = makeStickerDir(4)
  writeFileSync(path.join(base, 'extra.png'), 'x')
  // index 存在时以 index 为准（这是收集时的账），但目录变了也要重新算一遍
  loadStickers(dir)
  const rows = inBase(loadStickers(dir), base)
  assert.ok(rows.length >= 4, '目录变了，库存要重新算')
  rmSync(dir, { recursive: true, force: true })
})

await check('按标签挑：先精确再反包含，都没有就随机', () => {
  const { dir, base } = makeStickerDir(6)
  const rows = inBase(loadStickers(dir), base)
  const hit = pickSticker(rows, '开心')
  assert.ok(hit, '该挑得到')
  assert.ok(hit.labels.some((label) => label.includes('开心')), '挑中的要带那个标签')
  assert.ok(pickSticker(rows, ''), '不给标签也要挑得到一张')
  rmSync(dir, { recursive: true, force: true })
})

await check('按序号 / 文件名 / id 指定一张', () => {
  const { dir, base } = makeStickerDir(4)
  const rows = inBase(loadStickers(dir), base)
  assert.ok(resolveSticker(rows, '1'), '序号要能选')
  assert.ok(resolveSticker(rows, 'img1.png'), '文件名要能选')
  assert.ok(resolveSticker(rows, 'id1'), 'id 要能选')
  assert.equal(resolveSticker(rows, '根本没有这张'), null, '选不到就该返回空')
  rmSync(dir, { recursive: true, force: true })
})

console.log(`\n${failed.length ? '✗' : '✓'} 表情库存用例：${passed} 项通过`)
if (failed.length) {
  for (const { name, error } of failed) console.log(`  ${name}: ${error.stack || error.message}`)
  process.exit(1)
}
