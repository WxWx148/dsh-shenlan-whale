#!/usr/bin/env node
/**
 * scripts/fix-broken-skill.mjs — 把技能簿里「名字变成问号」的那条改回来。
 *
 * 为什么需要这个脚本：0.30.1 之前，名字的损坏发生在**到达服务端之前**
 * （面板输入框 → 插件的那一段编码坏了，中文被逐字替换成 `?`），
 * 一旦存进 skills.json，代码这边就还原不出原来的字了。
 * 面板上能改名，但要是那份文件正被宿主进程占着、或者宿主还没重启，
 * 这里给一条命令行退路：直接改盘，改完重启即生效。
 *
 * 用法：
 *   node scripts/fix-broken-skill.mjs                      # 只列出坏掉的，不动
 *   node scripts/fix-broken-skill.mjs --name "上网查新闻"    # 把唯一那条改掉
 *   node scripts/fix-broken-skill.mjs --id taught.1 --name "上网查新闻" --what "问到了就去搜"
 *   node scripts/fix-broken-skill.mjs --file D:\path\skills.json --name "…"
 *
 * 默认路径按 WORKBUDDY 的运行目录猜：~/.dsh/shenlan-whale/skills.json。
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LOOKS_BROKEN = /^[?\uFFFD？]+$/

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  if (index > 0 && index + 1 < process.argv.length) return process.argv[index + 1]
  return fallback
}

const file = String(arg('file') || path.join(os.homedir(), '.dsh', 'shenlan-whale', 'skills.json'))
if (!existsSync(file)) {
  console.error(`找不到技能簿：${file}`)
  console.error('用 --file 指定 skills.json 的路径（宿主的数据目录里）。')
  process.exit(2)
}

const raw = JSON.parse(readFileSync(file, 'utf8'))
const taught = Array.isArray(raw.taught) ? raw.taught : []
const broken = taught.filter((row) => {
  const name = String(row?.name || '').trim()
  return name.length > 1 && LOOKS_BROKEN.test(name)
})

if (!broken.length) {
  console.log('没有名字是乱码的技能，不用改。')
  process.exit(0)
}

console.log(`找到 ${broken.length} 条名字坏掉的：`)
for (const row of broken) console.log(`  ${row.id}  name=${JSON.stringify(row.name)}  what=${JSON.stringify(row.what || '')}`)

const id = String(arg('id') || '')
const target = id ? broken.find((row) => row.id === id) : broken.length === 1 ? broken[0] : null
if (!target) {
  console.log('')
  console.log('要改哪一条：加 --id taught.N。改什么名字：加 --name "中文名"（可再给 --what "一句话说明"）。')
  console.log('也可以直接开面板 → 技能 → 那条 → 改名。')
  process.exit(0)
}

const name = String(arg('name') || '').trim()
if (!name) {
  console.error('没给 --name。这一条要改成什么名字？')
  process.exit(2)
}
if (name.length > 1 && LOOKS_BROKEN.test(name)) {
  console.error('--name 给的还是一串问号 —— 命令行本身的编码坏了。')
  console.error('这种情况改用面板里的「改名」输入框（浏览器/输入框那段是好的），别从终端里传中文。')
  process.exit(2)
}

const what = String(arg('what') || '').trim()
const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
copyFileSync(file, backup)

target.name = name
if (what) target.what = what
writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8')

console.log('')
console.log(`改好了：${target.id} → 「${name}」`)
console.log(`原件备份：${backup}`)
console.log('重启宿主后生效（运行中的进程内存里还是旧名字）。')
