/**
 * 灵魂文件的用例。
 *
 * 重点不是「能不能存文件」，而是四件坏了就出事的事：
 *   1. 核心节不能被一次跑偏的改写清掉 —— 那是失忆，不是自主维护；
 *   2. 每次改写都要留版本，且能原样退回去；
 *   3. 退回之后还能再退回来（退回前那版也得存）；
 *   4. 分节改写不能顺手把别的节弄丢。
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORE_SECTIONS, PersonaBook, matchSection, parseSections, renderSections } from '../mind/index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

let passed = 0
const failed = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed.push({ name, err })
    console.log(`  ✗ ${name}\n    ${err?.message ?? err}`)
  }
}

const DEFAULT = `# 深蓝鲸 · 灵魂文件

名字：深蓝鲸
归属用户：光的无限旅程

## 一、底色

忠诚，认实力不认嘴皮子。

## 二、怎么说话

一条一个念头。

## 四、边界

私事永远是私事。句号。

## 六、连续性（生命线）

读这些文件，更新它们。
`

function newBook(extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'shenlan-persona-'))
  return { dir, book: new PersonaBook({ dir, defaultText: DEFAULT, now: () => 1000, ...extra }) }
}

console.log('\n灵魂文件')

await check('第一次读：没有文件就用出厂人设落盘', async () => {
  const { dir, book } = newBook()
  const text = book.read()
  assert.ok(text.includes('底色'), '要读到出厂人设')
  assert.ok(existsSync(path.join(dir, 'persona.md')), '出厂人设要落盘，否则下次醒来是空的')
  rmSync(dir, { recursive: true, force: true })
})

await check('分节：认得出标题，也认得出带 ## 的写法', async () => {
  const { dir, book } = newBook()
  const sections = book.sections()
  assert.equal(sections.length, 4)
  assert.equal(sections[0].title, '一、底色')
  const found = matchSection(sections, '## 一、底色')
  assert.ok(found, '带 ## 的标题要能对上同一节')
  assert.equal(found.body, '忠诚，认实力不认嘴皮子。')
  rmSync(dir, { recursive: true, force: true })
})

await check('节标题带括号后缀也能对上', async () => {
  const { dir, book } = newBook()
  const sections = book.sections()
  const found = matchSection(sections, '一、底色（核心）')
  assert.ok(found, '模型改写时容易加后缀，得认得出来')
  assert.equal(found.title, '一、底色')
  rmSync(dir, { recursive: true, force: true })
})

await check('改一节：别的节一点没动', async () => {
  const { dir, book } = newBook()
  const result = book.revise({ section: '二、怎么说话', text: '一条一个念头，超过二十字就断下一条。', reason: '主人说的' })
  assert.equal(result.ok, true)
  const sections = book.sections()
  assert.equal(sections.find((s) => s.title === '二、怎么说话').body, '一条一个念头，超过二十字就断下一条。')
  assert.equal(sections.find((s) => s.title === '一、底色').body, '忠诚，认实力不认嘴皮子。', '别的节不能被动')
  assert.equal(sections.find((s) => s.title === '四、边界').body, '私事永远是私事。句号。')
  rmSync(dir, { recursive: true, force: true })
})

await check('核心节不许清空：只能改写', async () => {
  const { dir, book } = newBook()
  const result = book.revise({ section: '四、边界', text: '没了' })
  assert.equal(result.ok, false, '清空核心节必须被拒')
  assert.match(result.error, /核心节/)
  const sections = book.sections()
  assert.equal(sections.find((s) => s.title === '四、边界').body, '私事永远是私事。句号。', '内容必须原样还在')
  rmSync(dir, { recursive: true, force: true })
})

await check('核心节正常改写是允许的', async () => {
  const { dir, book } = newBook()
  const result = book.revise({ section: '一、底色', text: '忠诚，认实力不认嘴皮子。有主见，允许反对。' })
  assert.equal(result.ok, true)
  assert.match(book.read(), /允许反对/)
  rmSync(dir, { recursive: true, force: true })
})

await check('改不存在的节要说清现在有哪些', async () => {
  const { dir, book } = newBook()
  const result = book.revise({ section: '九、没有这一节', text: '内容' })
  assert.equal(result.ok, false)
  assert.match(result.error, /一、底色/, '要告诉它现在有哪些节')
  rmSync(dir, { recursive: true, force: true })
})

await check('空内容与过长内容都要拒', async () => {
  const { dir, book } = newBook()
  assert.equal(book.revise({ section: '二、怎么说话', text: '   ' }).ok, false, '空内容必须被拒')
  assert.equal(book.revise({ section: '二、怎么说话', text: '长'.repeat(5000) }).ok, false, '过长必须被拒')
  rmSync(dir, { recursive: true, force: true })
})

await check('每次改写都留版本，能原样退回去', async () => {
  const { dir, book } = newBook()
  const original = book.read()
  const first = book.revise({ section: '二、怎么说话', text: '第一条规矩' })
  assert.ok(first.version, '要给出版本号')
  book.revise({ section: '二、怎么说话', text: '第二条规矩' })
  assert.ok(book.versions().length >= 2, '两次改写要两个版本')

  const back = book.rollback(first.version)
  assert.equal(back.ok, true)
  assert.equal(book.read(), original, '退回去要跟原来一模一样')
  rmSync(dir, { recursive: true, force: true })
})

await check('退回前那版也存着：退回去还能再退回来', async () => {
  const { dir, book } = newBook()
  const v1 = book.revise({ section: '二、怎么说话', text: '第一条规矩' }).version
  const v2 = book.revise({ section: '二、怎么说话', text: '第二条规矩' }).version
  // 先退到 v1：v1 存的是「第一条规矩」那次改写**之前**的内容，也就是原始出厂人设
  assert.equal(book.rollback(v1).ok, true)
  assert.match(book.read(), /一条一个念头。/, '退到 v1 应该拿回改写前的内容')
  // 再退到 v2：v2 存的是「第二条规矩」那次改写之前的内容 —— 那正是「第一条规矩」
  const again = book.rollback(v2)
  assert.equal(again.ok, true, '退回前那版必须也存着')
  assert.match(book.read(), /第一条规矩/, '能退到中间那一版，不是只能退到最新')
  rmSync(dir, { recursive: true, force: true })
})

await check('退到不存在的版本要说清', async () => {
  const { dir, book } = newBook()
  const result = book.rollback('123')
  assert.equal(result.ok, false)
  assert.match(result.error, /没有这一版/)
  rmSync(dir, { recursive: true, force: true })
})

await check('内容没变就说没改，不白留一个版本', async () => {
  const { dir, book } = newBook()
  const before = book.versions().length
  const result = book.revise({ section: '二、怎么说话', text: '一条一个念头。' })
  assert.equal(result.ok, true)
  assert.equal(result.changed, false)
  assert.equal(book.versions().length, before, '没改就不该多一个版本')
  rmSync(dir, { recursive: true, force: true })
})

await check('抬头（名字/归属）不会被改写弄丢', async () => {
  const { dir, book } = newBook()
  book.revise({ section: '二、怎么说话', text: '新规矩' })
  const text = book.read()
  assert.match(text, /名字：深蓝鲸/)
  assert.match(text, /归属用户：光的无限旅程/)
  rmSync(dir, { recursive: true, force: true })
})

await check('解析与还原来回一遍，内容不丢', async () => {
  const parsed = parseSections(DEFAULT)
  const back = renderSections(parsed)
  for (const title of ['一、底色', '二、怎么说话', '四、边界', '六、连续性（生命线）']) {
    assert.ok(back.includes(title), `「${title}」要还在`)
  }
  assert.match(back, /忠诚，认实力不认嘴皮子。/)
})

await check('核心节清单里的三节都真的在默认人设里', async () => {
  const { dir, book } = newBook()
  const titles = book.sections().map((section) => section.title)
  for (const title of CORE_SECTIONS) {
    assert.ok(titles.includes(title), `默认人设里必须有「${title}」`)
  }
  rmSync(dir, { recursive: true, force: true })
})

await check('沉淀手感：记进「学来的手感」那一节', async () => {
  const { dir, book } = newBook()
  const result = book.absorbHabit('听不懂就扣一个问号')
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  const text = book.read()
  assert.match(text, /七、学来的手感/, '要有那一节')
  assert.match(text, /听不懂就扣一个问号/)
  rmSync(dir, { recursive: true, force: true })
})

await check('沉淀手感：同一句不重复记', async () => {
  const { dir, book } = newBook()
  book.absorbHabit('听不懂就扣一个问号')
  const again = book.absorbHabit('听不懂就扣一个问号')
  assert.equal(again.ok, true)
  assert.equal(again.changed, false, '重复的规矩不该再占地方')
  const count = (book.read().match(/听不懂就扣一个问号/g) || []).length
  assert.equal(count, 1)
  rmSync(dir, { recursive: true, force: true })
})

await check('沉淀手感：那一节满了要拒，不能无限长', async () => {
  const { dir, book } = newBook()
  for (let i = 0; i < 12; i += 1) book.absorbHabit(`第 ${i} 条手感`)
  const overflow = book.absorbHabit('第 13 条手感')
  assert.equal(overflow.ok, false)
  assert.match(overflow.error, /最多/)
  rmSync(dir, { recursive: true, force: true })
})

await check('沉淀手感：不动别的节', async () => {
  const { dir, book } = newBook()
  const before = book.sections().find((s) => s.title === '四、边界').body
  book.absorbHabit('一条新手感')
  assert.equal(book.sections().find((s) => s.title === '四、边界').body, before, '核心节不能被动')
  rmSync(dir, { recursive: true, force: true })
})

await check('出厂人设文件真的在插件里，且分得出节', async () => {
  const file = path.join(HERE, '..', 'lib', 'persona.default.md')
  const raw = readFileSync(file, 'utf8')
  const parsed = parseSections(raw)
  assert.ok(parsed.sections.length >= 6, '出厂人设要分得出节')
  assert.match(raw, /底色/)
  assert.match(raw, /边界/)
  assert.match(raw, /连续性/)
})

await check('出厂人设不和表达规则打架：逗号该写就写，不许凑条数', async () => {
  const file = path.join(HERE, '..', 'lib', 'persona.default.md')
  const raw = readFileSync(file, 'utf8')
  // 这些句子以前在出厂人设里，和 voice/style.mjs 的规矩正面冲突：
  // 人设优先级更高，styleGuide 改对了也会被它们整个抵消。
  for (const stale of ['逗号也少用', '靠换行断气', '断句靠换行', '分两三条发', '一条一个念头']) {
    assert.ok(!raw.includes(stale), `出厂人设里还有「${stale}」`)
  }
  for (const want of ['句内停顿写逗号', '别拿空格代替逗号', '换行只在真换话题时用', '不列清单', '不编号']) {
    assert.ok(raw.includes(want), `出厂人设里少了「${want}」`)
  }
})

await check('出厂人设：主人指令最高优先级，且写在自动进化改不动的核心节', async () => {
  const file = path.join(HERE, '..', 'lib', 'persona.default.md')
  const parsed = parseSections(readFileSync(file, 'utf8'))
  const base = parsed.sections.find((section) => section.title === '一、底色')
  assert.ok(base && base.core, '「一、底色」必须是核心节')
  assert.match(base.body, /【最高优先级】主人的明确指令/, '主人优先级要写进灵魂，不能只靠提示词')
  assert.match(base.body, /只对主人有效，别人不适用/, '不能把主人权限泛化到群里其他人')
})

await check('播种脚本 --force 必须真的强制，不能留旧内容', async () => {
  // 实测踩过：--force 跑完，文件里的内容跟出厂人设对不上（字数也没变）——
  // 因为 PersonaBook.read() 发现文件已存在就直接读它，压根不用 defaultText 覆盖。
  // 「强制了个寂寞」：备份了、打印了「已就位」，实际什么也没换。
  const dir = mkdtempSync(path.join(tmpdir(), 'shenlan-seed-'))
  const file = path.join(dir, 'persona.md')
  writeFileSync(file, '# 旧的\n\n旧内容', 'utf8')
  const out = spawnSync(process.execPath, [path.join(HERE, '..', 'scripts', 'seed-persona.mjs'), '--dir', dir, '--force'], { encoding: 'utf8' })
  assert.equal(out.status, 0, '播种不该失败：' + out.stderr)
  const after = readFileSync(file, 'utf8')
  assert.match(after, /底色/, '必须换成出厂人设')
  assert.doesNotMatch(after, /旧内容/, '旧内容必须被换掉')
  // 覆盖前必须备份
  const backups = readdirSync(dir).filter((name) => name.startsWith('persona.md.bak-'))
  assert.ok(backups.length >= 1, '覆盖前要留备份')
  rmSync(dir, { recursive: true, force: true })
})

await check('播种脚本不覆盖已有文件，除非显式 --force', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shenlan-seed-'))
  const file = path.join(dir, 'persona.md')
  writeFileSync(file, '# 我自己写的\n\n别覆盖我', 'utf8')
  const out = spawnSync(process.execPath, [path.join(HERE, '..', 'scripts', 'seed-persona.mjs'), '--dir', dir], { encoding: 'utf8' })
  assert.equal(out.status, 0)
  assert.match(readFileSync(file, 'utf8'), /别覆盖我/, '默认不许覆盖')
  assert.match(out.stdout, /不覆盖/, '要明说没覆盖')
  rmSync(dir, { recursive: true, force: true })
})

if (failed.length) {
  console.log(`\n✗ 灵魂文件用例：${passed} 项通过，${failed.length} 项失败`)
  for (const row of failed) console.log(`  ${row.name}\n    ${row.err?.message ?? row.err}`)
  process.exit(1)
}
console.log(`\n✓ 灵魂文件用例：${passed} 项通过`)
