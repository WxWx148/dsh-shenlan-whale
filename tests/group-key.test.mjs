import fs from 'node:fs'
import assert from 'node:assert/strict'
const { toRaw } = await import('../channel/index.mjs')
const { EventTagger } = await import('../facts/index.mjs')
const raw = toRaw({ post_type: 'message', message_type: 'group', group_id: 300000001, user_id: 400000001, time: 1793289281, message: [{ type: 'text', data: { text: '在吗' } }], sender: { card: '竹叶' } }, { selfId: '1000000001' })
const event = new EventTagger({ ownerId: '200000001', selfNames: ['深蓝鲸'], now: () => 1793289281000 }).tag(raw)
assert.equal(event.conversation, 'group:300000001')
assert.equal(event.from, '400000001')
console.log('OK group key: 2')

import { repairGroupConversations } from '../facts/index.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'group-repair-'))
fs.writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({ scope: 'group', from: '400000001', group: '300000001', conversation: 'group:400000001' }) + '\n')
const fixed = repairGroupConversations(dir)
assert.equal(fixed.changed, 1)
const row = JSON.parse(fs.readFileSync(join(dir, 'events.jsonl'), 'utf8').trim())
assert.equal(row.conversation, 'group:300000001')
console.log('OK group repair: 2')
