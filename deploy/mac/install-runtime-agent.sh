#!/bin/bash
# Switch the Memo Bridge Mac agent from probe to runtime mode, so ChatGPT can open workspaces,
# claim Issues, create worktrees and run jobs on this Mac for the owner's private projects
# (issues #110, #114, #147). Owner-run, local only: nothing here talks to the VPS, and no
# token, corpus or project path leaves the Mac.
#
# Usage, from a trusted memo-bridge checkout with `pnpm install` done:
#   deploy/mac/install-runtime-agent.sh --owner-sub <uuid> --governance-ref <sha> \
#       (--all-owner-projects | --from-registry | --repo memolabs-dev/<name> ...) [--bridge-ref <sha>] [--app-key <pem>]   stage
#   ... same arguments ... --install                         stage, then load it in launchd
#   deploy/mac/install-runtime-agent.sh --rollback          restore the probe agent's plist
#
#   --owner-sub       the owner's Pocket ID user id (lab-infra memo_bridge_remote_owner_sub)
#   --governance-ref  the memolabs-dev/.github commit the ledger runs (scripts/issue_lease.py,
#                     issue_preflight.py, private_owner_allowlist.py); 40 hex
#   --from-registry   enroll every project of ~/memolabs/PROJECTS.md, and every owner external
#                     project of owner-policy/external-projects.json (#257, provisioned by the
#                     owner), whose Mac checkout has an origin in the owner's namespaces
#                     (memolabs-dev, guillaume-flambard) that GitHub reports private and not archived
#   --all-owner-projects  opt in all verified owner registry projects, public and private,
#                     with automatic reconciliation by the installed Mac runtime (#312)
#   --repo            enroll one such repository, or opt in one public one (repeatable)
#   --bridge-ref      the memo-bridge commit to run (default: HEAD of this checkout); 40 hex
#   --governance-src  where to clone the governance repository from (default GitHub)
#   --app-key         the memo-labs-automation App private key (lab-infra memo_runner_github_app_key_path),
#                     copied as the app-key credential so project_create can create repositories;
#                     the plist then limits the App to that (MEMO_BRIDGE_GITHUB_APP_PURPOSES): ledger,
#                     pushes and pull requests keep the gh token. Without it no app-key is kept.
#
# What it writes (without --install nothing else, and launchd is not called):
#   ~/.local/share/memo-bridge/runtime-releases/<bridge-ref>/   the runtime bundle (bridge/,
#                     server/, production node_modules), from `git archive` of that commit
#   ~/.local/share/memo-bridge/governance/<governance-ref>/     scripts/ of that governance commit
#   ~/.local/share/memo-bridge/launchd/runtime-credentials/    0700: STAGED
#                     agent-key, ledger-gh, push-gh and optional app-key. Only this
#                     directory is modified before --install. No token is printed.
#   ~/.local/share/memo-bridge/runtime-config/credentials/      0700: LIVE
#                     credentials used by launchd. Changed ONLY during --install.
#   ~/.local/share/memo-bridge/launchd/owner-policy/            0700, STAGED: private-repos.json,
#                     remote.json, stage.json and, when the owner has none yet, lease-key.json
#                     (deploy/mac/runtime-mac.mjs configure). The live owner-policy/ files the
#                     running agent reads are not touched by a stage run (fix pass of #258);
#                     external-projects.json is read, never written
#   ~/.local/share/memo-bridge/launchd/dev.memolabs.memo-bridge-agent.plist   staged plist
# A stage run never changes the live agent's credentials; promotion needs --install.
# --install keeps the current plist as .../launchd/dev.memolabs.memo-bridge-agent.plist.probe
# (once), installs the staged one, promotes the staged policies into owner-policy/ (each live
# one kept as .bak-<time>; a live lease-key.json is never replaced; refused if a live policy
# changed since the stage run) and restarts the agent; --rollback puts the probe plist back.
# The hub side (lab-infra memo_bridge_mac_runtime_routing: true) is a separate, reviewed deploy.
set -euo pipefail
umask 077

die() { echo "install-runtime-agent: $*" >&2; exit 1; }
say() { echo "{\"step\":\"$1\"${2:+,$2}}"; }

# E-16 (2026-10-18): the ledger child runs with HOME pointed at a private gh configuration
# directory, so a pin whose allowlist resolves the owner's home from $HOME answers False for
# every enrolled repository, and the coordinator surfaces that as a generic lease_denied. The
# account home has to come from the passwd database. Refuse such a pin instead of running it:
# this is the one mistake that silently refuses every private project on this Mac.
require_account_home_allowlist() {
  local tree="$1" ref="$2"
  [ -f "$tree/scripts/private_owner_allowlist.py" ] || die "governance $ref has no private_owner_allowlist.py"
  /usr/bin/grep -q 'getpwuid' "$tree/scripts/private_owner_allowlist.py" || die "governance $ref resolves the owner home from \$HOME instead of the passwd database (incident E-16, memolabs-dev/.github before ff63ce8d): every private repository would answer lease_denied"
}

# launchctl bootout returns before the service is gone; bootstrapping it again too early fails
# with "Bootstrap failed: 5: Input/output error" and leaves the agent unloaded (seen 2026-10-18).
# So: wait until it is unloaded, then bootstrap, with one retry.
reload_agent() {
  /bin/launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  local waited=0
  while /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && [ "$waited" -lt 20 ]; do
    /bin/sleep 0.5; waited=$((waited + 1))
  done
  /bin/launchctl bootstrap "$DOMAIN" "$TARGET" 2>/dev/null \
    || { /bin/sleep 2; /bin/launchctl bootstrap "$DOMAIN" "$TARGET"; } \
    || die "launchctl bootstrap failed; the agent is unloaded: rerun this command, or $0 --rollback"
}

INSTALL=0; ROLLBACK=0; FROM_REGISTRY=0
ALL_OWNER_PROJECTS=0
OWNER_SUB=""; GOV_REF=""; BRIDGE_REF=""; APP_KEY=""; GOV_SRC="https://github.com/memolabs-dev/.github.git"
REPOS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install) INSTALL=1 ;;
    --rollback) ROLLBACK=1 ;;
    --from-registry) FROM_REGISTRY=1 ;;
    --all-owner-projects) ALL_OWNER_PROJECTS=1 ;;
    --owner-sub) [ "$#" -ge 2 ] || die "--owner-sub needs a value"; OWNER_SUB="$2"; shift ;;
    --governance-ref) [ "$#" -ge 2 ] || die "--governance-ref needs a value"; GOV_REF="$2"; shift ;;
    --governance-src) [ "$#" -ge 2 ] || die "--governance-src needs a value"; GOV_SRC="$2"; shift ;;
    --bridge-ref) [ "$#" -ge 2 ] || die "--bridge-ref needs a value"; BRIDGE_REF="$2"; shift ;;
    --repo) [ "$#" -ge 2 ] || die "--repo needs a value"; REPOS+=("$2"); shift ;;
    --app-key) [ "$#" -ge 2 ] || die "--app-key needs a value"; APP_KEY="$2"; shift ;;
    -h|--help) /usr/bin/sed -n '2,39p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

[ "$(/usr/bin/uname -s)" = Darwin ] || die "this installer runs on macOS only"
case "${HOME:-}" in /*) ;; *) die "HOME must be an absolute path" ;; esac
LABEL="dev.memolabs.memo-bridge-agent"
BASE="$HOME/.local/share/memo-bridge"
STAGING="$BASE/launchd"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
PROBE_BACKUP="$STAGING/$LABEL.plist.probe"
DOMAIN="gui/$(/usr/bin/id -u)"

if [ "$ROLLBACK" = 1 ]; then
  [ -f "$PROBE_BACKUP" ] || die "no probe plist kept at $PROBE_BACKUP"
  /bin/cp -f "$PROBE_BACKUP" "$TARGET"
  reload_agent
  say rollback "\"label\":\"$LABEL\",\"restored\":\"$PROBE_BACKUP\""
  exit 0
fi

[[ "$OWNER_SUB" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "--owner-sub must be the owner's Pocket ID user id"
[[ "$GOV_REF" =~ ^[0-9a-f]{40}$ ]] || die "--governance-ref must be a 40-hex memolabs-dev/.github commit"
[ "$FROM_REGISTRY" = 1 ] || [ "$ALL_OWNER_PROJECTS" = 1 ] || [ "${#REPOS[@]}" -gt 0 ] || die "pass --all-owner-projects, --from-registry or at least one --repo"
if [ -n "$APP_KEY" ]; then
  case "$APP_KEY" in /*) ;; *) die "--app-key must be an absolute path" ;; esac
  [ -f "$APP_KEY" ] && [ ! -L "$APP_KEY" ] || die "--app-key is not a regular file"
  /usr/bin/grep -q 'PRIVATE KEY-----' "$APP_KEY" || die "--app-key is not a PEM private key"
fi

REPO="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
[ -n "$BRIDGE_REF" ] || BRIDGE_REF="$(/usr/bin/git -C "$REPO" rev-parse HEAD)"
[[ "$BRIDGE_REF" =~ ^[0-9a-f]{40}$ ]] || die "--bridge-ref must be a 40-hex memo-bridge commit"
/usr/bin/git -C "$REPO" cat-file -e "$BRIDGE_REF^{commit}" 2>/dev/null || die "commit $BRIDGE_REF is not in $REPO"

NODE="$(command -v node || true)"; GH="$(command -v gh || true)"; PNPM="$(command -v pnpm || true)"
case "$NODE" in /*) ;; *) die "node not found as an absolute path" ;; esac
case "$GH" in /*) ;; *) die "GitHub CLI (gh) is required" ;; esac
case "$PNPM" in /*) ;; *) die "pnpm is required to install the runtime's production dependencies" ;; esac
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=16)?0:1)' \
  || die "node >= 22.16 is required ($NODE)"
[ -x /usr/bin/python3 ] || die "/usr/bin/python3 is required by the governance ledger"

SOURCE_KEY="$HOME/.config/memo-bridge/agent.key"
SOURCE_CA="$HOME/.config/memo-bridge/hub-ca.crt"
[ -f "$SOURCE_KEY" ] || die "missing the probe agent identity: $SOURCE_KEY"
[ -f "$SOURCE_CA" ] || die "missing the hub CA: $SOURCE_CA"

/bin/mkdir -p "$BASE" "$STAGING" "$HOME/Library/Logs/memo-bridge" "$HOME/Library/LaunchAgents"
/bin/chmod 0700 "$STAGING"

# 1. The runtime bundle: exactly the files of one commit, then its production dependencies.
RELEASE="$BASE/runtime-releases/$BRIDGE_REF"
if [ ! -f "$RELEASE/.complete" ]; then
  /bin/mkdir -p "$BASE/runtime-releases"
  TMP_REL="$(/usr/bin/mktemp -d "$BASE/runtime-releases/.staging.XXXXXX")"
  trap '/bin/rm -rf "$TMP_REL"' EXIT
  /usr/bin/git -C "$REPO" archive "$BRIDGE_REF" bridge server package.json pnpm-lock.yaml pnpm-workspace.yaml \
    | /usr/bin/tar -x -C "$TMP_REL"
  (cd "$TMP_REL" && "$PNPM" install --prod --frozen-lockfile --ignore-scripts --prefer-offline --reporter=silent) \
    || die "pnpm install of the runtime bundle failed"
  (cd "$TMP_REL" && "$NODE" --input-type=module -e "await import('./server/runtime.mjs'); await import('./bridge/agent.mjs');") \
    || die "the runtime bundle does not load"
  /usr/bin/touch "$TMP_REL/.complete"
  /bin/rm -rf "$RELEASE"
  /bin/mv "$TMP_REL" "$RELEASE"
  trap - EXIT
fi
/bin/chmod -R go-w "$RELEASE"
say bundle "\"release\":\"$RELEASE\""

# Before touching credentials or switching launchd, compare the pinned code to the actual
# durable SQLite schema and take a transactionally consistent backup (including WAL).
# This blocks the v8-on-v9 failure observed on 2026-10-19.
# Never "fix" that failure by lowering SQLite user_version or clearing the database.
/usr/bin/python3 -I -B "$REPO/deploy/mac/guard-coordinator-state.py" \
  "$RELEASE/server/coordinator/store.mjs" \
  "$HOME/Library/Application Support/memo-bridge/coordinator.sqlite" \
  || die "runtime release is incompatible with coordinator state; launchd remains unchanged"

# 2. The governance scripts the ledger runs, pinned like lab-infra pins them for the VPS.
GOVERNANCE="$BASE/governance/$GOV_REF"
if [ ! -f "$GOVERNANCE/scripts/issue_lease.py" ]; then
  /bin/mkdir -p "$BASE/governance"
  TMP_GOV="$(/usr/bin/mktemp -d "$BASE/governance/.staging.XXXXXX")"
  trap '/bin/rm -rf "$TMP_GOV"' EXIT
  /usr/bin/git clone --quiet --no-checkout "$GOV_SRC" "$TMP_GOV/clone" || die "cannot clone $GOV_SRC"
  /usr/bin/git -C "$TMP_GOV/clone" cat-file -e "$GOV_REF^{commit}" 2>/dev/null || die "governance commit $GOV_REF not found"
  /bin/mkdir -p "$TMP_GOV/tree"
  /usr/bin/git -C "$TMP_GOV/clone" archive "$GOV_REF" scripts | /usr/bin/tar -x -C "$TMP_GOV/tree"
  require_account_home_allowlist "$TMP_GOV/tree" "$GOV_REF"
  /bin/rm -rf "$GOVERNANCE"
  /bin/mv "$TMP_GOV/tree" "$GOVERNANCE"
  /bin/rm -rf "$TMP_GOV"
  trap - EXIT
fi
# Re-checked on the installed tree: a pin an earlier run already placed here is refused too.
require_account_home_allowlist "$GOVERNANCE" "$GOV_REF"
say governance "\"root\":\"$GOVERNANCE\""

# 3. Credentials: stage into a DIFFERENT directory from the live agent credentials.
# A stage-only run must never touch the keys/tokens the already-running agent reads.
# Promotion happens after approval of --install and immediately before launchd reload.
# Keep this helper outside the runtime archive: the trusted checkout drives installation.
# shellcheck source=deploy/mac/runtime-credentials.sh
source "$REPO/deploy/mac/runtime-credentials.sh"
CREDS="$BASE/runtime-config/credentials"
STAGED_CREDS="$STAGING/runtime-credentials"
stage_runtime_credentials "$STAGED_CREDS" "$SOURCE_KEY" "$GH" "$APP_KEY" \
  || die "could not stage runtime credentials; the live agent credentials remain unchanged"
say credentials_staged "\"dir\":\"$STAGED_CREDS\",\"live_unchanged\":true"

# 4. Enrollment, the two policy files and the staged plist.
ARGS=(configure --home "$HOME" --owner-sub "$OWNER_SUB" --release "$RELEASE" --governance "$GOVERNANCE"
  --node "$NODE" --out "$STAGING" --path "$(/usr/bin/dirname "$GH")")
[ "$FROM_REGISTRY" = 1 ] && ARGS+=(--from-registry)
[ "$ALL_OWNER_PROJECTS" = 1 ] && ARGS+=(--all-owner-projects)
[ -n "$APP_KEY" ] && ARGS+=(--github-app)
for r in "${REPOS[@]+"${REPOS[@]}"}"; do ARGS+=(--repo "$r"); done
"$NODE" "$REPO/deploy/mac/runtime-mac.mjs" "${ARGS[@]}" || die "configure refused (see the JSON line above)"
/usr/bin/plutil -lint "$STAGING/$LABEL.plist" >/dev/null || die "staged plist is invalid"

if [ "$INSTALL" != 1 ]; then
  say staged "\"plist\":\"$STAGING/$LABEL.plist\",\"next\":\"rerun with --install to switch the agent to runtime mode\""
  exit 0
fi

# 5. Install: keep the probe plist once, then restart the agent in runtime mode.
if [ -f "$TARGET" ] && [ ! -f "$PROBE_BACKUP" ]; then /bin/cp -p "$TARGET" "$PROBE_BACKUP"; fi
/bin/cp -f "$STAGING/$LABEL.plist" "$TARGET.tmp"
/bin/chmod 0644 "$TARGET.tmp"
# The staged policies go live now, right before the restart (fix pass of #258): a stage run
# never changes what the running agent reads.
"$NODE" "$REPO/deploy/mac/runtime-mac.mjs" promote --home "$HOME" --out "$STAGING" \
  || { /bin/rm -f "$TARGET.tmp"; die "promote refused (see the JSON line above); the agent and its policy are unchanged"; }
# Promote only on explicit install. Do not touch running credentials during --stage.
# Missing App enrollment means the old App key is removed at install, never at stage.
# This is a separate T2 action after governance-policy promotion has been validated.
if [ -n "$APP_KEY" ]; then HAS_APP=1; else HAS_APP=0; fi
promote_runtime_credentials "$STAGED_CREDS" "$CREDS" "$HAS_APP" \
  || { /bin/rm -f "$TARGET.tmp"; die "credential promotion refused; agent not restarted"; }
/bin/mv -f "$TARGET.tmp" "$TARGET"
LOG="$HOME/Library/Logs/memo-bridge/stderr.log"
START_LINES="$( [ -f "$LOG" ] && /usr/bin/wc -l < "$LOG" | /usr/bin/tr -d ' ' || echo 0)"
reload_agent
/bin/launchctl kickstart -k "$DOMAIN/$LABEL"
tries=0
while [ "$tries" -lt 30 ]; do
  tries=$((tries + 1))
  if [ -f "$LOG" ] && /usr/bin/tail -n "+$((START_LINES + 1))" "$LOG" | /usr/bin/grep -q '"event":"runtime_ready"'; then
    say installed "\"label\":\"$LABEL\",\"runtime_ready\":true,\"rollback\":\"$0 --rollback\""
    exit 0
  fi
  /bin/sleep 1
done
die "the agent did not report runtime_ready within 30 s; read $LOG, then $0 --rollback if needed"
