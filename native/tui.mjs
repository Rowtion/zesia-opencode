import { Plugin } from '@opencode/plugin/tui';
import { basename, isAbsolute } from 'node:path';
import { expiredBeforeApproval, makeRuntime, opinionText, replyText, selectedReplyPacket, updateHandback } from './session-consult.mjs';

const pollingWindow = 20 * 60 * 1000;
const terminal = new Set(['received', 'cancelled', 'expired', 'failed']);
const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);
function isLocalSessionLaunch(args) {
  if (args.includes('attach') || args.some(arg => arg === '--attach' || arg.startsWith('--attach='))) return false;
  const serverIndex = args.indexOf('--server');
  const server = serverIndex < 0 ? args.find(arg => arg.startsWith('--server='))?.slice(9) : args[serverIndex + 1];
  if (!server) return serverIndex < 0;
  try { return loopback.has(new URL(server).hostname); }
  catch { return false; }
}

export default Plugin.define({
  id: 'zesia.consult.tui',
  setup(context) {
    if (!isLocalSessionLaunch(process.argv)) return;
    const runtime = makeRuntime();
    const { session } = context.data;
    const host = {
      async message(sessionId, id) {
        await session.message.sync(sessionId);
        return session.message.get(sessionId, id);
      },
      async pending(sessionId, id) {
        await session.pending.sync(sessionId);
        return session.pending.list(sessionId).find(message => message.id === id);
      },
      async post(input) {
        const result = await context.client.session.synthetic(input);
        return result.data;
      },
    };
    const [saved, update] = context.storage.store('consults', { initial: { bindings: {} } });
    const opening = new Set();
    const polling = new Set();
    let closed = false;
    const active = () => {
      const route = context.ui.router.current();
      return route.type === 'session' ? route.sessionID : undefined;
    };
    const notify = (message, sessionID, variant = 'info') =>
      context.ui.toast.show({ title: 'ZESIA', message, sessionID, variant });
    const report = (error, sessionId) => notify(error.message || 'ZESIA could not check this consultation.', sessionId, 'error');

    async function check(binding) {
      if (closed || terminal.has(binding.status) || polling.has(binding.draftId)) return;
      polling.add(binding.draftId);
      try {
        const status = await updateHandback({ binding, runtime, host });
        if (closed || status === binding.status) return;
        await update(draft => {
          if (draft.bindings[binding.draftId]) draft.bindings[binding.draftId].status = status;
        });
        if (status === 'queued') notify('Opinion saved in the original session. Use /zesia-result to read it before the next turn.', binding.sessionId);
        if (status === 'received') notify('Opinion returned to the original session.', binding.sessionId, 'success');
        if (status === 'cancelled') notify('Consultation cancelled before sending.', binding.sessionId);
        if (status === 'expired' || status === 'failed') notify('Consultation ' + status + '.', binding.sessionId, 'warning');
      } finally {
        polling.delete(binding.draftId);
      }
    }
    function tick() {
      for (const binding of Object.values(saved.bindings)) {
        if (binding.until > Date.now() && !terminal.has(binding.status)) {
          // Keep background recovery quiet. The original session can inspect an error with /zesia-result.
          void check(binding).catch(() => {});
        }
      }
    }

    async function reviewReply(input) {
      const sessionId = active();
      if (!sessionId || opening.has(sessionId)) return;
      opening.add(sessionId);
      try {
        await session.sync(sessionId);
        const directory = session.get(sessionId)?.location?.directory;
        if (typeof directory !== 'string' || !isAbsolute(directory)) throw Error('Open a local workspace session to use ZESIA.');
        await session.message.sync(sessionId);
        if (closed || active() !== sessionId) return;
        let replyId = input?.trim();
        if (!replyId) {
          const options = session.message.list(sessionId).filter(replyText).reverse().map(message => ({
            value: message.id, title: replyText(message).replace(/\s+/g, ' ').slice(0, 90), description: message.id,
          }));
          if (!options.length) throw Error('No completed assistant replies in this conversation.');
          replyId = await context.ui.dialog.select({ title: 'Which reply should ZESIA review?', options });
          if (!replyId) return;
        }
        if (closed || active() !== sessionId) return;
        const reply = session.message.get(sessionId, replyId);
        const packet = selectedReplyPacket(reply, basename(directory) || 'OpenCode workspace');
        const previous = Object.values(saved.bindings).find(binding =>
          binding.sessionId === sessionId && binding.replyId === replyId && !terminal.has(binding.status));
        if (previous) {
          const status = await runtime.result(previous.draftId);
          if (expiredBeforeApproval(status.status, previous.expiresAt)) {
            await update(state => { state.bindings[previous.draftId].status = 'expired'; });
          } else {
            if (status.status === 'prepared') await openReview(previous);
            else {
              await check(previous);
              notify('This reply already has a consultation. Use /zesia-result to check it.', sessionId);
            }
            return;
          }
        }
        const draft = await runtime.prepare(packet);
        const expiresAt = Date.parse(draft.expiresAt);
        if (!Number.isFinite(expiresAt)) throw Error('The Runtime did not return a draft expiry.');
        const binding = {
          sessionId, replyId, draftId: draft.draftId, requestId: draft.requestId, expiresAt,
          until: Date.now() + pollingWindow, status: 'waiting',
        };
        await update(state => { state.bindings[binding.draftId] = binding; });
        if (!closed) await openReview(binding);
      } catch (error) {
        report(error, sessionId);
      } finally {
        opening.delete(sessionId);
      }
    }
    async function openReview(binding) {
      const review = await runtime.review(binding.draftId);
      if (!review.ok) throw Error(review.message || 'The shared review could not open.');
      if (review.browserOpened) {
        notify('Review the selected reply in the ZESIA browser window.', binding.sessionId);
      } else if (active() === binding.sessionId && typeof review.url === 'string') {
        await context.ui.dialog.alert({ title: 'Open the private ZESIA review', message: review.url });
      } else {
        notify('ZESIA could not open the browser. Run /zesia again in the original session to reopen the same draft.', binding.sessionId);
      }
    }
    async function showResult() {
      const sessionId = active();
      const binding = Object.values(saved.bindings).filter(item => item.sessionId === sessionId).at(-1);
      if (!binding) return notify('No consultation in this session.', sessionId);
      try {
        await check(binding);
        const opinion = await runtime.result(binding.draftId);
        if (closed || active() !== sessionId) return;
        if (expiredBeforeApproval(opinion.status, binding.expiresAt)) {
          notify('The unapproved draft expired. Run /zesia to prepare an updated draft.', sessionId);
        } else if (opinion.status === 'completed' && opinion.ok) {
          await context.ui.dialog.alert({ title: 'ZESIA Consult', message: opinionText(opinion, binding.replyId) });
        } else {
          notify(opinion.message || 'Consultation status: ' + opinion.status, sessionId);
        }
      } catch (error) {
        report(error, sessionId);
      }
    }
    context.keymap.layer(() => ({
      mode: 'global',
      commands: [
        { id: 'zesia.review-reply', title: 'Review a reply with ZESIA', palette: true,
          slash: { name: 'zesia', arguments: true }, enabled: () => Boolean(active()), run: reviewReply },
        { id: 'zesia.result', title: 'Show ZESIA opinion in this session', palette: true,
          slash: { name: 'zesia-result' }, enabled: () => Boolean(active()), run: showResult },
      ],
    }));
    tick();
    const timer = setInterval(tick, 3000);
    timer.unref();
    return () => { closed = true; clearInterval(timer); };
  },
});
