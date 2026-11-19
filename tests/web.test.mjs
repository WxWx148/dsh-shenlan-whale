/**
 * 联网读页用例。
 *
 * 只测一件事：**读回来多少**。抓页面本身是 HTTP 客户端的事，用不着在这里重测；
 * 但「一个大到离谱的响应体会不会把进程撑爆」是这一层自己的责任 ——
 * `res.text()` 会先把整个 body 读进内存再切片，切片只决定给模型看多少。
 * 真实触发路径是自动的（掉线自学、热点分享），没有人盯着。
 *
 * 这里起一个本地服务，不碰外网。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readWeb, configureNet, normalizeQuery } from '../ability/index.mjs'

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

await check('搜索词：说“谷歌一下/Google”不会把前缀带进查询', () => {
  assert.equal(normalizeQuery('谷歌一下 曼联 比赛'), '曼联 比赛')
  assert.equal(normalizeQuery('Google 显卡 价格'), '显卡 价格')
})

const CHUNK = 'x'.repeat(64 * 1024)
let written = 0

const server = createServer((req, res) => {
  if (req.url === '/ok') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html><title>小而正常</title><body><p>正文一段</p></body></html>')
    return
  }
  if (req.url === '/declared') {
    // 声明了就大于上限：连读都不该读
    res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(20 * 1024 * 1024) })
    res.end('x'.repeat(20 * 1024 * 1024))
    return
  }
  // 不声明长度、一直往外写：只能靠「边读边数」拦
  res.writeHead(200, { 'content-type': 'text/html' })
  let n = 0
  const tick = () => {
    if (n++ > 2000) return res.end()
    written += CHUNK.length
    if (!res.write(CHUNK)) return res.once('drain', tick)
    setImmediate(tick)
  }
  tick()
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
// 联网闸是全局策略，默认「白名单空＝全不许」。这组用例测的是读页本身，
// 先把本地地址放行，免得被闸挡在门外；闸自己的用例在 live-switches.test.mjs。
configureNet({ net: { allowlist: ['127.0.0.1'], quotaPerHour: 60 } })

await check('正常页面：标题与正文都读得到', async () => {
  const result = await readWeb(`${base}/ok`, 500)
  assert.equal(result.ok, true)
  assert.match(result.title, /小而正常/)
  assert.match(result.text, /正文一段/)
})

await check('声明了超大长度：不读，直接说清多大', async () => {
  const result = await readWeb(`${base}/declared`, 500)
  assert.equal(result.ok, false)
  assert.match(result.error, /页面太大/)
  assert.match(result.error, /20MB/)
})

await check('不声明长度一直写：读到上限就停，不会把进程撑爆', async () => {
  written = 0
  const before = process.memoryUsage().heapUsed
  const result = await readWeb(`${base}/big`, 500)
  assert.equal(result.ok, false, '超大页面应当拒读')
  assert.match(result.error, /超过 8MB/)
  // 关键断言：服务端没被读完。读了 100MB+ 才判「太大」等于没做这件事。
  assert.ok(written < 40 * 1024 * 1024, `服务端写出了 ${Math.round(written / 1048576)}MB，说明没有提前中止`)
  const grown = (process.memoryUsage().heapUsed - before) / 1048576
  assert.ok(grown < 60, `堆涨了 ${Math.round(grown)}MB，上限没生效`)
})

await check('不是 http(s) 的地址：当场拒绝', async () => {
  const result = await readWeb('file:///C:/Windows/win.ini')
  assert.equal(result.ok, false)
  assert.match(result.error, /http/)
})

server.close()

console.log(`\n${failed.length ? '✗' : '✓'} 联网读页用例：${passed} 项通过${failed.length ? `，${failed.length} 项失败` : ''}`)
if (failed.length) process.exit(1)
