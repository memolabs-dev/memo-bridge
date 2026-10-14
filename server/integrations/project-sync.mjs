// One-way sync from the Coordinator to a GitHub Projects (v2) board, for example the org
// project "Memo Labs OS". The source of truth stays the Issues and the lease ledger: the board
// is only a view of them, written after the fact and never read back.
//
// Off unless MEMO_BRIDGE_PROJECT=owner/number is set. Every hook is fire and forget: the
// Coordinator operation never waits for it, a bounded timeout stops it, and a failure is
// reported to the caller's onFailure(code) with a short fixed code (journaled by the caller as
// project_sync_failed). Nothing from GitHub's answers, and never a token, reaches the journal.
//
// GitHub GraphQL, as documented in "Using the API to manage Projects"
// (https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects):
// - field and option ids are read with organization(login){projectV2(number){fields{...}}},
//   `... on ProjectV2SingleSelectField { options { id name } }`; they are cached here, never
//   hard-coded;
// - addProjectV2ItemById(projectId, contentId) adds an Issue or a pull request and returns the
//   existing item when it is already there;
// - updateProjectV2ItemFieldValue sets one field: {singleSelectOptionId} or {text};
// - an item cannot be added and updated in the same call, so add comes first, then one update
//   per field;
// - mutations need a token with the `project` scope (the operator's gh login).
import { ghGraphql } from './github.mjs';
import { parseIssueRef } from '../coordinator/issue-lease.mjs';

export const PROJECT_ENV = 'MEMO_BRIDGE_PROJECT';
export const FIELDS = Object.freeze({ status: 'Status', priority: 'Priorité', agent: 'Agent', lot: 'Lot' });
export const STATUS = Object.freeze({ ready: 'Prêt', claimed: 'Réservé', review: 'En revue', blocked: 'Bloqué', done: 'Fait' });
// Workspace client_type -> Agent option. Anything else (codex, cli, other, ...) is a person.
export const AGENTS = Object.freeze({ chatgpt: 'ChatGPT', 'claude-code': 'Claude Code', opencode: 'opencode', runner: 'Runner VPS' });
export const DEFAULT_AGENT = 'Humain';
export const SYNC_LIMITS = Object.freeze({ callMs: 10_000, hookMs: 30_000, fieldsCacheMs: 10 * 60_000, pending: 200, cache: 2000 });

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const NUMBER_RE = /^[1-9][0-9]{0,8}$/;
const NODE_ID_RE = /^[A-Za-z0-9_-]{4,100}$/;
const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const LOT_MAX = 120;

// "owner/number" -> { owner, number } or null.
export function parseProjectSpec(value) {
  if (typeof value !== 'string') return null;
  const [owner, number, extra] = value.trim().split('/');
  if (extra !== undefined || !OWNER_RE.test(owner ?? '') || !NUMBER_RE.test(number ?? '')) return null;
  return { owner, number: Number(number) };
}

export const agentFor = clientType => AGENTS[clientType] ?? DEFAULT_AGENT;
// 'p1' or 'priority:p1' -> 'P1'; anything else -> null.
export function priorityOption(priority) {
  const m = /^(?:priority:)?p([0-9])$/i.exec(String(priority ?? ''));
  return m ? `P${m[1]}` : null;
}
// The Lot text of a batch: its id, after its name when it has one.
export function lotText(batch, name = null) {
  if (typeof batch !== 'string' || !batch) return null;
  const text = name ? `${name} (${batch})` : batch;
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, LOT_MAX);
}
// Field and option names are compared without case, accents in NFC form.
const key = name => String(name ?? '').normalize('NFC').trim().toLowerCase();

class SyncError extends Error {
  constructor(code) { super(code); this.code = CODE_RE.test(code) ? code : 'project_sync_error'; }
}

const PROJECT_QUERY = `query($login: String!, $number: Int!) {
  OWNER(login: $login) { projectV2(number: $number) { id url
    fields(first: 50) { nodes { __typename
      ... on ProjectV2FieldCommon { id name dataType }
      ... on ProjectV2SingleSelectField { options { id name } } } } } } }`;
const CONTENT_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) {
    __typename ... on Issue { id } ... on PullRequest { id } } } }`;
const ADD_MUTATION = `mutation($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }`;
const SELECT_MUTATION = `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field,
    value: { singleSelectOptionId: $option } }) { projectV2Item { id } } }`;
const TEXT_MUTATION = `mutation($project: ID!, $item: ID!, $field: ID!, $text: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field,
    value: { text: $text } }) { projectV2Item { id } } }`;

// A sync that does nothing: what every caller gets when MEMO_BRIDGE_PROJECT is unset.
function disabledSync(error = null) {
  const noop = () => Promise.resolve();
  return Object.freeze({ enabled: false, error, url: () => null, idle: noop,
    taskCreated: noop, taskClaimed: noop, taskReview: noop, taskReleased: noop, taskStale: noop });
}

// options.graphql(query, variables, {timeoutMs}) -> {ok, data} | {ok: false, error}: injected
// in tests; the default runs `gh api graphql` under the operator's gh login.
export function createProjectSync({ spec, env = process.env, graphql = ghGraphql, limits = {}, now = Date.now } = {}) {
  const raw = spec !== undefined ? spec : env?.[PROJECT_ENV];
  if (raw === undefined || raw === null || raw === '') return disabledSync();
  const project = parseProjectSpec(raw);
  if (!project) return disabledSync('invalid_project_spec');
  const L = { ...SYNC_LIMITS, ...limits };

  let fields = null; // { at, projectId, url, byName: Map(key -> { id, options: Map(key -> id) | null }) }
  let fieldsLoading = null;
  let knownUrl = null; // the board URL GitHub reported, kept when the field cache is dropped
  const contentIds = new Map(); // owner/repo#n -> node id
  const itemIds = new Map(); // node id -> project item id
  const staleSeen = new Map(); // issue ref -> the expired lease already shown as Prêt
  const chains = new Map(); // issue ref -> tail of its hook chain (hooks of one Issue run in order)
  const pending = new Set();
  const remember = (map, k, v) => {
    if (map.size >= L.cache) map.delete(map.keys().next().value);
    map.set(k, v);
  };

  async function call(query, variables) {
    let out;
    try { out = await graphql(query, variables, { timeoutMs: L.callMs }); } catch { throw new SyncError('github_unavailable'); }
    if (!out?.ok) throw new SyncError(typeof out?.error === 'string' ? out.error : 'github_unavailable');
    return out.data ?? {};
  }

  async function loadFields() {
    let node = null;
    for (const owner of ['organization', 'user']) {
      let data;
      try { data = await call(PROJECT_QUERY.replace('OWNER', owner), { login: project.owner, number: project.number }); }
      catch (error) { if (error.code === 'github_not_found') continue; throw error; }
      node = data?.[owner]?.projectV2 ?? null;
      if (node) break;
    }
    if (!node || !NODE_ID_RE.test(node.id ?? '')) throw new SyncError('project_not_found');
    const byName = new Map();
    for (const f of Array.isArray(node.fields?.nodes) ? node.fields.nodes : []) {
      if (!f || !NODE_ID_RE.test(f.id ?? '') || typeof f.name !== 'string') continue;
      const options = Array.isArray(f.options)
        ? new Map(f.options.filter(o => typeof o?.id === 'string' && typeof o?.name === 'string').map(o => [key(o.name), o.id]))
        : null;
      byName.set(key(f.name), { id: f.id, dataType: f.dataType ?? null, options });
    }
    const url = typeof node.url === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9/_-]{1,200}$/.test(node.url) ? node.url : null;
    return { at: now(), projectId: node.id, url, byName };
  }

  // Field ids, read once and cached; a concurrent hook waits for the same read.
  async function projectFields() {
    if (fields && now() - fields.at < L.fieldsCacheMs) return fields;
    fieldsLoading ??= loadFields().then(f => { fields = f; knownUrl = f.url ?? knownUrl; return f; })
      .finally(() => { fieldsLoading = null; });
    return fieldsLoading;
  }

  async function contentId(repoFull, number) {
    const ref = `${repoFull}#${number}`;
    if (contentIds.has(ref)) return contentIds.get(ref);
    const [owner, name] = repoFull.split('/');
    const data = await call(CONTENT_QUERY, { owner, name, number: Number(number) });
    const id = data?.repository?.issueOrPullRequest?.id;
    if (!NODE_ID_RE.test(id ?? '')) throw new SyncError('content_not_found');
    remember(contentIds, ref, id);
    return id;
  }

  async function itemFor(f, content) {
    if (itemIds.has(content)) return itemIds.get(content);
    const data = await call(ADD_MUTATION, { project: f.projectId, content });
    const id = data?.addProjectV2ItemById?.item?.id;
    if (!NODE_ID_RE.test(id ?? '')) throw new SyncError('item_not_added');
    remember(itemIds, content, id);
    return id;
  }

  async function setSelect(f, item, fieldName, optionName) {
    const field = f.byName.get(key(fieldName));
    if (!field?.options) throw new SyncError('project_field_missing');
    const option = field.options.get(key(optionName));
    if (!option) throw new SyncError('project_option_missing');
    await call(SELECT_MUTATION, { project: f.projectId, item, field: field.id, option });
  }

  async function setText(f, item, fieldName, text) {
    const field = f.byName.get(key(fieldName));
    if (!field || field.options) throw new SyncError('project_field_missing');
    await call(TEXT_MUTATION, { project: f.projectId, item, field: field.id, text });
  }

  // Add the content (Issue or pull request) to the board, then set each field in order.
  // `updates`: [[fieldName, value, 'select' | 'text']].
  // `run.stopped` is set when the hook timed out: no further write is sent, so a late call
  // can never land after the next hook of the same Issue.
  async function apply(repoFull, number, updates, run = {}) {
    const go = () => { if (run.stopped) throw new SyncError('project_sync_timeout'); };
    const f = await projectFields();
    const content = await contentId(repoFull, number);
    go();
    const item = await itemFor(f, content);
    try {
      for (const [field, value, kind] of updates) {
        go();
        if (kind === 'text') await setText(f, item, field, value);
        else await setSelect(f, item, field, value);
      }
    } catch (error) {
      // The item may have been removed from the board, or a field renamed: read both again
      // next time rather than repeating a stale id.
      itemIds.delete(content);
      fields = null;
      throw error;
    }
  }

  // Run one hook in the background: in order after the previous hooks of the same Issue,
  // bounded in time, never throwing. The returned promise is for tests (idle()).
  function fire(ref, work, onFailure) {
    const report = code => { try { Promise.resolve(onFailure?.(CODE_RE.test(code) ? code : 'project_sync_error')).catch(() => {}); } catch { /* never */ } };
    if (pending.size >= L.pending) { report('project_sync_overloaded'); return Promise.resolve(); }
    const previous = chains.get(ref) ?? Promise.resolve();
    const run = previous.then(() => {
      let timer;
      const state = { stopped: false };
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { state.stopped = true; reject(new SyncError('project_sync_timeout')); }, L.hookMs);
      });
      return Promise.race([work(state), timeout]).finally(() => clearTimeout(timer));
    }).catch(error => report(error instanceof SyncError ? error.code : 'project_sync_error'));
    chains.set(ref, run);
    pending.add(run);
    run.finally(() => { pending.delete(run); if (chains.get(ref) === run) chains.delete(ref); });
    return run;
  }

  const issueOf = ref => parseIssueRef(ref);
  const setStatus = (issue, status, extra = []) => run => apply(issue.repo, issue.number, [[FIELDS.status, status], ...extra], run);

  return Object.freeze({
    enabled: true,
    error: null,
    // The board's address: the one GitHub reported, else the organization project URL.
    url: () => knownUrl ?? `https://github.com/orgs/${project.owner}/projects/${project.number}`,
    // Resolves once every hook fired so far has finished (tests, shutdown).
    idle: async () => { while (pending.size) await Promise.allSettled([...pending]); },

    // A task Issue was created: Prêt, its priority, its batch.
    taskCreated({ issue, priority = null, batch = null, name = null } = {}, { onFailure } = {}) {
      const parsed = issueOf(issue);
      if (!parsed) return Promise.resolve();
      const extra = [];
      const p = priorityOption(priority);
      if (p) extra.push([FIELDS.priority, p]);
      const lot = lotText(batch, name);
      if (lot) extra.push([FIELDS.lot, lot, 'text']);
      return fire(parsed.ref, setStatus(parsed, STATUS.ready, extra), onFailure);
    },

    // A task was claimed (task_claim, task_next, or the takeover of an expired lease).
    taskClaimed({ issue, clientType = null } = {}, { onFailure } = {}) {
      const parsed = issueOf(issue);
      if (!parsed) return Promise.resolve();
      return fire(parsed.ref, setStatus(parsed, STATUS.claimed, [[FIELDS.agent, agentFor(clientType)]]), onFailure);
    },

    // A pull request was opened (or found open) for the task: both items go to En revue.
    taskReview({ issue, repo = null, pull = null } = {}, { onFailure } = {}) {
      const parsed = issueOf(issue);
      if (!parsed) return Promise.resolve();
      return fire(parsed.ref, async run => {
        await setStatus(parsed, STATUS.review)(run);
        if (typeof repo === 'string' && Number.isInteger(pull) && pull > 0) {
          await apply(repo, pull, [[FIELDS.status, STATUS.review]], run);
        }
      }, onFailure);
    },

    // A claim was given back: Fait when completed, Bloqué when blocked, else Prêt again.
    taskReleased({ issue, outcome } = {}, { onFailure } = {}) {
      const parsed = issueOf(issue);
      if (!parsed) return Promise.resolve();
      const status = outcome === 'completed' ? STATUS.done : outcome === 'blocked' ? STATUS.blocked : STATUS.ready;
      return fire(parsed.ref, setStatus(parsed, status), onFailure);
    },

    // A lease seen expired (claimed, nobody renewing it, so anyone may take it over): Prêt.
    // `lease` names the expired lease (worker and expiry): each one is written once per
    // process, however often batch_status sees it; the next claim sets Réservé again.
    taskStale({ issue, lease = null } = {}, { onFailure } = {}) {
      const parsed = issueOf(issue);
      if (!parsed) return Promise.resolve();
      const seen = typeof lease === 'string' && lease ? lease : null;
      if (seen && staleSeen.get(parsed.ref) === seen) return Promise.resolve();
      if (seen) remember(staleSeen, parsed.ref, seen);
      return fire(parsed.ref, setStatus(parsed, STATUS.ready), code => {
        if (seen && staleSeen.get(parsed.ref) === seen) staleSeen.delete(parsed.ref);
        return onFailure?.(code);
      });
    }
  });
}
