import fs from 'node:fs'
import assert from 'node:assert/strict'
const { toRaw } = await import('../lib/qq/onebot.mjs')
const { EventTagger } = await import('../lib/event.mjs')
const raw = toRaw({ post_type: 'message', message_type: 'group', group_id: 100000001, user_id: 200000002, time: 1793289281, message: [{ type: 'text', data: { text: '在吗' } }], sender: { card: '小蓝' } }, { selfId: '1000000001' })
const event = new EventTagger({ ownerId: '2239929077', selfNames: ['深蓝鲸'], now: () => 1793289281000 }).tag(raw)
assert.equal(event.conversation, 'group:100000001')
assert.equal(event.from, '200000002')
console.log('OK group key: 2')

import { repairGroupConversations } from '../lib/event.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'group-repair-'))
fs.writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({ scope: 'group', from: '200000002', group: '100000001', conversation: 'group:200000002' }) + '\n')
const fixed = repairGroupConversations(dir)
assert.equal(fixed.changed, 1)
const row = JSON.parse(fs.readFileSync(join(dir, 'events.jsonl'), 'utf8').trim())
assert.equal(row.conversation, 'group:100000001')
console.log('OK group repair: 2')
