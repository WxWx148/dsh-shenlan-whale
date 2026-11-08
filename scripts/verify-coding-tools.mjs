/**
 * scripts/verify-coding-tools.mjs — 验收「深蓝能用这套工具改自己的代码」。
 *
 * 它不是测试倒数第二条 stack 的单元用例（那些在 tests/coding.test.mjs 里，用临时目录），
 * 而是**对着真实的插件目录跑一遍真调用**：
 *   列得出来 → 读得到 → 搜得着 → 写得进 → 备份落盘 → 还原得回来 → 命令跑得动。
 *
 * 为什么要单独一份：单元用例用临时目录，能证明边界逻辑对；
 * 但「这个 root 到底指没指到 E:\\深蓝鲸」这种事，只有对着真目录跑一次才算数。
 * 指错位置的话逻辑全对也没用 —— 它会一直在改一个不存在的地方。
 *
 * 用法：node scripts/verify-coding-tools.mjs
 * 退出码非 0 = 有问题。
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createTools } from '../ability/index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.dirname(HERE)
// 数据目录：与 index.js 同一套算法（环境变量优先，否则 ~/.dsh/shenlan-whale）
const DATA_DIR = process.env.SHENLAN_DATA_DIR || path.join(homedir(), '.dsh', 'shenlan-whale')

let ok = 0
const bad = []
function step(name, pass, detail = '') {
  if (pass) {
    ok += 1
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    bad.push(name)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
  return pass
}

const runtime = {
  dir: DATA_DIR,
  config: { sandbox: { codeMode: 'write' } },
  log: () => {},
}
const tools = createTools({ sourceRoot: PLUGIN_ROOT, dir: DATA_DIR, runtime })

console.log('')
console.log(`插件根目录：${PLUGIN_ROOT}`)
console.log(`数据目录　：${DATA_DIR}`)
console.log('')
console.log('① 工具登记')

step('六个工具都在表里', ['code_list', 'code_read', 'code_search', 'code_write', 'code_restore', 'run_command'].every((n) => tools.has(n)))
step('提示词里会告诉模型有这些工具', tools.prompt().includes('code_write'), tools.prompt().slice(0, 60) + '…')

console.log('')
console.log('② 看与搜（对着真的源码目录）')

const listed = tools.call('code_list', { path: 'lib', recursive: 0 })
step('列出 lib 目录', listed.ok === true && listed.data.entries.length > 10, `${listed.data?.entries?.length ?? 0} 项`)

const self = tools.call('code_read', { path: 'ability/coding.mjs', start: 1, count: 12 })
step('读本文件前十行', self.ok === true && /coding\.mjs/.test(self.text), `${self.data?.lines ?? 0} 行`)

const found = tools.call('code_search', { keyword: 'resolveInside', max: 12 })
step('搜一个真实存在的函数', found.ok === true && found.data.hits.length >= 1, `${found.data?.hits?.length ?? 0} 处命中`)

const missingWord = `一定搜不到-${randomUUID().slice(0, 8)}`
const gone = tools.call('code_search', { keyword: missingWord })
step('搜不到就如实说搜不到', gone.ok === false && gone.code === 'none')

console.log('')
console.log('③ 写：改一个无害的小文件')
const probeRel = 'lib/.coding-probe.mjs'
const probeAbs = path.join(PLUGIN_ROOT, probeRel)
rmSync(probeAbs, { force: true })

const written = tools.call('code_write', { path: probeRel, content: 'export const probe = 1\n' })
step('新建文件成功', written.ok === true, written.error || `${written.data?.bytes ?? 0} 字节`)
step('内容真的落盘', existsSync(probeAbs) && readFileSync(probeAbs, 'utf8') === 'export const probe = 1\n')

const changed = tools.call('code_write', { path: probeRel, content: 'export const probe = 2\n' })
step('覆盖已有文件成功', changed.ok === true, changed.error || '')
step('备份落到了数据目录（不脏源码树）', Boolean(changed.data?.backup) && existsSync(changed.data.backup), changed.data?.backup ? path.basename(changed.data.backup) : '没有备份路径')

const restored = tools.call('code_restore', { path: probeRel })
step('还原回上一版', restored.ok === true && readFileSync(probeAbs, 'utf8') === 'export const probe = 1\n', restored.error || '')

console.log('')
console.log('④ 安全边界（这几条必须是「拒」）')

const escape = tools.call('code_read', { path: '../../../../Windows/win.ini' })
step('读不到插件目录外', escape.ok === false && escape.code === 'outside', escape.error || '')

const abs = tools.call('code_write', { path: 'C:\\Windows\\Temp\\evil.mjs', content: 'x' })
step('绝对路径写不出去', abs.ok === false && abs.code === 'outside')

const entry = tools.call('code_write', { path: 'index.js', content: '// 这是一次验收，不该真的写进去\n' })
step('关键启动文件默认改不了', entry.ok === false && entry.code === 'protected', entry.error || '')
step('被拒之后入口文件一字未动', readFileSync(path.join(PLUGIN_ROOT, 'index.js'), 'utf8').startsWith('/**'))

const bin = await tools.call('run_command', { bin: 'powershell', args: ['Get-Process'] })
step('白名单外的程序不给跑', bin.ok === false && bin.code === 'bin', bin.error || '')

console.log('')
console.log('⑤ 跑命令')
const node = await tools.call('run_command', { bin: 'node', args: ['-v'] })
step('能跑 node 并拿回输出', node.ok === true && /v\d+/.test(node.text), String(node.text).trim().slice(0, 40))

console.log('')
console.log('⑥ 命名与设置项')
const { find, PANEL_GROUPS } = await import('../truth/index.mjs')
const group = PANEL_GROUPS.find((item) => item.id === 'sandbox')
step('设置面板里这一组叫「沙箱」', group?.label === '沙箱', `实际：${group?.label}`)
const codeItem = find('sandbox.codeMode')
step('改代码档位在面板里可达', Boolean(codeItem), codeItem?.label || '找不到这一项')
step('档位有中文档位名（不是把 off/read/write 直接摆给人看）', Object.keys(codeItem?.optionLabels || {}).length === 3, Object.values(codeItem?.optionLabels || {}).join(' / '))
const sandboxText = readFileSync(path.join(PLUGIN_ROOT, 'lib', 'sandbox.mjs'), 'utf8')
step('执行器拒绝文案里写的路径与面板一致', /设置 → 沙箱/.test(sandboxText))
const sourceText = readFileSync(path.join(PLUGIN_ROOT, 'lib', 'coding.mjs'), 'utf8')
step('源码里不再出现旧名「跑代码」', !sourceText.includes('跑代码'))

// 这一条必须查：profile 的依赖是 `file:E:/深蓝鲸`，pnpm 对 file: 是**复制**不是链接，
// 宿主加载的是 ~/.dsh/profiles/<p>/node_modules/dsh-shenlan-whale 那份快照。
// 源码改得再对，副本落后一个版本，界面就一个字都不动 —— 重启多少次都没用。
const profilesDir = path.join(homedir(), '.dsh', 'profiles')
const copies = []
try {
  for (const name of readdirSync(profilesDir)) {
    const dir = path.join(profilesDir, name, 'node_modules', 'dsh-shenlan-whale')
    if (existsSync(dir)) copies.push({ profile: name, dir })
  }
} catch {}
const myVersion = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8')).version
const stale = copies.filter(({ dir }) => {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version !== myVersion
  } catch {
    return true
  }
})
step('宿主加载的副本与源码同版本', stale.length === 0,
  stale.length ? `落后的是：${stale.map((item) => item.profile).join('、')} —— 先跑 npm run sync，再重启宿主` : `副本 ${copies.length} 份，均 v${myVersion}`)

console.log('')
console.log('⑦ 沙箱工作区（草稿纸）')
const workspace = path.join(DATA_DIR, 'sandbox', 'workspace')
step('工作区目录真的存在', existsSync(workspace), workspace)
let wrote = false
try {
  const probe = path.join(workspace, '.verify-probe.txt')
  writeFileSync(probe, 'ok')
  wrote = readFileSync(probe, 'utf8') === 'ok'
  rmSync(probe, { force: true })
} catch (error) {
  wrote = false
}
step('工作区可读可写', wrote)

console.log('')
rmSync(probeAbs, { force: true })

if (bad.length) {
  console.log(`✗ 验收没过：${bad.length} 项失败（${bad.join('、')}）`)
  process.exit(1)
}
console.log(`✓ 验收通过：${ok} 项`)
