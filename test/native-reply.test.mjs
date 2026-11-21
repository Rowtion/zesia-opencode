import assert from 'node:assert/strict';
import test from 'node:test';
import { receiptMessageID, replyText, selectedReplyPacket, updateHandback } from '../native/session-consult.mjs';

const original = { sessionId: 'ses_initial', replyId: 'msg_old', draftId: 'draft', status: 'waiting',
  requestId: 'zrq-1795214312000-acf829f0-73a2-48a0-a817-6975631cd442' };

test('only visible text of the chosen finished reply enters the packet', () => {
  const reply = { id: 'msg_old', type: 'assistant', time: { completed: 1 }, content: [
    { type: 'reasoning', text: 'private reasoning' },
    { type: 'text', text: 'Claim A' },
    { type: 'tool', name: 'read', state: { output: 'unrelated file' } },
    { type: 'text', text: 'Exact evidence B' },
  ] };
  assert.equal(replyText(reply), 'Claim A\n\nExact evidence B');
  const packet = selectedReplyPacket(reply, 'fixture');
  assert.equal(packet.context.materials[0].content, 'Claim A\n\nExact evidence B');
  assert.deepEqual(Object.keys(packet.context), ['materials']);
  assert.throws(() => selectedReplyPacket(undefined, 'fixture'), /Choose a completed assistant reply/);
  assert.throws(() => selectedReplyPacket({ ...reply, time: {} }, 'fixture'), /Choose a completed assistant reply/);
});

test('queue once in the original session, even across restart, then record receipt only after promotion', async () => {
  const id = receiptMessageID(original.requestId);
  const calls = [];
  const inbox = new Map();
  const transcript = new Map();
  let recorded = false;
  const host = {
    message: async (sessionId, messageId) => transcript.get(sessionId)?.get(messageId),
    pending: async (sessionId, messageId) => inbox.get(sessionId)?.get(messageId),
    async post(input) {
      calls.push(input);
      const item = { type: 'synthetic', id: input.id, sessionID: input.sessionID,
        payload: { metadata: input.metadata, text: input.text } };
      inbox.set(input.sessionID, new Map([[item.id, item]]));
      return item;
    },
  };
  const runtime = {
    result: async () => ({ ok: true, status: 'completed', advice: 'Check the claim.' }),
    receipt: async draftId => {
      assert.equal(draftId, 'draft');
      recorded = true;
      return { ok: true };
    },
  };
  assert.equal(await updateHandback({ binding: original, host, runtime }), 'queued');
  assert.deepEqual(calls.map(call => [call.sessionID, call.id, call.resume]), [['ses_initial', id, false]]);
  assert.equal(recorded, false);
  assert.equal(await updateHandback({ binding: structuredClone(original), host, runtime }), 'queued');
  assert.equal(calls.length, 1);
  assert.equal(inbox.has('ses_changed_to'), false);
  const queued = inbox.get('ses_initial').get(id);
  transcript.set('ses_initial', new Map([[id, { ...queued, metadata: queued.payload.metadata }]]));
  assert.equal(await updateHandback({ binding: original, host, runtime }), 'queued');
  assert.equal(recorded, false);
  inbox.clear();
  assert.equal(await updateHandback({ binding: original, host, runtime }), 'received');
  assert.equal(recorded, true);
});

test('cancelled and unknown requests stay read-only, and a mismatched result cannot be delivered', async () => {
  const binding = original;
  const host = { post() { assert.fail('This result must not be posted'); } };
  for (const status of ['cancelled', 'unknown', 'running']) {
    const runtime = { result: async () => ({ status }) };
    assert.equal(await updateHandback({ binding, host, runtime }), status === 'cancelled' ? status : 'waiting');
  }
  const runtime = { result: async () => ({ ok: true, status: 'completed', requestId: 'another-id', advice: 'Other' }) };
  await assert.rejects(updateHandback({ binding, runtime, host }), /another request/);
});

test('a previously queued receipt is not posted again after removal from the inbox', async () => {
  const binding = { ...original, status: 'queued' };
  const host = { pending: async () => null, message: async () => null, post() { assert.fail('No replay'); } };
  const runtime = { result: async () => ({ ok: true, status: 'completed', advice: 'Review' }) };
  assert.equal(await updateHandback({ binding, runtime, host }), 'queued');
});
