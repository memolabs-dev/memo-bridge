// Telegram bot of the operator surface (Phase 6, TODO-P6-11, spec D5, D6, AC-P6-04, AC-P6-05).
//
// One purpose, one fixed owner: the bot sends approval requests to the owner's private chat and
// takes commands from that chat only: /freeze, /unfreeze, /status, and for standing approvals
// (repatriation D-R4) /grant <host> <prog,prog> <cwd>[,<cwd>] [<hours>h], /approvals, /revoke <id>|all. Every update from any
// other chat or user is ignored (counted, never read further). No tool sends a message, no tool
// names a recipient, and the model cannot freeze or unfreeze anything.
//
// Telegram Bot API (https://core.telegram.org/bots/api, read 2026-10-14):
//  - requests are made to https://api.telegram.org/bot<token>/METHOD_NAME; the response is a
//    JSON object that "always has a Boolean field 'ok'", the data in "result", an optional
//    "description" on error;
//  - getUpdates: offset is the "Identifier of the first update to be returned", and "An update
//    is considered confirmed as soon as getUpdates is called with an offset higher than its
//    update_id"; timeout is the long-polling timeout in seconds; allowed_updates lists the
//    update types wanted (here message and callback_query); it does not work with a webhook set;
//  - sendMessage: chat_id, text ("1-4096 characters after entities parsing"), reply_markup;
//  - InlineKeyboardMarkup.inline_keyboard: "Array of button rows"; InlineKeyboardButton.text and
//    callback_data, "Data to be sent in a callback query to the bot when the button is pressed,
//    1-64 bytes";
//  - CallbackQuery: id, from ("Sender"), message ("Message sent by the bot with the callback
//    button that originated the query"), data;
//  - answerCallbackQuery: callback_query_id, text (0-200 characters); editMessageText: chat_id,
//    message_id, text.
// The token comes from a systemd credential file (`telegram-bot`, LoadCredential=, read like
// server/coordinator/credentials.mjs). It is only ever part of the request URL: never logged,
// never in an error message, never in an argument.
import { credentialPath, readCredentialFile } from '../server/coordinator/credentials.mjs';
import { redactSecrets } from './operator-output.mjs';

export const TELEGRAM_CREDENTIAL = 'telegram-bot';
export const BOT_TOKEN_RE = /^\d{5,16}:[A-Za-z0-9_-]{30,80}$/;
const CHAT_ID_RE = /^-?\d{1,20}$/;
const MAX_TEXT = 4000;

// {token} or {error}; the error never contains the file content.
export async function readTelegramToken(env = process.env) {
  const path = credentialPath(env, TELEGRAM_CREDENTIAL);
  if (!path) return { error: 'credential_missing' };
  const read = await readCredentialFile(path);
  if (read.error) return read;
  const token = read.text.trim();
  return BOT_TOKEN_RE.test(token) ? { token } : { error: 'credential_invalid' };
}

export const parseChatId = value => (typeof value === 'string' && CHAT_ID_RE.test(value) ? Number(value) : null);

// The HTTP client. fetchImpl is injectable; errors carry the method and status only.
export function createTelegramClient({ token, fetchImpl = fetch, apiBase = 'https://api.telegram.org', timeoutMs = 45_000 } = {}) {
  if (!BOT_TOKEN_RE.test(String(token))) throw new Error('telegram token invalid');
  async function call(method, params) {
    let response;
    try {
      response = await fetchImpl(`${apiBase}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params), signal: AbortSignal.timeout(timeoutMs) });
    } catch { throw new Error(`telegram_unreachable:${method}`); }
    let body;
    try { body = await response.json(); } catch { throw new Error(`telegram_bad_response:${method}`); }
    if (!body?.ok) throw new Error(`telegram_error:${method}:${response.status}`);
    return body.result;
  }
  return Object.freeze({
    sendMessage: p => call('sendMessage', p),
    getUpdates: p => call('getUpdates', p),
    answerCallbackQuery: p => call('answerCallbackQuery', p),
    editMessageText: p => call('editMessageText', p)
  });
}

const DECISIONS = Object.freeze({ a: 'approve', d: 'deny', s: 'standing' });

// The bot. client: createTelegramClient (or a fake). ownerChatId: the owner's private chat id
// (= his Telegram user id). approvals: createApprovalStore. hub hooks:
//   freeze(by), unfreeze(by): the hub's owner-only setters (unfreeze also clears the agents'
//   auto-freeze through the signed internal op), status(): text for /status.
// "/grant mac git,node,pnpm ~/memolabs,~/work 8h" -> the arguments of grants.grantByOwner, or null.
export function parseGrantCommand(text) {
  const parts = String(text ?? '').trim().split(/\s+/);
  if (parts.length < 4 || parts.length > 5) return null;
  const [, host, programs, prefixes, ttl] = parts;
  const hours = ttl === undefined ? 8 : /^\d{1,2}h?$/.test(ttl) ? Number.parseInt(ttl, 10) : NaN;
  return { host, programs: programs.split(',').filter(Boolean), cwd_prefixes: prefixes.split(',').filter(Boolean), ttl_hours: hours };
}

const grantLine = g => `${g.grant_id} ${g.status} ${g.host}: ${g.programs.join(', ')} under ${g.cwd_prefixes.join(', ')}`
  + (g.expires_at ? ` until ${g.expires_at}` : ` (${g.ttl_hours} h once approved)`) + (g.principal !== 'owner' ? ` for ${g.principal}` : '');

export function createOperatorBot({ client, ownerChatId, approvals, grants = null, hub, log = () => {}, pollTimeoutS = 30, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  if (!Number.isSafeInteger(ownerChatId)) throw new Error('owner chat id required');
  let offset = 0;
  let stopped = false;
  let ignored = 0;
  const fromOwner = (chat, from) => chat?.id === ownerChatId && from?.id === ownerChatId;

  async function handleUpdate(update) {
    if (Number.isInteger(update?.update_id)) offset = Math.max(offset, update.update_id + 1);
    const msg = update?.message;
    const cb = update?.callback_query;
    if (msg) {
      if (!fromOwner(msg.chat, msg.from)) { ignored++; log('telegram_update_ignored', {}); return; }
      const command = String(msg.text ?? '').trim().split(/\s+/)[0].replace(/@.*$/, '');
      if (command === '/freeze') { await hub.freeze('telegram'); await reply('Operator access frozen above T0.'); }
      else if (command === '/unfreeze') { const r = await hub.unfreeze('telegram'); await reply(`Operator access unfrozen. ${r ?? ''}`.trim()); }
      else if (command === '/status') await reply(String(await hub.status()));
      else if (command === '/grant' && grants) {
        const args = parseGrantCommand(msg.text);
        const out = args ? grants.grantByOwner(args, 'telegram') : { ok: false, error: 'usage' };
        log('operator_grant_owner', { ok: out.ok, error: out.ok ? null : out.error });
        await reply(out.ok ? `Standing approval active.\n${grantLine(grants.get(out.grant.id))}`
          : `Not granted: ${out.error}${out.detail ? ` (${out.detail})` : ''}${out.program ? ` ${out.program}` : ''}.\nUsage: /grant mac git,node,pnpm ~/memolabs 8h`);
      } else if (command === '/approvals' && grants) {
        const list = grants.list();
        await reply(list.length ? `Standing approvals:\n${list.map(grantLine).join('\n')}` : 'No standing approval.');
      } else if (command === '/revoke' && grants) {
        const target = String(msg.text ?? '').trim().split(/\s+/)[1] ?? '';
        if (target === 'all') { const n = grants.revokeAll(); log('operator_grant_revoked', { count: n }); await reply(`Revoked ${n} standing approval(s).`); }
        else {
          const out = grants.revoke(target);
          log('operator_grant_revoked', { ok: out.ok });
          await reply(out.ok ? `Revoked ${target}.` : `Not revoked: ${out.error}. Usage: /revoke <id> or /revoke all`);
        }
      }
      return;
    }
    if (cb) {
      if (!fromOwner(cb.message?.chat, cb.from)) { ignored++; log('telegram_update_ignored', {}); return; }
      const sg = /^sg:([ad]):(ap_st_[A-Za-z0-9_-]{16,34})$/.exec(String(cb.data ?? ''));
      if (sg && grants) {
        const decision = sg[1] === 'a' ? 'approve' : 'deny';
        const out = grants.decide(sg[2], decision, 'telegram');
        log('operator_grant_decided', { grant_id: sg[2], decision, ok: out.ok });
        await client.answerCallbackQuery({ callback_query_id: cb.id, text: out.ok ? `Done: ${decision}` : out.error });
        if (out.ok && cb.message?.message_id) {
          await client.editMessageText({ chat_id: ownerChatId, message_id: cb.message.message_id,
            text: `${String(cb.message.text ?? '').slice(0, 3000)}\n\nDecision: ${decision}` }).catch(() => {});
        }
        return;
      }
      const m = /^ap:([ads]):(ap_[A-Za-z0-9_-]{16,40})$/.exec(String(cb.data ?? ''));
      if (!m) { await client.answerCallbackQuery({ callback_query_id: cb.id, text: 'Unknown action' }); return; }
      const decision = DECISIONS[m[1]];
      const out = approvals.decide(m[2], decision, 'telegram');
      log('operator_approval_decided', { approval_id: m[2], decision, ok: out.ok });
      await client.answerCallbackQuery({ callback_query_id: cb.id, text: out.ok ? `Done: ${decision}` : out.error });
      if (out.ok && cb.message?.message_id) {
        await client.editMessageText({ chat_id: ownerChatId, message_id: cb.message.message_id,
          text: `${String(cb.message.text ?? '').slice(0, 3000)}\n\nDecision: ${decision}` }).catch(() => {});
      }
    }
  }
  const reply = text => client.sendMessage({ chat_id: ownerChatId, text: text.slice(0, MAX_TEXT) });

  return Object.freeze({
    handleUpdate,
    get ignored() { return ignored; },
    // Ask the owner. summary: {host, op, principal, args (journal form), args_sha256, reason, expires_at}.
    async notifyApproval(approval, summary) {
      const text = redactSecrets([
        'Memo Bridge operator approval',
        `host: ${summary.host}   op: ${summary.op}   reason: ${summary.reason}`,
        `principal: ${summary.principal}`,
        `args: ${JSON.stringify(summary.args).slice(0, 1500)}`,
        `args sha256: ${summary.args_sha256.slice(0, 16)}...`,
        `expires: ${summary.expires_at}`
      ].join('\n')).text.slice(0, MAX_TEXT);
      await client.sendMessage({ chat_id: ownerChatId, text, reply_markup: { inline_keyboard: [
        [{ text: 'Approve', callback_data: `ap:a:${approval.id}` }, { text: 'Deny', callback_data: `ap:d:${approval.id}` }],
        [{ text: 'Approve this exact call for 15 min', callback_data: `ap:s:${approval.id}` }]
      ] } });
    },
    // Ask the owner for a standing approval (D-R4). grant: operator-grants.mjs view.
    async notifyGrant(grant, { principal }) {
      const wrappers = grant.programs.filter(p => !['gh', 'rsync', 'scp', 'sftp', 'ssh', 'mosh'].includes(p));
      const text = redactSecrets([
        'Memo Bridge standing approval request',
        `host: ${grant.host}   for ${grant.ttl_hours} h once approved`,
        `programs: ${grant.programs.join(', ')}`,
        `cwd under: ${grant.cwd_prefixes.join(', ')}`,
        `principal: ${principal}`,
        ...(grant.reason ? [`reason: ${grant.reason}`] : []),
        '',
        `While active these run without asking: ${wrappers.length ? `${wrappers.join(', ')} can run ANY command as the agent user. ` : ''}`
          + `${grant.programs.includes('ssh') || grant.programs.includes('scp') ? 'ssh and scp to lab act as ROOT on lab. ' : ''}`
          + 'rm, disks, sudoers, gh pr merge, force push, reset --hard and root calls still ask every time.',
        `Revoke any time: /revoke ${grant.grant_id}`
      ].join('\n')).text.slice(0, MAX_TEXT);
      await client.sendMessage({ chat_id: ownerChatId, text, reply_markup: { inline_keyboard: [
        [{ text: 'Approve', callback_data: `sg:a:${grant.grant_id}` }, { text: 'Deny', callback_data: `sg:d:${grant.grant_id}` }]
      ] } });
    },
    async pollOnce() {
      const updates = await client.getUpdates({ offset, timeout: pollTimeoutS, allowed_updates: ['message', 'callback_query'] });
      for (const update of Array.isArray(updates) ? updates : []) {
        try { await handleUpdate(update); } catch { log('telegram_update_failed', {}); }
      }
      return Array.isArray(updates) ? updates.length : 0;
    },
    async run() {
      let failures = 0;
      while (!stopped) {
        try { await this.pollOnce(); failures = 0; } catch (error) {
          failures++;
          log('telegram_poll_failed', { reason: String(error?.message ?? 'error').split(':').slice(0, 2).join(':') });
          await sleep(Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)));
        }
      }
    },
    stop() { stopped = true; }
  });
}
