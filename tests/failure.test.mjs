/**
 * 错误体用例：形状、登记表、hint 的真实性、未知码不吞。
 *
 * 最重要的一条是「error 永远是字符串」——界面 30+ 处直接把它当话说，
 * 变成对象的那天不会有任何地方报错，只是那些话全变成 [object Object]。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FAILURES, FAILURE_CODES, failure, failureFrom, normalizeFailure } from '../app/index.mjs'

let passed = 0
const failed = []
function check(name, fn) {
  try { fn(); passed += 1; console.log('  ✓ ' + name) }
  catch (error) { failed.push(name); console.error('  ✗ ' + name + '：' + (error && error.message)) }
}

check('每个登记的错误码都有中文说明与有效 hint', () => {
  assert.ok(FAILURE_CODES.length >= 15)
  for (const code of FAILURE_CODES) {
    const spec = FAILURES[code]
    assert.ok(spec.message && /[一-龥]/.test(spec.message), code + ' 缺中文说明')
    assert.ok(spec.hint && /[一-龥]/.test(spec.hint), code + ' 缺 hint')
    assert.ok(!/^(请重试|稍后再试|请检查后重试)$/.test(spec.hint), code + ' hint 是正确的废话')
    assert.ok(typeof spec.retry === 'boolean', code + ' 缺 retry')
  }
})

check('hint 必须指向真实入口，或如实说没有入口', () => {
  // 真实入口：七个页面名、具体按钮、输入框、或「重启宿主」这个真实动作。
  const realEntry = /「(总览|对话|心智|能力|连接|设置|诊断)」|页面|输入框|点「|输入框|重启 DeepSeek Harness|没有可操作入口|设置」页 →/
  for (const code of FAILURE_CODES) {
    assert.match(FAILURES[code].hint, realEntry, code + ' 的 hint 没指向任何真实入口：' + FAILURES[code].hint)
  }
})

check('形状固定：ok:false / error 字符串 / code / hint / retry', () => {
  const one = failure('EMPTY_TEXT')
  assert.equal(one.ok, false)
  assert.equal(typeof one.error, 'string')
  assert.equal(one.error, '空消息不发')
  assert.equal(one.code, 'EMPTY_TEXT')
  assert.match(one.hint, /输入框/)
  assert.equal(one.field, 'text')
  assert.equal(one.retry, false)
})

check('detail 拼在具体说明后面，不覆盖中文原话', () => {
  const one = failure('UNKNOWN_OP', { detail: 'foo.bar' })
  assert.equal(one.error, '没有这个操作：foo.bar')
  assert.equal(one.field, 'op')
})

check('field / retry 可覆盖；未登记字段原样带上', () => {
  const one = failure('CONFIG_FAILED', { field: 'tools.maxRounds', retry: false, key: 'tools.maxRounds' })
  assert.equal(one.field, 'tools.maxRounds')
  assert.equal(one.retry, false)
  assert.equal(one.key, 'tools.maxRounds')
})

check('未知码降级到 INTERNAL，但把原码留下来', () => {
  const one = failure('SOMETHING_NEW')
  assert.equal(one.code, 'INTERNAL')
  assert.equal(one.unknownCode, 'SOMETHING_NEW')
  assert.equal(one.ok, false)
  assert.match(one.hint, /诊断/)
})

check('failureFrom 保留原始报错文字', () => {
  const one = failureFrom(new Error('磁盘满了'), 'SEND_FAILED')
  assert.equal(one.error, '磁盘满了')
  assert.equal(one.code, 'SEND_FAILED')
  assert.equal(one.ok, false)
  assert.equal(typeof one.error, 'string')
})

check('所有错误体的 error 都必须是字符串（界面 30+ 处按字符串读）', () => {
  for (const code of FAILURE_CODES) {
    assert.equal(typeof failure(code).error, 'string', code)
  }
  assert.equal(typeof failureFrom(null).error, 'string')
})

check('normalizeFailure：业务模块透传的 ok:false 补齐字段，原文与业务数据不动', () => {
  const raw = { ok: false, error: '这一项值不合法', items: ['a'], count: 2 }
  const one = normalizeFailure(raw)
  assert.equal(one.ok, false)
  assert.equal(one.error, '这一项值不合法')
  assert.equal(one.code, 'BUSINESS_FAILED')
  assert.match(one.hint, /设置|诊断/)
  assert.equal(one.retry, true)
  assert.deepEqual(one.items, ['a'])
  assert.equal(one.count, 2)
  // 不能就地改调用方的对象：sendJson 还要往上加 revision，语义上它是新值
  assert.equal(raw.code, undefined)
})

check('normalizeFailure：显式错误体优先，不被通用码覆盖', () => {
  const one = normalizeFailure(failure('EMPTY_TEXT'))
  assert.equal(one.code, 'EMPTY_TEXT')
  assert.equal(one.field, 'text')
  assert.equal(one.retry, false)
})

check('normalizeFailure：不误伤成功响应、自检结果与数组', () => {
  assert.deepEqual(normalizeFailure({ ok: true, rows: [1] }), { ok: true, rows: [1] })
  // /vision/selftest 的 ok:false 是「检查结果」不是错误，界面要逐条显示 checks
  const selftest = { ok: false, checks: [{ name: '模型', ok: false }], sampleText: '' }
  assert.deepEqual(normalizeFailure(selftest), selftest)
  assert.deepEqual(normalizeFailure([1, 2]), [1, 2])
  assert.equal(normalizeFailure(null), null)
  assert.equal(normalizeFailure('文字'), '文字')
})

check('BUSINESS_FAILED 也在登记表里，hint 指向真实入口', () => {
  assert.ok(FAILURE_CODES.includes('BUSINESS_FAILED'))
  assert.match(FAILURES.BUSINESS_FAILED.hint, /设置|诊断/)
})

// 从浏览器包里把真实函数体抠出来跑一遍：readableError 藏在模块闭包里，
// 不能 import，复制一份到用例里又等于「测的是抄过来的代码」。
const clientSrc = readFileSync(new URL('../lib/client.panel.js', import.meta.url), 'utf8')
function readableErrorFromSource() {
  const start = clientSrc.indexOf('function readableError(body, fallback) {')
  assert.ok(start >= 0, '前端没有 readableError')
  // 花括号配平截出整个函数，别依赖缩进或行数
  let depth = 0
  let end = -1
  for (let i = clientSrc.indexOf('{', start); i < clientSrc.length; i += 1) {
    if (clientSrc[i] === '{') depth += 1
    else if (clientSrc[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break } }
  }
  assert.ok(end > start, 'readableError 函数体没截全')
  return clientSrc.slice(start, end)
}
const readableError = new Function(readableErrorFromSource() + '\nreturn readableError')()

check('端到端：宿主给的错误体，用户看到的是「出了什么事 · 去哪改」', () => {
  const body = failure('EMPTY_TEXT')
  assert.equal(body.error, '空消息不发')
  assert.equal(readableError(body), '空消息不发 · 在输入框里写点内容再点「发送」')
  // error 保持字符串，30+ 处 say(result.error) 不会因为多出字段而打歪
  assert.equal(typeof body.error, 'string')
})

check('readableError 不重复拼 hint，且能兜住旧格式字符串错误', () => {
  const once = readableError({ error: '空消息不发 · 在输入框里写点内容再点「发送」', hint: '在输入框里写点内容再点「发送」' })
  assert.equal(once, '空消息不发 · 在输入框里写点内容再点「发送」')
  assert.equal(readableError({ error: '老版本只给一句话' }), '老版本只给一句话')
  assert.equal(readableError(null, '宿主返回 500'), '宿主返回 500')
})

check('业务透传的 ok:false 经过归一后，前端也能显示 hint', () => {
  const raw = { ok: false, error: '这一项值不合法', items: ['a'] }
  const normalized = normalizeFailure(raw)
  assert.match(readableError(normalized), /这一项值不合法/)
  assert.match(readableError(normalized), /「设置」|「诊断」/)
  // 原字段不能丢：批量保存要靠 items / failed 判断哪些没成
  assert.deepEqual(normalized.items, ['a'])
})

// sendJson 是所有响应的必经之路，这一刀改了它。宿主 429 下没有真机 HTTP，
// 就把真实函数体抠出来配一个假 res 跑一遍：测的是会发出去的那些字节。
const indexSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
function httpBoundary() {
  const start = indexSrc.indexOf('function sendJson(res, status, value) {')
  assert.ok(start >= 0, 'index.js 里找不到 sendJson')
  let depth = 0
  let end = -1
  for (let i = indexSrc.indexOf('{', start); i < indexSrc.length; i += 1) {
    if (indexSrc[i] === '{') depth += 1
    else if (indexSrc[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break } }
  }
  assert.ok(end > start, 'sendJson 函数体没截全')
  return new Function('normalizeFailure', 'revisionOf', indexSrc.slice(start, end) + '\nreturn sendJson')(
    normalizeFailure, () => 42,
  )
}
const sendJson = httpBoundary()
function send(value, status = 200) {
  let head = null
  let raw = ''
  sendJson({ writeHead: (code, headers) => { head = { code, headers } }, end: (text) => { raw = text } }, status, value)
  return { head, body: JSON.parse(raw) }
}

check('HTTP 边界：成功响应只多一个 revision，其余原样', () => {
  const hit = send({ ok: true, nav: ['a', 'b'], regions: {} })
  assert.equal(hit.head.code, 200)
  assert.equal(hit.head.headers['content-type'], 'application/json; charset=utf-8')
  assert.deepEqual(hit.body.nav, ['a', 'b'])
  assert.equal(hit.body.revision, 42)
  assert.equal(hit.body.code, undefined)
})

check('HTTP 边界：业务透传的 ok:false 补齐字段且业务数据一个不少', () => {
  const hit = send({ ok: false, error: '这一项值不合法', items: ['a'], failed: [{ key: 'x' }] }, 200)
  assert.equal(hit.body.code, 'BUSINESS_FAILED')
  assert.equal(hit.body.error, '这一项值不合法')
  assert.match(hit.body.hint, /设置|诊断/)
  assert.deepEqual(hit.body.items, ['a'])
  assert.deepEqual(hit.body.failed, [{ key: 'x' }])
  assert.equal(hit.body.revision, 42)
})

check('HTTP 边界：显式错误体不被覆盖，error 仍是字符串', () => {
  const hit = send(failure('UNKNOWN_OP', { detail: 'foo' }), 404)
  assert.equal(hit.head.code, 404)
  assert.equal(hit.body.code, 'UNKNOWN_OP')
  assert.equal(hit.body.error, '没有这个操作：foo')
  assert.equal(typeof hit.body.error, 'string')
  assert.match(hit.body.hint, /重启/)
})

check('HTTP 边界：自检结果、数组、已有 revision 的响应都不被改写', () => {
  const selftest = send({ ok: false, checks: [{ name: '模型', ok: false }] })
  assert.equal(selftest.body.code, undefined)
  assert.deepEqual(selftest.body.checks, [{ name: '模型', ok: false }])
  assert.deepEqual(send([1, 2]).body, [1, 2])
  assert.equal(send({ ok: true, revision: 7 }).body.revision, 7)
})

check('HTTP 边界 → 前端：404 错误最终显示的是「出了什么事 · 去哪改」', () => {
  const hit = send(failure('MISSING_ID'), 400)
  assert.equal(readableError(hit.body), '没说要看哪一条（缺 id） · 从消息列表点「查看原文」，不要手工拼地址')
})

console.log(`\n${failed.length ? '✗' : '✓'} 错误体用例：${passed} 项通过${failed.length ? `，${failed.length} 项失败` : ''}`)
if (failed.length) process.exit(1)
