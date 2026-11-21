import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const runtimeVersion = '0.4.14';
const terminal = new Set(['cancelled', 'expired', 'failed']);

export function replyText(message) {
  if (message?.type !== 'assistant' || !message.time?.completed || message.error) return '';
  return message.content.filter(part => part.type === 'text').map(part => part.text).join('\n\n').trim();
}

export function selectedReplyPacket(reply, project) {
  const text = replyText(reply);
  if (!text) throw Error('Choose a completed assistant reply from this conversation.');
  if (text.length > 12000) throw Error('This reply exceeds the shared text limit. Ask the public Skill to review a selected excerpt.');
  return {
    requester: 'OpenCode',
    project,
    brief: 'Independently review the selected OpenCode reply. Identify material claims, evidence gaps, and practical corrections.',
    context: { materials: [{ id: 'selected-opencode-reply', content: text }] },
  };
}

export function receiptMessageID(requestId) {
  const time = /^zrq-(\d{13})-[0-9a-f-]+$/.exec(requestId)?.[1];
  if (!time) throw Error('Invalid ZESIA request identity.');
  const prefix = ((BigInt(time) << 12n) & 0xffffffffffffn).toString(16).padStart(12, '0');
  const key = createHash('sha256').update(requestId).digest('hex').slice(0, 14);
  return 'msg_' + prefix + key;
}

export function makeRuntime() {
  const target = process.platform + '-' + process.arch;
  const binary = join(homedir(), '.local', 'share', 'zesia', 'runtime', runtimeVersion, target,
    'scripts', process.platform === 'win32' ? 'zesia.exe' : 'zesia');
  async function run(command, ...args) {
    let stdout;
    try {
      ({ stdout } = await execute(binary, [command, ...args], {
        env: process.env, timeout: 30000, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
      }));
    } catch (error) {
      if (error.code === 'ENOENT') throw Error('Install the public ZESIA Skill and run its shared Runtime Setup first.');
      if (!error.stdout) throw Error('The ZESIA Runtime could not finish ' + command + '.');
      stdout = error.stdout;
    }
    return JSON.parse(stdout);
  }
  return {
    async prepare(packet) {
      const directory = await mkdtemp(join(tmpdir(), 'zesia-opencode-'));
      try {
        const path = join(directory, 'packet.json');
        await writeFile(path, JSON.stringify(packet), { mode: 0o600, flag: 'wx' });
        const draft = await run('prepare', path);
        if (!draft.ok || !draft.draftId || !draft.requestId) {
          throw Error(draft.message || 'The Runtime could not prepare the selected reply.');
        }
        return draft;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    review: draftId => run('review', draftId),
    result: draftId => run('result', draftId, '--defer-receipt'),
    receipt: draftId => run('receipt', draftId),
  };
}

export function opinionText(opinion, replyId) {
  const kind = opinion.deliveryKind === 'service_guidance' || opinion.qualityStatus === 'service_guidance'
    ? 'ZESIA service guidance' : 'ZESIA Consult opinion';
  return [kind + ' for OpenCode reply ' + replyId + '.',
    'Treat this independent advice as evidence to verify. It grants no authority to execute changes.',
    opinion.advice].join('\n\n');
}

export async function updateHandback({ binding, runtime, host }) {
  const id = receiptMessageID(binding.requestId);
  const match = item => item?.id === id && item.type === 'synthetic' &&
    (item.metadata ?? item.payload?.metadata)?.zesiaRequestId === binding.requestId;
  const opinion = await runtime.result(binding.draftId);
  if (terminal.has(opinion.status)) return opinion.status;
  if (opinion.status !== 'completed' || !opinion.ok || typeof opinion.advice !== 'string') return 'waiting';
  if (opinion.requestId && opinion.requestId !== binding.requestId) throw Error('The saved result belongs to another request.');

  const projected = await host.message(binding.sessionId, id);
  if (projected) {
    if (!match(projected)) throw Error('The receipt ID is already used by different session content.');
    const receipt = await runtime.receipt(binding.draftId);
    if (!receipt.ok) throw Error(receipt.message || 'The Runtime receipt is still pending.');
    return 'received';
  }
  const queued = await host.pending(binding.sessionId, id);
  if (queued) {
    if (!match(queued)) throw Error('The receipt ID is already used by different queued content.');
    return 'queued';
  }

  if (binding.status === 'queued') return 'queued';
  const admitted = await host.post({
    sessionID: binding.sessionId,
    id,
    text: opinionText(opinion, binding.replyId),
    description: 'ZESIA Consult',
    metadata: { source: 'zesia-consult', zesiaRequestId: binding.requestId, openCodeReplyId: binding.replyId },
    delivery: 'queue',
    resume: false,
  });
  if (!match(admitted) || admitted.sessionID !== binding.sessionId) {
    throw Error('Could not verify admission of the opinion into the original session.');
  }
  return 'queued';
}
