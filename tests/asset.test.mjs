/**
 * 资源口用例：名字 → 字节的分派，以及路径穿越的防线只有一处。
 * 用真实临时目录，不 mock fs —— 防护的意义就是「磁盘上真有这个文件也不给读」。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { ASSET_KINDS, assetOf } from '../app/index.mjs'
import { API_BASE, assetUrl, hasRoute } from '../lib/structure.mjs'
import { saveImageBytes } from '../ability/index.mjs'

let passed = 0
const failed = []
async function check(name, fn) {
  try { await fn(); passed += 1; console.log('  ✓ ' + name) }
  catch (error) { failed.push(name); console.error('  ✗ ' + name + '：' + (error && error.message)) }
}

const dir = mkdtempSync(path.join(tmpdir(), 'slj-asset-'))
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const stored = saveImageBytes(dir, PNG)
const qrFile = path.join(dir, 'qrcode.png')
writeFileSync(qrFile, PNG)
// 一个真实存在、但绝对不该被资源口读到的文件
writeFileSync(path.join(dir, 'config.json'), '{"secret":1}')
const ctx = { dir, qrPath: qrFile }

await check('清单就是全部分派：两类资源，不多不少', () => {
  assert.deepEqual(ASSET_KINDS, ['napcat/qr', 'media/*'])
})

await check('二维码：取回登录层给的那份 PNG，且不许缓存', () => {
  const hit = assetOf('napcat/qr', ctx)
  assert.ok(hit)
  assert.ok(hit.bytes.equals(PNG))
  assert.equal(hit.type, 'image/png')
  assert.equal(hit.cache, 'no-store')
})

await check('媒体：按内容寻址的名字取回原字节，可长缓存', () => {
  assert.equal(stored.ok, true)
  const hit = assetOf('media/' + stored.name, ctx)
  assert.ok(hit)
  assert.ok(hit.bytes.equals(PNG))
  assert.equal(hit.type, 'image/png')
  assert.match(hit.cache, /max-age=/)
})

await check('二维码路径没解析出来 / 文件不存在 → null，不猜默认目录', () => {
  assert.equal(assetOf('napcat/qr', { dir }), null)
  assert.equal(assetOf('napcat/qr', { dir, qrPath: path.join(dir, 'nope.png') }), null)
})

await check('../ 读配置被拒：解码前后、斜杠与反斜杠、空字节', () => {
  const attacks = [
    'media/../config.json',
    'media/..%2fconfig.json',
    'media/....//config.json',
    'napcat/../config.json',
    'napcat\\qr',
    'media/abc\u0000.png',
    '../config.json',
    '/asset/media/x',
  ]
  for (const name of attacks) assert.equal(assetOf(name, ctx), null, '不该放行 ' + JSON.stringify(name))
})

await check('不存在的媒体名 / 非法后缀 → null', () => {
  assert.equal(assetOf('media/deadbeef.png', ctx), null)
  assert.equal(assetOf('media/nothex.png', ctx), null)
  assert.equal(assetOf('media/a.svg', ctx), null)
  assert.equal(assetOf('media/', ctx), null)
})

await check('端到端闭环：界面拼的 URL 注册过，且去掉前缀就能喂给分派函数', () => {
  const prefix = API_BASE + '/asset/'
  for (const name of ['napcat/qr', 'media/' + stored.name]) {
    const url = assetUrl(name)
    assert.ok(url.startsWith(prefix), url + ' 该由 assetUrl 拼出来')
    assert.ok(hasRoute(url), url + ' 必须在结构快照里注册过，否则 R4 会漏')
    const hit = assetOf(url.slice(prefix.length), ctx)
    assert.ok(hit, url + ' 分派不到字节')
    assert.equal(hit.type, 'image/png')
  }
})

await check('未知资源名一律 null：不猜最接近的那个', () => {
  for (const name of ['', '/', 'qr', 'napcat/qr/refresh', 'vision/selftest', 'list/groups', 'media/x/../../config.json']) {
    assert.equal(assetOf(name, ctx), null, '不该放行 ' + name)
  }
})

rmSync(dir, { recursive: true, force: true })
console.log(`\n${failed.length ? '✗' : '✓'} 资源口用例：${passed} 项通过${failed.length ? `，${failed.length} 项失败` : ''}`)
if (failed.length) process.exit(1)
