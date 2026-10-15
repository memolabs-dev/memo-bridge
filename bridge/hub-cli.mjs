// Hub entry point (memo-bridge-hub.service). Secrets come from MEMO_BRIDGE_SECRETS:
//   tls.key, tls.crt, owner.token, mac.pub, vps.pub   (as before)
//   readonly.token                                     optional, read-only test bearer (spec D9, O-9)
//   operator-signing.key                               optional (Phase 6, spec D4): Ed25519 private key
//                                                      that signs every operator request. Absent: no
//                                                      operator tool is served, on either listener
//   operator-mac.pub, operator-vps.pub                 optional: identity keys of the operator agents
// Configuration (environment, set by the lab-infra unit and its drop-ins):
//   MEMO_BRIDGE_HUB_RUNTIME_HOST   'vps' to forward the runtime tools of the 9443 surface to that
//                                  agent (read ops; lab-infra drop-in 60-runtime-host.conf)
//   MEMO_BRIDGE_HUB_MUTATING_OPS   'owner' to also forward mutating ops for the owner principal on
//                                  9443. Leave unset until the AC-14 gate passes (TODO-P4-40,
//                                  docs/HUB_SECURITY.md). Any other value refuses to start.
//   MEMO_BRIDGE_REMOTE_CONFIG      absolute path of remote.json (Phase 5, decision D4; lab-infra
//                                  drop-in 70-remote.conf, /etc/memo-bridge/remote.json): opens the
//                                  public OIDC-only listener (default 127.0.0.1:9445, the Traefik
//                                  target of bridge.memolabs.dev). Unset: no public listener.
//                                  The runner reads the same file (bridge/write-gate.mjs).
//   MEMO_BRIDGE_OPERATOR_FREEZE_FILE  absolute path (Phase 6, spec D6), default
//                                  /etc/memo-bridge/operator-FROZEN: while it exists the hub refuses
//                                  every operator op above T0. Created and removed by the owner (root
//                                  directory); no tool can.
//   MEMO_BRIDGE_OPERATOR_APPROVAL  JSON {"vps": "dangerous", "mac": "dangerous"} (Phase 6, spec D5;
//                                  off | dangerous | all_root; default dangerous on both). Must be
//                                  at least as strict as each host's policy, or the host refuses
//                                  with approval_required.
//   MEMO_BRIDGE_TELEGRAM_CHAT_ID   the owner's Telegram user id (private chat with the bot). With
//                                  the `telegram-bot` credential ($CREDENTIALS_DIRECTORY, systemd
//                                  LoadCredential=) it starts the operator bot: approvals,
//                                  /freeze, /unfreeze, /status. Without them, dangerous calls answer
//                                  approval_unavailable (fail closed).
// A bad remote.json, or remote_writes "enabled" while a GitHub Actions runner runs as root
// (write gate layer 2, lab-infra #161), stops the unit before anything listens.
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { createHub } from './hub.mjs';
import { REMOTE_CONFIG_ENV } from './remote-config.mjs';
import { createRemoteService } from './remote-boot.mjs';
import { createOperatorBot, createTelegramClient, parseChatId, readTelegramToken } from './operator-telegram.mjs';

const env = process.env;
const dir = env.MEMO_BRIDGE_SECRETS;
if (!dir) throw new Error('MEMO_BRIDGE_SECRETS required');
// Removed in Phase 5: OAuth no longer switches the 9443 listener (decision D4).
if (env.MEMO_BRIDGE_OIDC_SETTINGS) throw new Error('MEMO_BRIDGE_OIDC_SETTINGS is no longer supported: use ' + REMOTE_CONFIG_ENV);
const get = file => readFileSync(dir + '/' + file, 'utf8');
const digest = value => createHash('sha256').update(value).digest('hex');
const tlsKey = get('tls.key'), tlsCert = get('tls.crt');
const tokenSha256 = digest(get('owner.token').trim());
const readOnlyToken = existsSync(dir + '/readonly.token') ? get('readonly.token').trim() : '';
const readOnlyTokenSha256 = readOnlyToken ? digest(readOnlyToken) : null;
const runtimeHost = env.MEMO_BRIDGE_HUB_RUNTIME_HOST || null;
const mutatingRaw = env.MEMO_BRIDGE_HUB_MUTATING_OPS;
if (mutatingRaw !== undefined && mutatingRaw !== '' && mutatingRaw !== 'owner') throw new Error('MEMO_BRIDGE_HUB_MUTATING_OPS must be "owner" or unset');
const mutatingOps = mutatingRaw === 'owner' ? 'owner' : false;
const audit = ev => console.error(JSON.stringify(ev));

const allowedAgentKeys = { mac: get('mac.pub'), vps: get('vps.pub') };
for (const id of ['operator-mac', 'operator-vps']) if (existsSync(`${dir}/${id}.pub`)) allowedAgentKeys[id] = get(`${id}.pub`);
const freezeFile = env.MEMO_BRIDGE_OPERATOR_FREEZE_FILE || '/etc/memo-bridge/operator-FROZEN';
if (!isAbsolute(freezeFile)) throw new Error('MEMO_BRIDGE_OPERATOR_FREEZE_FILE must be an absolute path');
const approvalModes = env.MEMO_BRIDGE_OPERATOR_APPROVAL ? JSON.parse(env.MEMO_BRIDGE_OPERATOR_APPROVAL) : undefined;
// Repatriation D-R14: the project a conversation's workspace is opened on when an operator call
// arrives without one (default "ops").
const autoWorkspaceProject = env.MEMO_BRIDGE_OPERATOR_AUTO_PROJECT || 'ops';
const operator = existsSync(`${dir}/operator-signing.key`) ? { signingKeyPem: get('operator-signing.key'), freezeFile, approvalModes, autoWorkspaceProject } : null;
const hub = createHub({ tlsKey, tlsCert, tokenSha256, readOnlyTokenSha256, allowedAgentKeys, runtimeHost, mutatingOps, audit, operator });

// Built before the hub starts: the public listener gets the TLS pair, remote.json and the hub's
// requestAgent only, never the bearer digests or the agent keys.
const remotePath = env[REMOTE_CONFIG_ENV];
let publicListener = null;
if (remotePath) {
  if (!isAbsolute(remotePath)) throw new Error(REMOTE_CONFIG_ENV + ' must be an absolute path');
  publicListener = await createRemoteService({ raw: JSON.parse(readFileSync(remotePath, 'utf8')), tlsKey, tlsCert,
    requestAgent: hub.requestAgent, requestOperator: hub.requestOperator, audit });
}

// The operator bot: only with the operator key, the owner chat id and the token credential.
let bot = null;
if (operator && env.MEMO_BRIDGE_TELEGRAM_CHAT_ID) {
  const ownerChatId = parseChatId(env.MEMO_BRIDGE_TELEGRAM_CHAT_ID);
  if (ownerChatId === null) throw new Error('MEMO_BRIDGE_TELEGRAM_CHAT_ID must be a numeric chat id');
  const token = await readTelegramToken(env);
  if (token.error) throw new Error(`telegram-bot credential ${token.error}`);
  bot = createOperatorBot({ client: createTelegramClient({ token: token.token }), ownerChatId, approvals: hub.operatorApprovals, grants: hub.operatorGrants,
    log: (event, details) => audit({ at: new Date().toISOString(), event, ...details }),
    hub: {
      freeze: by => hub.setOperatorFrozen(true, by),
      unfreeze: async by => JSON.stringify(await hub.ownerUnfreeze(by)),
      status: () => `frozen above T0: ${hub.operatorFrozen()}; pending approvals: ${hub.operatorApprovals.pending}`
    } });
  hub.attachOperatorBot(bot);
}

await hub.start();
bot?.run();
audit({ event: 'hub_started', bind: '127.0.0.1:9443', runtime_host: runtimeHost, mutating_ops: mutatingOps || 'disabled',
  readonly_principal: Boolean(readOnlyTokenSha256), operator_key: hub.operatorKeyId, operator_bot: Boolean(bot),
  operator_agents: ['operator-mac', 'operator-vps'].filter(id => Object.hasOwn(allowedAgentKeys, id)) });
if (publicListener) {
  const address = await publicListener.start();
  audit({ event: 'public_listener_started', bind: address.address + ':' + address.port, resource: publicListener.verifier.resource,
    remote_enabled: publicListener.remoteEnabled, remote_writes: publicListener.remoteWrites,
    client_cert: publicListener.clientCertMode });
}
process.on('SIGTERM', async () => { await publicListener?.stop(); await hub.stop(); process.exit(0); });
