/**
 * lib/structure.mjs — 结构快照的读取口，界面只从这里问事实。
 *
 * 界面里以前有四类手抄：路径（`turn/index.mjs`）、清单（页面写三处）、数字（侧栏两份）、
 * 前缀（`/api/shenlan` 写三处）。结构一搬就失真，而且只能靠人肉同步。
 * 现在统一改成「问 structure」：
 *
 *   pathOfSymbol('voice', 'typingDelayMs')  → 'voice/typing.mjs'
 *   assetUrl('napcat/qr')                   → '/api/shenlan/asset/napcat/qr'
 *   resolvePage('memory')                   → 'mind'（合并页面后）
 *
 * 快照是构建产物（`npm run structure`），不是运行时扫描：启动不额外读目录，
 * 部署包里也只有运行时文件；快照进 git，能 diff、能 review、能被 `--check` 卡住。
 *
 * 这个模块**不做判断**，只做查询。缺什么就返回空值，绝不猜。
 */

import { readFileSync } from 'node:fs'

const RAW = JSON.parse(readFileSync(new URL('./structure.generated.json', import.meta.url), 'utf8'))

export const STRUCTURE = RAW

/** 接口前缀。界面拼 URL 一律走 apiUrl / assetUrl，不许再写 '/api/shenlan' */
export const API_BASE = RAW.api.base

/** 把站内路径拼成完整接口地址 */
export function apiUrl(pathname = '') {
  const tail = String(pathname || '')
  if (!tail) return API_BASE
  return API_BASE + (tail.startsWith('/') ? tail : '/' + tail)
}

/**
 * 静态资源地址（二维码、视觉自检图、媒体）。
 *
 * 以前这三处直接写 `/api/shenlan/napcat/qr`，换前缀要改三个文件。
 * 现在只有这一个函数知道前缀怎么拼。
 */
export function assetUrl(name) {
  return apiUrl('/asset/' + String(name || '').replace(/^\/+/, ''))
}

/** 一个父模块的声明（可能还没落地，status 为 planned） */
export function parentOf(id) {
  return RAW.parents.find((one) => one.id === id) || null
}

/** 某个父模块导出的符号名列表 */
export function exportsOf(id) {
  const one = parentOf(id)
  return one ? one.exports.slice() : []
}

/** 这个符号是不是某个父模块真的导出的 */
export function hasSymbol(id, symbol) {
  const one = parentOf(id)
  return !!one && one.exports.includes(symbol)
}

/**
 * 符号 → 文件路径。
 *
 * 有门面时，符号写在门面上，但**实现**在成员文件里，所以要逐个文件找。
 * 找不到返回空串 —— 调用方（规则页）据此显示「未接上」，而不是编一个路径。
 */
export function pathOfSymbol(id, symbol) {
  const one = parentOf(id)
  if (!one) return ''
  // 实现文件优先：门面（index.mjs）也 re-export 同一个符号，
  // 但它只是转发，真正写这段逻辑的是成员文件。跳过门面再找，找不到才回退。
  const impl = one.files.filter((file) => file.file !== one.facade)
  const owner = impl.find((file) => file.exports.includes(symbol))
    || one.files.find((file) => file.exports.includes(symbol))
  return owner ? owner.path : ''
}

/**
 * 页面 id 解析：旧 id → 新 id。
 *
 * 合并页面时 `aliases` 才会非空。现在返回原值，深链不受影响。
 */
export function resolvePage(id) {
  const key = String(id || '')
  return RAW.aliases[key] || key
}

/** 页面声明的全部 id（不含别名） */
export function pageIds() {
  return RAW.pages.map((one) => one.id)
}

/** 一个页面属于哪个域（含中文名） */
export function domainOfPage(id) {
  const page = RAW.pages.find((one) => one.id === resolvePage(id))
  if (!page || !page.domain) return null
  return RAW.domains.find((one) => one.id === page.domain) || null
}

/** 域 → 它覆盖的父模块 id 列表 */
export function parentsOfDomain(domainId) {
  const one = RAW.domains.find((item) => item.id === domainId)
  return one ? one.parents.slice() : []
}

/** 结构统计。面板上的"多少模块 / 多少路由"一律取这里，不手写 */
export function stats() {
  return { ...RAW.stats }
}

/** 某条接口是不是真的存在（守卫 R4 用，界面也可以用来自检） */
export function hasRoute(pathname) {
  const clean = String(pathname || '').replace(API_BASE, '') || '/'
  return RAW.api.routes.some((one) => (one.endsWith('*') ? clean.startsWith(one.slice(0, -1)) : one === clean))
}
