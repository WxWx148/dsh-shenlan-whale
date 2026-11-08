/**
 * probes/all.mjs — 跑 probes/ 下所有 `probe*.mjs`。
 *
 * 与 tests/all.mjs 同一个理由：探针也是加法。以前 `npm run probe` 手写
 * probe8~11 四条，新增一条忘了加，表现同样是「全过」。
 *
 * 探针比用例慢（要起假宿主、跑定时器），所以单独一条命令、单独一档，
 * 不塞进 `npm test` —— 日常改代码不该被联调探针拖住。
 */

import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const files = readdirSync(HERE)
  .filter((name) => /^probe.*\.mjs$/.test(name))
  .sort()

if (!files.length) {
  console.error('✗ 没找到探针')
  process.exit(1)
}

const failed = []
for (const name of files) {
  const at = Date.now()
  const result = spawnSync(process.execPath, [path.join(HERE, name)], { encoding: 'utf8' })
  const ms = Date.now() - at
  const out = `${result.stdout || ''}${result.stderr || ''}`
  const last = out.trim().split('\n').filter(Boolean).pop() || ''
  if (result.status === 0) {
    console.log(`  ✓ ${name.padEnd(18)} ${String(ms).padStart(6)}ms  ${last.slice(0, 50)}`)
  } else {
    failed.push({ name, out })
    console.log(`  ✗ ${name}`)
  }
}

console.log(`\n${failed.length ? '✗' : '✓'} 探针 ${files.length - failed.length}/${files.length} 通过`)
if (failed.length) {
  for (const one of failed) {
    console.error(`\n── ${one.name} ──`)
    console.error(one.out.trim().split('\n').slice(-30).join('\n'))
  }
  process.exit(1)
}
