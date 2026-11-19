/**
 * 人话层的离线用例：不打网络、不碰磁盘、不启动任何东西。
 */

import assert from 'node:assert/strict'
import {
  card,
  render,
  forQq,
  askCard,
  askText,
  explainError,
  fmtMs,
  artifactNote,
} from '../voice/index.mjs'

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

console.log('\n人话层')

await check('成功：一句话说清做了什么，不含代码', () => {
  const view = card({
    label: '把最近 7 天的消息做成柱状图',
    plan: ['翻出 7 天记录', '按天计数', '画图'],
    ms: 820,
    artifact: { kind: 'image', title: '近 7 天消息量', bytes: 42_000 },
    facts: ['语言：Node', '源码 38 行'],
    code: 'const a=1',
  })
  assert.equal(view.ok, true)
  assert.match(view.line, /^做好了：把最近 7 天的消息做成柱状图 · 0\.8 秒/)
  assert.match(view.line, /一张图：近 7 天消息量（41 KB）/)
  assert.ok(!view.line.includes('const'), '一句话里不该出现代码')
})

await check('失败：错误翻译成人话，带原因与下一步', () => {
  const view = card({ label: '读你的聊天记录', error: new Error('ENOENT: no such file or directory') })
  assert.equal(view.ok, false)
  assert.equal(view.line, '没做成：文件不存在')
  assert.match(view.why, /路径找不到/)
  assert.match(view.hint, /确认一下文件名/)
  assert.ok(!view.line.includes('ENOENT'), '不该把错误码丢给用户')
})

await check('故障翻译：超时 / 内存 / 闸门 / 权限 / 断网 各归各位', () => {
  assert.equal(explainError('ETIMEDOUT').title, '超时了')
  assert.equal(explainError('JavaScript heap out of memory').title, '内存不够')
  assert.equal(explainError('SANDBOX_DENY: child_process').title, '被安全闸门拦住了')
  assert.equal(explainError('EACCES: permission denied').title, '被沙箱挡住了')
  assert.equal(explainError('getaddrinfo ENOTFOUND example.com').title, '连不上网')
  assert.equal(explainError('完全没见过的错').title, '没做成')
})

await check('分级：默认层没有代码，源码层才有', () => {
  const view = card({ label: '跑个脚本', ms: 500, facts: ['语言：Python'], code: 'print(1)' })
  const base = render(view)
  assert.ok(!base.includes('print(1)'), '默认层不能出现源码')
  assert.ok(!base.includes('语言：Python'), '默认层不带细节')
  const detail = render(view, 'detail')
  assert.match(detail, /语言：Python/)
  assert.ok(!detail.includes('print(1)'), '细节层仍然不给源码')
  const source = render(view, 'source')
  assert.match(source, /print\(1\)/)
})

await check('QQ：只发一句话，代码/细节/链接都不带', () => {
  const view = card({ label: '跑个脚本', ms: 500, facts: ['语言：Python'], code: 'print(1)' })
  const text = forQq(view)
  assert.equal(text, '做好了：跑个脚本 · 0.5 秒')
  assert.ok(!text.includes('print'))
  assert.ok(!text.includes('语言'))

  const withArtifact = forQq(
    card({ label: '画张图', ms: 900, artifact: { kind: 'image', title: '趋势', bytes: 10_000 }, code: 'x' }),
  )
  assert.match(withArtifact, /在面板里能看/)
  // 「做好了」只说一次：旧文案是「做好了：画张图 · 0.9 秒。做好了，在面板里能看。」，
  // 同一句说两遍、两个句号，听起来像系统播报，不像人在说话。
  assert.equal((withArtifact.match(/做好了/g) || []).length, 0, `重复了：${withArtifact}`)
  assert.ok(!withArtifact.includes('。'), `聊天里不留句号：${withArtifact}`)
  assert.ok(!withArtifact.includes('趋势.jpg') && !withArtifact.includes('http'), 'QQ 里不该甩本地地址')
})

await check('请求许可：给选项不给代码', () => {
  const view = askCard({
    goal: '把最近 7 天的聊天做成柱状图',
    plan: ['取记录', '计数', '画图'],
    ms: 8000,
    network: false,
  })
  assert.equal(view.line, '他/她想做一件事：把最近 7 天的聊天做成柱状图')
  assert.deepEqual(view.choices, ['允许这次', '以后都不用问', '不用了'])
  assert.match(view.facts.join(' '), /大概 8 秒/)
  assert.match(view.facts.join(' '), /不联网/)
  assert.equal(view.code, '')

  const text = askText(view)
  assert.match(text, /1\. 允许这次/)
  assert.match(text, /3\. 不用了/)
  assert.match(text, /回数字就行/)
  assert.ok(!text.includes('```'))
})

// 计划闸门随 guardPlan 一起搬去了 decide/speech.mjs，用例见 tests/speech.test.mjs

await check('耗时与产物：说人话，不说 0.00082 秒', () => {
  assert.equal(fmtMs(820), '0.8 秒')
  assert.equal(fmtMs(65_000), '1 分 5 秒')
  assert.equal(fmtMs(120), '120 毫秒')
  assert.equal(artifactNote({ kind: 'page', title: '本周概览' }), '一页网页：本周概览')
  assert.equal(artifactNote(null), '')
})

// ── 可以直接给一句话：不是每句话都是「做好了」 ──
await check('card 允许直接给一句话（定时提醒、主动开口用得上）', () => {
  const view = card({ line: '该喝水了' })
  assert.equal(view.line, '该喝水了')
  assert.equal(view.ok, true)
})

await check('给空白的 line 时，退回默认的「做好了」而不是发出空白', () => {
  const view = card({ label: '整理', line: '   ' })
  assert.match(view.line, /做好了：整理/)
})

await check('失败提示只对主人私聊展开：群聊与别人的私聊只留正文', () => {
  const view = card({ label: '读文件', error: 'ENOENT: no such file or directory' })
  assert.equal(view.hintOwnerOnly, true)
  assert.doesNotMatch(forQq(view), /确认一下文件名/, '默认（群聊/别人）不该带 hint')
  assert.match(forQq(view), /没做成：文件不存在/, '标题仍然保留，正常聊天内容不砍')
  assert.match(forQq(view, { owner: true }), /确认一下文件名/, '主人私聊里才展开 hint')
  assert.match(render(view), /你可以：/, '面板上仍然给主人看完整解释')
})

await check('产物文案不叠句号', () => {
  const text = forQq({ ok: true, line: '文档做好了。', artifact: { url: 'x' } })
  assert.ok(!text.includes('。。'), `实际：${text}`)
  assert.match(text, /在面板里能看/)
})

console.log(`\n✓ 人话层用例通过：${passed} 项`)
if (failed.length) {
  console.error(`\n✗ 失败 ${failed.length} 项：${failed.map((f) => f.name).join('、')}`)
  process.exit(1)
}
