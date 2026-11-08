/**
 * scripts/seed-persona.mjs — 把出厂人设播种到数据目录。
 *
 * 为什么要有这个脚本：
 *   人设文件住在数据目录（~/.dsh/shenlan-whale/persona.md），插件目录归插件管。
 *   装好插件之后这一份不会自动出现 —— 得有人把它放下去。
 *   手抄一份过去的话，下次换个机子装又得抄一遍，而且抄的版本可能不是当前这版。
 *
 *   所以这里让它跟「第一次醒来」走同一条路：
 *   PersonaBook 读不到文件就用出厂人设落盘。脚本做的事跟它一模一样，
 *   只是提前做了，省得等第一条消息才生效。
 *
 * 三条硬规矩：
 *   1. **不覆盖**：已经有 persona.md 就默认不动（那是他/她自己的，改了就回不去了）。
 *   2. 要覆盖必须显式说 --force，而且强制覆盖前先备份。
 *   3. 播种完报清楚：写到哪了、多少字、几节。
 *
 * 用法：
 *   node scripts/seed-persona.mjs                 播到默认数据目录
 *   node scripts/seed-persona.mjs --dir <目录>     播到指定目录
 *   node scripts/seed-persona.mjs --force          强制覆盖（先自动备份）
 *   node scripts/seed-persona.mjs --check          只看状态，不写
 */

import { copyFileSync, existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PersonaBook, readDefaultPersona } from '../mind/index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const DATA_DIR = path.join(homedir(), '.dsh', 'shenlan-whale')

function parseArgs(argv) {
  const out = { dir: DATA_DIR, force: false, check: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir' && argv[i + 1]) {
      out.dir = path.resolve(argv[i + 1])
      i += 1
    } else if (argv[i] === '--force') out.force = true
    else if (argv[i] === '--check') out.check = true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const defaultText = readDefaultPersona(ROOT)

if (!defaultText) {
  console.error('✗ 读不到出厂人设：' + path.join(ROOT, 'lib', 'persona.default.md'))
  process.exit(1)
}

const book = new PersonaBook({ dir: args.dir, defaultText })

if (args.check) {
  const exists = book.exists()
  const summary = book.summary()
  console.log(`数据目录：${args.dir}`)
  console.log(`人设文件：${exists ? '已有' : '还没有'}`)
  if (exists) {
    console.log(`  字数 ${summary.chars} / ${summary.sections} 节 / 核心节 ${summary.coreIntact ? '齐全' : '缺了'}`)
    const versions = book.versions()
    console.log(`  历史版本 ${versions.length} 份`)
  }
  process.exit(0)
}

if (book.exists() && !args.force) {
  const summary = book.summary()
  console.log(`✓ 人设文件已存在，不覆盖：${path.join(args.dir, 'persona.md')}`)
  console.log(`  字数 ${summary.chars} / ${summary.sections} 节 / 核心节 ${summary.coreIntact ? '齐全' : '缺了'}`)
  console.log('  要用出厂人设覆盖就加 --force（会自动备份）')
  process.exit(0)
}

if (args.force && book.exists()) {
  const backup = path.join(args.dir, `persona.md.bak-${Date.now()}`)
  try {
    copyFileSync(path.join(args.dir, 'persona.md'), backup)
    console.log(`✓ 覆盖前已备份：${backup}`)
  } catch (error) {
    console.error('✗ 备份失败，不覆盖：' + String(error?.message || error))
    process.exit(1)
  }
}

// 走 PersonaBook 自己的读路径：没有文件就用出厂人设落盘。
// 这样「播种」与「第一次醒来」是同一套逻辑，不会出现两份不一致的初始状态。
//
// 但 --force 必须真的强制：
//   book.read() 发现文件已存在就直接读它，**不会**用 defaultText 覆盖。
//   所以这里在 --force 时先删掉旧文件，再走 read() —— 它就会用出厂人设落盘。
//   （实测踩过：--force 跑完，文件还是旧内容，字数也不变 —— 强制了个寂寞。）
if (args.force) {
  try {
    unlinkSync(path.join(args.dir, 'persona.md'))
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error('✗ 删旧文件失败，不覆盖：' + String(error?.message || error))
      process.exit(1)
    }
  }
}
const text = book.read()
const written = path.join(args.dir, 'persona.md')
const summary = book.summary()
const size = statSync(written).size

// 播完对一遍：写进去的必须跟出厂人设一致。
// 不一致就说明中途出了问题 —— 宁可报错，也不能留一份半新半旧的文件。
if (text.trim() !== defaultText.trim()) {
  console.error('✗ 写进去的内容跟出厂人设对不上，已保留备份，请检查')
  process.exit(1)
}

console.log(`✓ 人设已就位：${written}`)
console.log(`  字数 ${summary.chars} / ${summary.sections} 节 / 核心节 ${summary.coreIntact ? '齐全' : '缺了'} / ${size} 字节`)
console.log('  它现在是唯一真源：改它等于改灵魂，改完必须告诉主人。')
