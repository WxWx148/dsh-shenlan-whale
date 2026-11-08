/**
 * 副本加载验证 —— 同步到宿主后，把部署目录里的每个运行时模块真的 import 一遍。
 *
 * 为什么需要它：
 *   语法检查只看源码，`check:sync` 只比对文件是否一致，都不会回答
 *   「宿主重启时这些模块能不能被解析」。踩过两次：漏部署父模块
 *   （ERR_MODULE_NOT_FOUND）、搬目录后相对路径没跟着改。这类错误
 *   测试全绿、守卫全绿，只有宿主启动那一刻才炸。
 *
 * 以前的临时脚本把目录写死成 ['lib','base','channel','voice']，
 * 于是 facts/truth/decide/turn 里的模块从没被真正加载过 —— 那不是验证，
 * 是只验了自己想验的那几个。现在目录从副本自己的 blueprint.PARENTS 派生。
 *
 * 用法：
 *   node scripts/verify-copy-load.mjs               自动找宿主副本（找多个 profile 时全查）
 *   node scripts/verify-copy-load.mjs <副本根目录>
 * 例：
 *   node scripts/verify-copy-load.mjs ~/.dsh/profiles/desktop/node_modules/dsh-shenlan-whale
 *
 * 退出码：全部加载成功 0；有模块加载失败 1；找不到副本 0（这台机器没装插件，不算失败）。
 *
 * 0.46.0 两处修正：
 *   · **递归扫描**。以前只 readdir 一层，`mind/learn/*.mjs` 这类子目录里的模块
 *     从没被真的 import 过 —— 而「一个文件都没加载」和「全部加载成功」在输出上
 *     只差一个数字。父模块内部再分层之后，这个盲区会越变越大。
 *   · **不传参数也能跑**：`npm run audit` 里它是一条，不能要求人手拼路径。
 *     找不到副本时如实说「这台机器没装」，而不是报一个红叉。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const NAME = 'dsh-shenlan-whale'

/** 宿主真正加载的那些副本（可能不止一个 profile） */
function copiesOf() {
  const profiles = path.join(homedir(), '.dsh', 'profiles')
  if (!existsSync(profiles)) return []
  return readdirSync(profiles)
    .map((profile) => path.join(profiles, profile, 'node_modules', NAME))
    .filter((dir) => existsSync(dir))
}

const targets = process.argv[2] ? [process.argv[2]] : copiesOf()
if (!targets.length) {
  console.log(`跳过：这台机器上没有宿主副本（${path.join('~', '.dsh', 'profiles', '*', 'node_modules', NAME)}）`)
  process.exit(0)
}

for (const target of targets) {
  const code = await verify(target)
  if (code) process.exit(code)
}

async function verify(root) {

const blueprintPath = path.join(root, 'lib', 'blueprint.mjs')
if (!existsSync(blueprintPath)) {
  console.error('副本里没有 lib/blueprint.mjs，路径对吗：' + root)
  return 2
}

const { PARENTS } = await import(pathToFileURL(blueprintPath).href)
const dirs = ['lib', ...PARENTS.map((one) => one.dir)]

/** 递归收模块：父模块内部再分层（learn/、stages/、tools/）时不能漏 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name)
    let stat
    try { stat = statSync(abs) } catch { continue }
    if (stat.isDirectory()) walk(abs, out)
    else if (/\.(mjs|js)$/.test(name) && name !== 'client.panel.js') out.push(abs)
  }
  return out
}

const files = []
for (const dir of dirs) {
  const abs = path.join(root, dir)
  if (!existsSync(abs)) continue
  files.push(...walk(abs))
}

let ok = 0
const bad = []
for (const file of files) {
  try {
    await import(pathToFileURL(file).href)
    ok += 1
  } catch (error) {
    bad.push(path.relative(root, file) + ' → ' + String(error && error.message).slice(0, 160))
  }
}

console.log(`副本：${root}`)
console.log(`目录：${dirs.join(', ')}`)
console.log(`模块真实加载：${ok}/${files.length} 成功`)
for (const one of bad) console.log('  ✗ ' + one)
return bad.length ? 1 : 0
}
