/**
 * lib/build-info.mjs — 「现在跑的到底是哪一份代码」。
 *
 * 为什么需要它：
 *   宿主加载的不是 `E:\深蓝鲸`，而是 `~/.dsh/profiles/<p>/node_modules/dsh-shenlan-whale`
 *   这份**复制**出来的副本。源码改完没同步，界面会停在旧版本上，而人只会觉得"改了没效果"。
 *   更糟的是副本可能**残缺**（部署清单漏一个目录），加载时直接 ERR_MODULE_NOT_FOUND。
 *
 * 这里回答三个问题，面板把它们摆在版本号旁边：
 *   1. 我这份副本在哪（selfDir）
 *   2. 源码在哪、和副本一样吗（sourceDir / same）
 *   3. 副本自己的模块图能不能闭合（broken）
 *
 * 三条原则：
 *   · 不知道就说不知道（`same: null`），不猜、不默认 true
 *   · 结果缓存 60 秒 —— 面板 5 秒轮询一次，不能每次都把 60 个文件读一遍
 *   · 同一份逻辑给同步脚本用（`brokenImports`），免得"同步时说没事、运行时说缺件"
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PARENTS } from '../lib/blueprint.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 插件根（源码里是仓库根，运行时是副本根） */
export const SELF_DIR = path.resolve(HERE, '..')

/**
 * 部署面：判断"代码一样吗"时只看这些，开发资产（tests/scripts）不参与。
 *
 * 父模块目录**从 blueprint.PARENTS 派生**，不手写。手写清单会长出这样的盲区：
 * 前几批把代码搬进 `facts/` `truth/` `decide/` `turn/` `mind/` `ability/` `life/` `view/`
 * 之后，这里还写着 `['index.js','lib','base','channel','voice']` —— 于是只改这些目录时
 * `same` 会报 true（源码与副本一致），而实际上副本是旧的。那正是这个文件想解决的
 * 「改了没效果」，只是换了个位置发生。`lib` 始终保留（散装模块与 blueprint 仍在里面）。
 */
const RUNTIME_ENTRIES = ['index.js', 'lib', ...PARENTS.map((one) => one.dir)]

/** 缓存：面板每 5 秒问一次，但磁盘不会每 5 秒变一次 */
const CACHE_MS = 60_000
let cache = null

/**
 * 磁盘上这份代码最后一次被改动的时间。
 *
 * 用途：判断"改了代码但还没重启"。进程启动时间可以用 process.uptime() 反推，
 * 两者一比就知道界面上跑的是不是最新的那一份 —— 这比让人凭记忆判断可靠。
 */
function newestMtime(dir) {
  let newest = 0
  for (const file of walkCode(dir)) {
    try { newest = Math.max(newest, statSync(file).mtimeMs) } catch {}
  }
  return newest
}

function walkCode(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkCode(full, out)
      continue
    }
    if (/\.(mjs|js)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** 去掉注释，避免把例子里的 import 当真 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/**
 * 副本里的模块图必须自洽：每个相对 import 都要落在一个真实文件上。
 *
 * 指纹（内容哈希）回答"一样不一样"，这张图回答"能不能跑起来"。
 * 上次插件起不来就是：指纹说一致，图里断了 23 处。
 */
export function brokenImports(dir) {
  const broken = []
  for (const file of walkCode(dir)) {
    let src
    try {
      src = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const m of stripComments(src).matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), m[1])
      if (!existsSync(target)) {
        broken.push(`${path.relative(dir, file).split(path.sep).join('/')} → ${m[1]}`)
      }
    }
  }
  return broken
}

/** 运行时面的内容指纹：只看会部署的那些文件，按相对路径排序后合并哈希 */
export function runtimeFingerprint(dir) {
  const parts = []
  for (const entry of RUNTIME_ENTRIES) {
    const full = path.join(dir, entry)
    if (!existsSync(full)) continue
    const files = statSync(full).isDirectory() ? walkCode(full) : [full]
    for (const file of files) {
      try {
        const rel = path.relative(dir, file).split(path.sep).join('/')
        const hash = createHash('sha1').update(readFileSync(file)).digest('hex')
        parts.push(rel + ':' + hash)
      } catch {}
    }
  }
  return createHash('sha1').update(parts.sort().join('\n')).digest('hex')
}

/**
 * 从宿主 profile 的依赖声明里找源码目录。
 *
 * 副本路径形如 `<profile>/node_modules/<name>`，profile 的 package.json 里写着
 * `"dsh-shenlan-whale": "file:E:/深蓝鲸"` —— 这是唯一可靠的来源：
 * 环境变量要人配，写死路径会错，而这条声明是安装时就写进去的。
 */
export function sourceDirOf(selfDir = SELF_DIR) {
  // selfDir = <profile>/node_modules/<name>，往上两级才是 profile
  const profile = path.resolve(selfDir, '..', '..')
  const pkgPath = path.join(profile, 'package.json')
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }['dsh-shenlan-whale']
    if (typeof declared !== 'string') return ''
    if (!declared.startsWith('file:')) return ''
    const raw = declared.slice('file:'.length)
    const dir = path.resolve(profile, raw)
    return existsSync(dir) ? dir : ''
  } catch {
    return ''
  }
}

function versionOf(dir) {
  try {
    return String(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version || '')
  } catch {
    return ''
  }
}

/**
 * 汇总。任何一项算不出来就用 null / 空，不编。
 */
export function buildInfo({ fresh = false } = {}) {
  const now = Date.now()
  if (!fresh && cache && now - cache.at < CACHE_MS) return cache.value

  const selfDir = SELF_DIR
  const sourceDir = sourceDirOf(selfDir)
  const copyVersion = versionOf(selfDir)
  const srcVersion = sourceDir ? versionOf(sourceDir) : ''
  const broken = brokenImports(selfDir)
  // 宿主进程的启动时刻。process.uptime() 是当前进程已经跑了多久，
  // 在插件里拿到的就是宿主（Node 侧）的启动时间。
  const startedAt = Date.now() - Math.round(process.uptime() * 1000)
  // 容差 3 秒：复制、落盘、时钟精度都会带来小抖动，不能一有抖动就喊重启
  const restartNeeded = newestMtime(selfDir) > startedAt + 3000

  // 只有真的找到源码、且源码不是自己，才谈得上"一样不一样"
  let same = null
  if (sourceDir && path.resolve(sourceDir) !== path.resolve(selfDir)) {
    try {
      same = runtimeFingerprint(sourceDir) === runtimeFingerprint(selfDir)
    } catch {
      same = null
    }
  } else if (sourceDir) {
    same = true
  }

  const value = {
    known: !!sourceDir,
    same,
    selfDir,
    sourceDir,
    srcVersion,
    copyVersion,
    broken,
    restartNeeded,
    startedAt,
    checkedAt: now,
    // 给界面的一句话：只在需要提醒时才非空。顺序 = 后果从重到轻。
    hint: broken.length
      ? `副本缺 ${broken.length} 个模块，插件可能起不来`
      : restartNeeded
        ? '磁盘上的代码比这次启动新：重启 DSH 后界面才会变'
        : same === false
          ? '源码比副本新：跑一次同步再重启，界面才会变'
          : '',
  }
  cache = { at: now, value }
  return value
}
