/**
 * 入口用例。
 *
 * 存在的理由是一次真实的坑：把一行 `const napcat = new NapCatLogin(...)`
 * 接到了上一行注释的末尾 —— 于是它整行变成了注释，`node --check` 照样通过
 * （语法没错），`npm test` 照样全绿（没有用例加载入口），
 * 但桌面端一启动就抛 ReferenceError，应用直接起不来。
 *
 * 两条断言都便宜，但只有它们能抓住这一类「语法没错、代码没了」。
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

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

const ROOT = new URL('..', import.meta.url)
const files = ['index.js', ...readdirSync(new URL('lib', ROOT)).filter((name) => name.endsWith('.mjs')).map((name) => `lib/${name}`)]

await check('入口能被真的加载，不只是语法对', async () => {
  const mod = await import('../index.js')
  assert.equal(typeof mod.apply, 'function', '没有 apply：宿主装了也不会启动')
  assert.ok(Array.isArray(mod.inject) && mod.inject.length, 'inject 要是宿主认识的服务名列表')
  assert.ok(mod.name, '没有 name：宿主认不出这是哪个插件')
})

await check('没有代码被行尾注释吞掉（真实踩过：const 接在 // 后面）', () => {
  // 只认「注释里还写着一条声明 / 赋值」这种形状：
  //   // ......  const x = new Foo(...)
  // 正常的注释里不会出现 `const x =`，所以误报极少；
  // 一旦出现，几乎一定是被拼接坏掉的真代码。
  const re = /\b(const|let|var|function|await|return)\s+[A-Za-z_$][\w$]*\s*[=(]/
  const bad = []
  for (const rel of files) {
    const lines = readFileSync(new URL(rel, ROOT), 'utf8').split('\n')
    lines.forEach((line, index) => {
      const at = line.indexOf('//')
      if (at < 0) return
      if (re.test(line.slice(at))) bad.push(`${rel}:${index + 1}`)
    })
  }
  assert.deepEqual(bad, [], '这些行有代码被注释吞掉了：' + bad.join('、'))
})

console.log(`\n${failed.length ? '✗' : '✓'} 入口用例：${passed} 项通过${failed.length ? `，${failed.length} 项失败` : ''}`)
if (failed.length) process.exit(1)
