/**
 * lib/refusals.mjs — 「这一阵子不想理谁」的登记簿。
 *
 * 为什么要有：被冒犯之后还笑着接话，是最伤「像个人」的一件事。
 * 但「不理」不能是永久的黑名单 —— 那是一时情绪，不是判决。
 * 所以这里只存到某个时间点，过期自动失效，主人也随时能解除。
 *
 * 文件：<数据目录>/refusals.json
 * 形状：{ "QQ号": { until: 毫秒时间戳, reason: "…", at: 毫秒 } }
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const MAX_MINUTES = 1440 // 最长一天；再长就该用「拉黑」而不是「不想理」
const MIN_MINUTES = 5

function fileOf(dir) {
  return path.join(String(dir || '.'), 'refusals.json')
}

function load(dir) {
  try {
    if (!existsSync(fileOf(dir))) return {}
    const parsed = JSON.parse(readFileSync(fileOf(dir), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function save(dir, data) {
  try {
    const file = fileOf(dir)
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

/** 现在是不是还在「不想理」的状态里 */
export function isRefused(dir, uin, now = Date.now()) {
  const id = String(uin || '').replace(/\D/g, '')
  if (!id) return false
  const entry = load(dir)[id]
  if (!entry) return false
  return Number(entry.until) > Number(now)
}

/** 登记「不想理」。minutes 会被夹在 5 分钟到 1 天之间 */
export function refuse(dir, uin, minutes = 120, reason = '', now = Date.now()) {
  const id = String(uin || '').replace(/\D/g, '')
  if (!id) return { ok: false, error: '不知道要登记谁' }
  const span = Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, Number(minutes) || 120))
  const data = load(dir)
  data[id] = { until: now + span * 60_000, reason: String(reason || '').slice(0, 80), at: now }
  const saved = save(dir, data)
  return saved.ok ? { ok: true, uin: id, minutes: span, until: data[id].until } : saved
}
