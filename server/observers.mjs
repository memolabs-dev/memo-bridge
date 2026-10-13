// Read-only views of the observers that already watch the Mac and the VPS. Memo Bridge reads
// their latest outputs instead of probing hosts itself (Vault 1-Projects/memo-labs-os.md):
// - infrastructure-guardian reports (guardian.report/v1);
// - agents-observe (VPS agent workflows, synced into the Vault);
// - LIVE-STATE, operational sections only;
// - Stasis focus.
// Every result says where it came from, when it was produced and whether it is stale.
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { projectInfo } from './catalog.mjs';

const MAX_BYTES = 1024 * 1024;
const TEXT_MAX = 300;
const unavailable = (source, detail) => ({ ok: false, error: 'source_unavailable', source, ...(detail ? { detail } : {}) });

// Strip control and bidirectional characters, then bound: this text is read back by models.
function text(value, max = TEXT_MAX) {
  if (typeof value !== 'string') return null;
  return value.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function freshness(generatedAt, maxAgeMinutes, now) {
  const at = Date.parse(generatedAt ?? '');
  if (Number.isNaN(at)) return { generated_at: null, age_minutes: null, stale: true };
  const age = Math.max(0, Math.round((now() - at) / 60000));
  return { generated_at: new Date(at).toISOString(), age_minutes: age, stale: age > maxAgeMinutes };
}

async function readBounded(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_BYTES) throw new Error('not_a_bounded_file');
  return readFile(path, 'utf8');
}

export function observerDefaults(env = process.env) {
  return {
    vaultRoot: env.MEMO_BRIDGE_VAULT_ROOT || join(homedir(), 'Vault'),
    agentDir: env.MEMO_BRIDGE_AGENT_DIR || join(homedir(), '.agent'),
    stasis: env.MEMO_BRIDGE_STASIS_BIN || 'stasis'
  };
}

// infrastructure-guardian: located through the canonical project registry, never a fixed path.
// It runs daily at 09:20, so a report older than 36 hours is stale.
export async function guardianReport({ catalogOptions = {}, now = Date.now, maxFindings = 8 } = {}) {
  const info = await projectInfo('infrastructure-guardian', catalogOptions);
  if (!info.ok || !info.project.local_path) return unavailable('infrastructure-guardian', info.error ?? 'project_unavailable');
  const source = join(info.project.local_path, 'reports', 'latest-all.json');
  let report;
  try { report = JSON.parse(await readBounded(source)); } catch { return unavailable(source); }
  if (report?.schema !== 'guardian.report/v1' || typeof report.sections !== 'object') return unavailable(source, 'unexpected_schema');
  const sections = {};
  for (const [name, section] of Object.entries(report.sections).slice(0, 20)) {
    const findings = Array.isArray(section?.findings) ? section.findings : [];
    const counts = {};
    for (const f of findings) counts[f?.status ?? 'UNKNOWN'] = (counts[f?.status ?? 'UNKNOWN'] ?? 0) + 1;
    const rank = { CRIT: 0, WARN: 1 };
    const top = findings.filter(f => f?.status in rank)
      .sort((a, b) => rank[a.status] - rank[b.status])
      .slice(0, maxFindings)
      .map(f => ({ status: f.status, check: text(f.check, 80), title: text(f.title) }));
    sections[name] = { status: text(section?.status, 10), available: section?.available === true, findings: counts, top };
  }
  return { ok: true, source, ...freshness(report.generated_at, 36 * 60, now), status: text(report.status, 10),
    run_id: text(report.run_id, 40), sections };
}

// agents-observe: written on the VPS every 15 minutes and synced into the Vault.
export async function agentsObserve({ vaultRoot = observerDefaults().vaultRoot, now = Date.now } = {}) {
  const source = join(vaultRoot, '4-Tools', 'agents-observe.json');
  let data;
  try { data = JSON.parse(await readBounded(source)); } catch { return unavailable(source); }
  if (!Array.isArray(data?.agents)) return unavailable(source, 'unexpected_schema');
  const agents = data.agents.slice(0, 50).map(a => ({
    name: text(a?.nom, 60), role: text(a?.quoi, 160), status: text(a?.statut, 30), up_for: text(a?.depuis, 30),
    restarts: Number.isInteger(a?.redemarrages) ? a.redemarrages : null,
    alerts: Array.isArray(a?.alertes) ? a.alertes.length : 0,
    first_alerts: Array.isArray(a?.alertes) ? a.alertes.slice(0, 3).map(x => text(x)) : []
  }));
  // `le` is local wall-clock time without an offset, written by the VPS in Europe/Paris.
  return { ok: true, source, ...freshness(data.le, 60, now), window_hours: data.fenetre_h ?? null,
    alerts: Number.isInteger(data.alertes) ? data.alertes : null, agents };
}

// LIVE-STATE carries job-search data too. Only operational sections leave this function.
const LIVE_STATE_SECTIONS = ['CI', 'Configuration agents', 'Git'];
export async function liveState({ agentDir = observerDefaults().agentDir, now = Date.now } = {}) {
  const source = join(agentDir, 'LIVE-STATE.md');
  let document;
  try { document = await readBounded(source); } catch { return unavailable(source); }
  const generated = /\*\*Generated:\*\*\s*([0-9T:-]+)/.exec(document)?.[1];
  const sections = [];
  let current = null;
  for (const line of document.split('\n')) {
    if (line.startsWith('## ')) {
      const heading = line.slice(3).trim();
      current = LIVE_STATE_SECTIONS.some(name => heading.startsWith(name)) ? { heading: text(heading, 400), lines: [] } : null;
      if (current) sections.push(current);
    } else if (current && line.trim() && current.lines.length < 12) {
      current.lines.push(text(line, 400));
    }
  }
  // Refreshed every 30 minutes by launchd; older than an hour is stale.
  return { ok: true, source, ...freshness(generated, 60, now), sections,
    withheld: 'non-operational sections (live processes, job search) are not exposed' };
}

// Stasis is the source of the active bet the Director will read; Memo Bridge only reports it.
export function focusStatus({ stasis = observerDefaults().stasis, run = execFile, now = Date.now } = {}) {
  return new Promise(resolve => {
    run(stasis, ['focus', '--json'], { timeout: 10000, maxBuffer: MAX_BYTES, env: process.env }, (error, stdout) => {
      if (error) return resolve(unavailable('stasis focus --json'));
      let data;
      try { data = JSON.parse(stdout); } catch { return resolve(unavailable('stasis focus --json', 'unexpected_output')); }
      const pick = bet => bet && ({
        project: text(bet.project, 80), bet: text(bet.bet), kill: text(bet.kill), set_at: text(bet.setAt, 40),
        horizon_days: Number.isInteger(bet.horizonDays) ? bet.horizonDays : null,
        ...(bet.endedAt ? { ended_at: text(bet.endedAt, 40), verdict: text(bet.verdict, 20) } : {})
      });
      const history = Array.isArray(data?.history) ? data.history : [];
      // Stasis lists history newest first.
      const last = history[0] ?? null;
      const active = pick(data?.active ?? null);
      const reviewDue = active?.set_at && active.horizon_days !== null
        ? Date.parse(active.set_at) + active.horizon_days * 86400000 < now() : false;
      resolve({ ok: true, source: 'stasis focus --json', active, review_due: reviewDue, last_closed: active ? null : pick(last) });
    });
  });
}
