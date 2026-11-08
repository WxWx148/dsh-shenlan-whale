import assert from 'node:assert/strict'
const { friendlySendError } = await import('../channel/index.mjs')
assert.match(friendlySendError(new Error('EventChecker Failed ... errMsg: 发送失败，你已被移出该群，请重新加群')), /不在这个群/)
assert.match(friendlySendError(new Error('普通失败')), /普通失败/)
console.log('OK send error: 2')
