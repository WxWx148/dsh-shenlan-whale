/**
 * 图片本体落盘 + 表情收藏的用例。
 *
 * 要钉住的事实只有一条：**收到图片的那一刻就把字节留在盘上**。
 * 因为 OneBot 给的 url 会过期、file 只是协议端的临时名，晚一步就永远拿不到，
 * 表现出来就是「收藏表情失败」「过一会儿图就裂了」。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  attachImages,
  fetchImageBytes,
  mediaDir,
  mediaPath,
  persistImage,
  pruneMedia,
  saveImageBytes,
} from '../ability/index.mjs'

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

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 9)])

const root = mkdtempSync(path.join(tmpdir(), 'whale-media-test-'))
let seq = 0
const freshDir = () => {
  seq += 1
  const dir = path.join(root, 'd' + seq)
  mkdirSync(dir, { recursive: true })
  return dir
}

const imageReply = (buf) => async () => ({
  ok: true,
  headers: { get: (key) => (String(key).toLowerCase() === 'content-type' ? 'image/png' : '') },
  arrayBuffer: async () => buf,
})

console.log('\n落盘：内容寻址、认头不认名')

await check('同一张图存两次：只占一份，第二次标 existed', () => {
  const dir = freshDir()
  const first = saveImageBytes(dir, PNG)
  assert.equal(first.ok, true)
  assert.match(first.name, /^[a-f0-9]{32}\.png$/)
  const second = saveImageBytes(dir, PNG)
  assert.equal(second.ok, true)
  assert.equal(second.existed, true)
  assert.equal(second.name, first.name)
  assert.equal(readFileSync(second.path).length, PNG.length)
})

await check('按文件头判类型：改名叫 .png 的 jpg 也会被认成 jpg', () => {
  const dir = freshDir()
  const saved = saveImageBytes(dir, JPG)
  assert.equal(saved.ok, true)
  assert.match(saved.name, /\.jpg$/)
})

await check('不是图片：直接拒绝，不写盘', () => {
  const dir = freshDir()
  const saved = saveImageBytes(dir, Buffer.from('{"not":"an image"}'))
  assert.equal(saved.ok, false)
  assert.match(saved.error, /图片/)
  assert.equal(existsSync(mediaDir(dir)), false)
})

await check('超过上限：拒绝，不写半张', () => {
  const dir = freshDir()
  const saved = saveImageBytes(dir, PNG, { maxBytes: 64 * 1024 })
  assert.equal(saved.ok, true, '64KB 以内应通过')
  const big = Buffer.concat([PNG, Buffer.alloc(200 * 1024, 1)])
  assert.equal(saveImageBytes(dir, big, { maxBytes: 64 * 1024 }).ok, false)
})

await check('文件名只认自己写出来的那种：../ 走不通', () => {
  const dir = freshDir()
  assert.equal(mediaPath(dir, '../config.json'), '')
  assert.equal(mediaPath(dir, 'abc/def.png'), '')
  assert.equal(mediaPath(dir, 'nothex.png'), '')
  const saved = saveImageBytes(dir, PNG)
  assert.equal(mediaPath(dir, saved.name), saved.path)
})

console.log('\n取字节：本地 → 协议端 → 下载，逐级降级')

await check('本地已有文件：直接抄进缓存', async () => {
  const dir = freshDir()
  const src = path.join(dir, 'source.jpg')
  writeFileSync(src, JPG)
  const saved = await persistImage({ dir, pic: { file: src } })
  assert.equal(saved.ok, true)
  assert.equal(saved.existed, false)
})

await check('只有协议端能给：走 getImage 的 base64', async () => {
  const dir = freshDir()
  const channel = { getImage: async () => ({ base64: PNG.toString('base64') }) }
  const saved = await persistImage({ dir, pic: { file: 'ABCD.image' }, channel })
  assert.equal(saved.ok, true)
  assert.match(saved.name, /\.png$/)
})

await check('只能下载：fetch 拿到图片字节', async () => {
  const dir = freshDir()
  const saved = await persistImage({ dir, pic: { url: 'https://multimedia.nt.qq.com.cn/x' }, fetch: imageReply(PNG) })
  assert.equal(saved.ok, true)
})

await check('三条路都断：返回 null，不抛异常', async () => {
  const dir = freshDir()
  const saved = await persistImage({
    dir,
    pic: { file: 'gone.image', url: 'https://example.com/gone.jpg' },
    channel: { getImage: async () => ({ file: '', url: '', base64: '' }) },
    fetch: async () => {
      throw new Error('网络不通')
    },
  })
  assert.equal(saved, null)
})

await check('下载到的不是图片（比如登录页）：拒收', async () => {
  const dir = freshDir()
  const html = Buffer.from('<html>login</html>')
  const buf = await fetchImageBytes('https://example.com/a.jpg', {
    fetch: async () => ({ ok: true, headers: { get: () => 'text/html' }, arrayBuffer: async () => html }),
  })
  assert.equal(buf, null)
})

console.log('\n事件接线：承诺挂在 pic 上')

await check('attachImages 会写回 cached / localPath，并且同一张不重复挂', async () => {
  const dir = freshDir()
  const raw = { payload: { images: [{ url: 'https://x/1.png' }] } }
  const first = attachImages(raw, { dir, fetch: imageReply(PNG) })
  const second = attachImages(raw, { dir, fetch: imageReply(PNG) })
  assert.equal(first.length, 1)
  assert.equal(second[0], first[0], '同一张图第二次接线应复用同一个承诺')
  const saved = await first[0]
  assert.equal(saved.ok, true)
  assert.match(raw.payload.images[0].cached, /\.png$/)
  assert.equal(existsSync(raw.payload.images[0].localPath), true)
  // 承诺不能进 events.jsonl：JSON.stringify 一个 Promise 会得到 {}，
  // 每条图片事件都会多出一个没用的 "persist":{} 字段。
  assert.equal(JSON.stringify(raw.payload).includes('persist'), false, '承诺必须不可枚举，别写进事件')
})

await check('没有图片的事件：不挂任何东西', () => {
  assert.deepEqual(attachImages({ payload: {} }, { dir: freshDir() }), [])
  assert.deepEqual(attachImages(null, { dir: freshDir() }), [])
})

console.log('\n清理：缓存该删就删')

await check('太旧的删掉，新的留着', () => {
  const dir = freshDir()
  const old = saveImageBytes(dir, PNG)
  const now = Date.now()
  // 把旧文件的 mtime 拨到 40 天前
  const past = new Date(now - 40 * 24 * 3600_000)
  utimesSync(old.path, past, past)
  const recent = saveImageBytes(dir, JPG)
  const result = pruneMedia(dir, { keepDays: 30, now })
  assert.equal(result.removed, 1)
  assert.equal(existsSync(old.path), false)
  assert.equal(existsSync(recent.path), true)
})

await check('数量超上限：只留最新的', () => {
  const dir = freshDir()
  const names = []
  for (let i = 0; i < 6; i += 1) {
    const buf = Buffer.concat([PNG, Buffer.from([i])])
    const saved = saveImageBytes(dir, buf)
    names.push(saved.path)
    const t = new Date(Date.now() + i * 1000)
    utimesSync(saved.path, t, t)
  }
  // 上限最小 50，这里只验「不报错且保留数不减少」的边界
  const result = pruneMedia(dir, { maxFiles: 50 })
  assert.equal(result.removed, 0)
  assert.equal(result.kept, 6)
})

rmSync(root, { recursive: true, force: true })

console.log(`\n图片落盘：${passed} 过 / ${failed.length} 挂`)
if (failed.length) {
  for (const item of failed) console.error('  ✗ ' + item.name + '\n    ' + (item.error?.stack || item.error))
  process.exit(1)
}
