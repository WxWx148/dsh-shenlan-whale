/**
 * app/asset.mjs — 二进制资源的唯一出口。
 *
 * 只管字节：二维码 PNG、落盘的聊天图片。**不管 JSON** —— 看图自检、群列表
 * 那些是数据源，走 /list/:kind 或各自的接口，塞进资源口只会让「资源」
 * 这个词失去意义（缓存策略、内容类型、错误处理全都不一样）。
 *
 * 路径穿越防护只有这一处。以前 /media/* 自己做一遍、/napcat/qr 从配置拿路径，
 * 两面分开看都没问题，但「谁能读磁盘」这个判断散在两个分支里，加第三种资源
 * 时很容易漏。现在一律先进 assetOf，名字不认识就 null，调用方回 404。
 *
 * 这个模块不碰 res、不写盘、不读配置对象：调用方把已经解析好的路径递进来，
 * 模块只做「名字 → 哪份字节」的分派，所以能被离线用例完整钉住。
 */

import { existsSync, readFileSync } from 'node:fs'
import { mediaPath } from '../ability/index.mjs'

/** 允许的名字。资源口不猜「最接近」的那个，不认识就是 404。 */
export const ASSET_KINDS = Object.freeze(['napcat/qr', 'media/*'])

/** 媒体文件名白名单里的后缀 → MIME。用映射表而不是拼字符串，杜绝奇怪扩展名混进来。 */
const IMAGE_TYPES = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
})

/**
 * 名字 → 字节。
 *
 * @param {string} name  /asset/ 后面那一段（已解码）
 * @param {{dir?:string, qrPath?:string}} ctx  媒体根目录 / 当前二维码文件
 * @returns {{bytes:Buffer, type:string, cache:string}|null}  null = 没有这个资源
 */
export function assetOf(name, ctx = {}) {
  const key = String(name || '').replace(/^\/+/, '')

  // 整条路径级别的兜底。mediaPath 自己有 NAME_RE，但那是「文件名」的规则；
  // 在分派之前先挡一道，将来加第三类资源也不会有人忘。
  if (!key || key.includes('..') || key.includes('\\') || key.includes('\0')) return null

  if (key === 'napcat/qr') {
    // 二维码路径来自登录层解析或用户配置，不是用户传进来的路径片段。
    // 这里只认一个已经算好的绝对路径，不接受任何形式的拼接。
    const file = String(ctx.qrPath || '')
    if (!file || !existsSync(file)) return null
    return { bytes: readFileSync(file), type: 'image/png', cache: 'no-store' }
  }

  if (key.startsWith('media/')) {
    const fileName = key.slice('media/'.length)
    // mediaPath 用 NAME_RE 只认「十六进制 + 图片后缀」，../ 与非法名一律返回 ''。
    const file = mediaPath(ctx.dir, fileName)
    if (!file || !existsSync(file)) return null
    const ext = fileName.split('.').pop().toLowerCase()
    const type = IMAGE_TYPES[ext]
    if (!type) return null
    return { bytes: readFileSync(file), type, cache: 'public, max-age=86400' }
  }

  return null
}
