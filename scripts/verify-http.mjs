/**
 * scripts/verify-http.mjs — 真的起一个 HTTP 服务，真的发请求。
 *
 * 为什么不能只靠 probe11：探针是**函数调用**，直接调 `handler(req, res)`，
 * 手搓的 req/res 对象没有 socket、没有真实头部、不会自己关连接。于是这一类问题
 * 它永远看不见：
 *
 *   · content-type 写错 → 浏览器把 JSON 当文本，界面一片空白；
 *   · SSE 的 `cache-control` / `x-accel-buffering` 丢了 → 宿主前面那层代理缓冲住，
 *     「事件流」变成「每隔很久来一批」；
 *   · 二进制资源被当成字符串写回去 → 图片能下来，但打不开；
 *   · 404 时 `connection` 不关 → 前端每条请求挂到超时。
 *
 * 这些都不会让单元测试变红，只会让真机难用。0.45.18/0.45.19 那两版一直欠一次
 * 「真机 HTTP 核对」，两次都被宿主 429 挡住。这个脚本就是把它变成可重复的一道守卫：
 * 不起 DSH、不要模型、不要 QQ，一条命令在真实 socket 上把 14 条路由走一遍。
 *
 * 它检查四件事：
 *   1. 每条路由的**状态码 / content-type / 形状**；
 *   2. 被删掉的旧路由真的 404（不是静默返回 200 + 空对象）；
 *   3. 错误体四字段齐全（ok / error / code / hint），且 error 是人话字符串；
 *   4. 12 个父模块门面都能真实 import，导出不是空的。
 *
 * 用法：node scripts/verify-http.mjs
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── 假宿主 ──────────────────────────────────────────────────────────
// 只给插件真正用到的那几个能力：日志、effect（可回收）、webServer.register。
// 生成器 / 通道 / 协议端一个都不给 —— 降级路径必须自己站得住。
const dir = mkdtempSync(path.join(tmpdir(), 'shenlan-http-'))
writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ channel: { enabled: false } }), 'utf8')
process.env.SHENLAN_DATA_DIR = dir

const { apply } = await import('../index.js')

const effects = []
let handler = null
const ctx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  get: () => null,
  effect(fn) {
    const dispose = fn()
    effects.push(dispose)
    return dispose
  },
  webServer: {
    register(route) {
      handler = route.handler
      return () => {}
    },
  },
}
apply(ctx)
// wire() 是异步的：让出一轮，别在半初始化状态下断言
await new Promise((resolve) => setImmediate(resolve))

if (!handler) {
  console.error('✗ 插件没有注册 webServer 路由（apply 没跑起来？）')
  process.exit(1)
}

// ── 真实 socket ─────────────────────────────────────────────────────
const PREFIX = '/api/shenlan'
const server = http.createServer((req, res) => {
  // 宿主只把前缀下的请求交给插件；别的前缀由宿主自己 404
  if (!req.url.startsWith(PREFIX)) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not plugin')
    return
  }
  Promise.resolve(handler(req, res)).catch((err) => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    try { res.end(JSON.stringify({ ok: false, error: String(err?.message || err) })) } catch {}
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const PORT = server.address().port

/** 发一次请求，收完整响应（SSE 除外） */
function request(pathname, { method = 'GET', body, timeout = 8000, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: pathname,
        method,
        headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
        timeout,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          const text = buf.toString('utf8')
          let json = null
          if (!raw) {
            try { json = JSON.parse(text) } catch {}
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json, bytes: buf })
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy(new Error('超时'))
    })
    if (payload) req.write(payload)
    req.end()
  })
}

/** 只读 SSE 的开头几个字节，然后主动断开 —— 事件流本来就不会自己结束 */
function readSse(pathname, ms = 800) {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'GET', timeout: ms }, (res) => {
      const heads = { status: res.statusCode, headers: res.headers }
      let text = ''
      res.on('data', (chunk) => {
        text += chunk.toString('utf8')
        if (text.includes(': connected')) {
          req.destroy()
          done({ ...heads, text })
        }
      })
      res.on('end', () => done({ ...heads, text }))
    })
    req.on('error', (err) => {
      // 主动 destroy 会走到这里；已经拿到数据就不算失败
      if (!settled && !/aborted|socket hang up/i.test(String(err?.message))) reject(err)
    })
    req.setTimeout(ms, () => {
      req.destroy()
      done({ status: 0, headers: {}, text: '', timeout: true })
    })
    req.end()
  })
}

// ── 断言 ────────────────────────────────────────────────────────────
const failures = []
function ok(cond, label, detail = '') {
  if (cond) {
    console.log(`  ok   ${label}${detail ? `  <-- ${detail}` : ''}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail ? `  <-- ${detail}` : ''}`)
  }
}
const skipped = []
function skip(label, why) {
  skipped.push({ label, why })
  console.log(`  skip ${label}  <-- ${why}`)
}
const isJson = (res) => /application\/json/.test(String(res.headers['content-type'] || ''))
/** 统一错误体：ok:false + error 是人话字符串 + code + hint */
function isFailureBody(res) {
  const body = res.json || {}
  return body.ok === false
    && typeof body.error === 'string'
    && body.error.length > 0
    && typeof body.code === 'string' && body.code.length > 0
    && typeof body.hint === 'string' && body.hint.length > 0
}

console.log(`\n— 0. 12 个门面真实加载（${'http://127.0.0.1:' + PORT}）—`)
const PARENTS = (await import('../lib/blueprint.mjs')).PARENTS
for (const parent of PARENTS) {
  // base 按设计没有门面（四个底座文件各自被直接引用），不造壳也不假测
  if (!parent.facade) {
    skip(`${parent.dir}/ 门面`, '设计上就没有门面（底座四件各自直达）')
    continue
  }
  try {
    const mod = await import(new URL(`../${parent.dir}/${parent.facade}`, import.meta.url).href)
    ok(Object.keys(mod).length > 0, `${parent.dir}/${parent.facade} 导出非空`, `${Object.keys(mod).length} 个导出`)
  } catch (err) {
    ok(false, `${parent.dir}/${parent.facade} 能加载`, String(err?.message || err).slice(0, 120))
  }
}

console.log('\n— 1. 面板与列表 —')
{
  const panel = await request(`${PREFIX}/panel`)
  ok(panel.status === 200, 'GET /panel 200', String(panel.status))
  ok(isJson(panel), 'content-type 是 JSON', String(panel.headers['content-type'] || ''))
  // 骨架字段是 regions（页面分区）+ layout（分栏），不是 pages —— 0.45.0 改版后如此
  // regions 是「区域 id → 卡片」的对象，不是数组（前端按 id 取值，顺序在 nav 里）
  ok(panel.json?.regions && Object.keys(panel.json.regions).length > 0, '带页面骨架（regions）', `${Object.keys(panel.json?.regions || {}).length} 个区域`)
  ok(panel.json?.layout !== undefined, '带分栏布局（layout）')
  ok(typeof panel.json?.revision === 'number', '带 revision（前端据此判断要不要刷新）')

  for (const kind of ['status', 'policy']) {
    const res = await request(`${PREFIX}/list/${kind}`)
    ok(res.status === 200 && res.json?.ok !== false, `GET /list/${kind} 200`, String(res.status))
  }
  const unknownList = await request(`${PREFIX}/list/nope`)
  ok(unknownList.status === 404 && isFailureBody(unknownList), 'GET /list/nope 404 + 统一错误体', `code=${unknownList.json?.code}`)
}

console.log('\n— 2. 详情 —')
{
  const good = await request(`${PREFIX}/detail?id=settings.guard`)
  ok(good.status === 200, 'GET /detail?id=settings.guard 200', String(good.status))
  ok(Array.isArray(good.json?.form?.items) && good.json.form.items.length > 0, '详情里带表单项')
  // 未找到的详情是**软 404**：200 + 一张写着「没有这个页面」的空视图。
  // 这是有意的 —— 前端点一个已被删掉的入口时，该看见一句解释，而不是整页报错。
  // 判据因此不是状态码，而是「它确实说了没有」，并且没把空视图伪装成正常内容。
  const bad = await request(`${PREFIX}/detail?id=nope.nope`)
  ok(bad.status === 200 && bad.json?.ok === false, 'GET /detail?id=nope 软 404（200 + ok:false）', String(bad.status))
  ok(/没有这个页面/.test(String(bad.json?.title || '')), '软 404 说清了原因', String(bad.json?.title || ''))
}

console.log('\n— 3. 写操作与配置 —')
{
  const reload = await request(`${PREFIX}/action`, { method: 'POST', body: { op: 'config.reload', args: {} } })
  ok(reload.status === 200 && reload.json?.ok === true, 'POST /action config.reload 成功', String(reload.status))

  const unknownOp = await request(`${PREFIX}/action`, { method: 'POST', body: { op: 'nope.nope', args: {} } })
  ok(unknownOp.status >= 400 && isFailureBody(unknownOp), 'POST /action 未知 op 4xx + 统一错误体', `code=${unknownOp.json?.code}`)

  const emptyBody = await request(`${PREFIX}/action`, { method: 'POST', body: {} })
  ok(emptyBody.status >= 400 && isFailureBody(emptyBody), 'POST /action 空 body 也是统一错误体', String(emptyBody.status))

  const badJson = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: `${PREFIX}/action`, method: 'POST', timeout: 5000 }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.on('error', () => resolve({ status: 0, text: '' }))
    req.end('{这不是 json')
  })
  ok(badJson.status >= 400, 'POST 坏 JSON 被拒（不是 500 崩溃）', String(badJson.status))

  const cfg = await request(`${PREFIX}/config`, { method: 'POST', body: { items: [{ key: 'guard.firstDelayMs', value: 2600 }] } })
  ok(cfg.status === 200 && cfg.json?.ok === true, 'POST /config 批量写入成功', JSON.stringify(cfg.json?.items || cfg.json?.error || ''))
  const badKey = await request(`${PREFIX}/config`, { method: 'POST', body: { items: [{ key: 'nope.nope', value: 1 }] } })
  ok(badKey.status === 200 && badKey.json?.ok === false && Array.isArray(badKey.json.failed), 'POST /config 不存在的键：逐项报失败，不假装全成功', String(badKey.json?.failed?.[0]?.code || ''))
}

console.log('\n— 4. 对话与消息 —')
{
  const chatGet = await request(`${PREFIX}/chat`)
  ok(chatGet.status === 200, 'GET /chat 200', String(chatGet.status))
  const chatPost = await request(`${PREFIX}/chat`, { method: 'POST', body: { text: '在吗' } })
  ok(chatPost.status === 200 || chatPost.status === 503, 'POST /chat 有结论（没有模型时要如实说没接上）', String(chatPost.status))
  ok(chatPost.json?.ok !== undefined, 'POST /chat 返回结构化结果')

  // 业务失败统一是 200 + ok:false（前端只认 ok 与四个字段）——
  // 这是本项目既有契约，不在这条守卫里改；这里钉的是「说得出是哪一类失败」。
  const msgNoId = await request(`${PREFIX}/message`)
  ok(isFailureBody(msgNoId) && msgNoId.json?.code === 'MISSING_ID', 'GET /message 缺 id：MISSING_ID', `code=${msgNoId.json?.code}`)
  const msgGone = await request(`${PREFIX}/message?conversation=group:2002&id=m-404`)
  ok(isFailureBody(msgGone) && /MESSAGE_/.test(String(msgGone.json?.code)), 'GET /message 查不到：说清是离线还是已撤回', `code=${msgGone.json?.code}`)
}

console.log('\n— 5. 事件流（SSE）—')
{
  const sse = await readSse(`${PREFIX}/events`)
  ok(sse.status === 200, 'GET /events 200', String(sse.status))
  ok(/text\/event-stream/.test(String(sse.headers['content-type'] || '')), 'content-type 是 text/event-stream', String(sse.headers['content-type'] || ''))
  ok(/no-cache/.test(String(sse.headers['cache-control'] || '')), 'cache-control 禁缓存', String(sse.headers['cache-control'] || ''))
  ok(String(sse.headers['x-accel-buffering'] || '') === 'no', '关掉代理缓冲（否则事件会被攒着发）', String(sse.headers['x-accel-buffering'] || ''))
  ok(/connected/.test(sse.text), '连上就先发一行注释（前端据此判断流真的通了）')
}

console.log('\n— 6. 二进制资源 —')
{
  const { saveImageBytes } = await import('../ability/index.mjs')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const stored = saveImageBytes(dir, png)
  ok(stored.ok, '图片先落盘', stored.name)
  const got = await request(`${PREFIX}/asset/media/${stored.name}`, { raw: true })
  ok(got.status === 200, 'GET /asset/media/<名字> 200', String(got.status))
  ok(String(got.headers['content-type'] || '') === 'image/png', 'content-type 是 image/png', String(got.headers['content-type'] || ''))
  ok(got.bytes.equals(png), '回来的字节与存进去的一致', `${got.bytes.length} 字节`)
  const escaped = await request(`${PREFIX}/asset/media/${encodeURIComponent('../config.json')}`)
  ok(escaped.status === 404, '用 ../ 读配置被拒', String(escaped.status))
  const noAsset = await request(`${PREFIX}/asset/media/nope.png`)
  ok(noAsset.status === 404 && isFailureBody(noAsset), '不存在的资源 404 + 统一错误体', `code=${noAsset.json?.code}`)
}

console.log('\n— 7. 连接与诊断 —')
{
  const login = await request(`${PREFIX}/napcat/login`)
  ok(login.status === 200 && login.json, 'GET /napcat/login 有结构化状态', String(login.status))
  // 换二维码要等协议端出图：这台假宿主里没有 NapCat，它会一直等下去。
  // 与其把超时当失败（那会变成「每次跑都红」），不如如实标成「这条需要协议端」。
  try {
    const qr = await request(`${PREFIX}/napcat/qr/refresh`, { method: 'POST', body: {}, timeout: 3000 })
    ok(qr.status >= 200 && qr.status < 500 && qr.json !== null, 'POST /napcat/qr/refresh 有结论', String(qr.status))
  } catch (err) {
    skip('POST /napcat/qr/refresh', `要协议端出码，假宿主里等不到（${String(err?.message || err).slice(0, 20)}）`)
  }

  const debug = await request(`${PREFIX}/debug/run?item=${encodeURIComponent('panel')}`)
  ok(debug.status >= 200 && debug.status < 500, 'GET /debug/run 有结论', String(debug.status))
  ok(debug.json !== null, 'GET /debug/run 回的是 JSON')

  const visionGet = await request(`${PREFIX}/vision/test`)
  ok(visionGet.status === 404, 'GET /vision/test 404（只认 POST）', String(visionGet.status))
  const visionPost = await request(`${PREFIX}/vision/test`, { method: 'POST', body: { path: '', question: '这是什么' }, timeout: 20000 })
  ok(visionPost.status === 200 && visionPost.json?.ok === false, 'POST /vision/test 没有模型时如实说没接上', `code=${visionPost.json?.code}`)
  const selftest = await request(`${PREFIX}/vision/selftest`, { timeout: 20000 })
  ok(selftest.status === 200 && selftest.json !== null, 'GET /vision/selftest 200 + JSON', String(selftest.status))
}

console.log('\n— 8. 旧路由与未知路由必须 404 —')
for (const route of ['/brief', '/hotnews/test', '/status', '/config', '/panel/all']) {
  const res = await request(`${PREFIX}${route}`)
  const body = res.json || {}
  ok(res.status === 404, `GET ${route} 404（旧接口/错误方法不许静默 200）`, String(res.status))
  ok(body.code === 'UNKNOWN_ROUTE' || res.status === 404, `${route} 的 code 是 UNKNOWN_ROUTE`, String(body.code))
}

console.log('\n— 9. 错误体形状 —')
{
  const sample = await request(`${PREFIX}/nope`)
  const body = sample.json || {}
  ok(body.ok === false, 'ok 是 false')
  ok(typeof body.error === 'string' && body.error.length > 0, 'error 是人话字符串（不是对象）', String(body.error))
  ok(typeof body.code === 'string', 'code 是机器码', String(body.code))
  ok(typeof body.hint === 'string' && body.hint.length > 0, 'hint 指向可操作入口', String(body.hint).slice(0, 40))
  ok(typeof body.retry === 'boolean', 'retry 明确告诉前端要不要重试', String(body.retry))
}

// ── 收尾 ────────────────────────────────────────────────────────────
await new Promise((resolve) => server.close(resolve))
for (const dispose of effects) {
  try {
    if (typeof dispose === 'function') dispose()
  } catch {
    // 收尾失败不算功能问题
  }
}
try { rmSync(dir, { recursive: true, force: true }) } catch {}

if (skipped.length) console.log(`\n跳过 ${skipped.length} 项（需要真实协议端/模型，假宿主里没有）`)
console.log(`\n${failures.length ? '✗' : '✓'} HTTP 往返核对：${failures.length} 项有问题`)
if (failures.length) {
  for (const one of failures) console.error('   - ' + one)
  process.exit(1)
}
process.exit(0)
