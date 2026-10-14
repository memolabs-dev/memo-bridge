#!/bin/bash
# Install the Memo Bridge root helper on this Mac: the LaunchDaemon dev.memolabs.memo-operator-root
# (owner decision 2026-10-14, spec §13 "Mac root follow-up"). Read docs/OPERATOR.md first.
#
# Usage, from a memo-bridge checkout with `pnpm install` done and the operator agent installed:
#   deploy/mac/install-operator-root.sh                   dry run: print the plan, the policy, the
#                                                         plist; change nothing (no sudo needed)
#   sudo deploy/mac/install-operator-root.sh --install    do it (the owner runs this, nobody else)
#   sudo deploy/mac/install-operator-root.sh --uninstall  undo it; the journal stays
#   [--node <abs>]  the node to copy (default: the one the operator agent's plist runs, else PATH)
#
# --install, in this order (each step printed before it runs; rerunning is safe):
#   1. checks: macOS, run through sudo by the agent user, ~/.memo-operator/operator-hub.pub present,
#      a node that links system libraries only (otool -L), /Library/Application Support root-owned;
#   2. as the agent user ($SUDO_USER), never as root: build the bundle
#      (scripts/build-operator.mjs --root), render policy.json and the plist into a temporary
#      directory, which root then takes over (root:wheel, no group or other write);
#   3. as root: copy root-owned with install -S into
#      /Library/Application Support/MemoBridge/operator-root/ (dirs 0755, files 0444, node 0555),
#      with the hub key copied from ~/.memo-operator/operator-hub.pub; make /var/db/memo-operator-root
#      and /var/log/memo-operator (0700); run the copied helper with --check;
#   4. write /Library/LaunchDaemons/dev.memolabs.memo-operator-root.plist (root:wheel 0644) and
#      launchctl bootstrap system (launchctl(1): the system domain needs root to modify).
# Then, as the user, rerun deploy/mac/install-operator-agent.sh --install: the agent's policy
# becomes max_tier root with the helper's socket, and the agent restarts.
# Nothing is ever written under the home folder, and nothing under it is ever run as root.
set -euo pipefail
umask 022

die() { echo "install-operator-root: $*" >&2; exit 1; }
say() { echo "$1"; }

MODE=dry; NODE_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --install) MODE=install ;;
    --uninstall) MODE=uninstall ;;
    --node) [ $# -ge 2 ] || die "--node needs a path"; NODE_ARG="$2"; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
HELPER="$REPO/deploy/mac/operator-mac.mjs"
LABEL="dev.memolabs.memo-operator-root"
PARENT="/Library/Application Support/MemoBridge"
DIR="$PARENT/operator-root"
L_NODE="$DIR/bin/node"
L_SCRIPT="$DIR/bridge/operator-root-mac-cli.mjs"
PLIST="/Library/LaunchDaemons/$LABEL.plist"
STATE="/var/db/memo-operator-root"
LOGS="/var/log/memo-operator"
SOCKDIR="/var/run/memo-operator"
AGENT_LABEL="dev.memolabs.memo-operator-agent"

# Who the agent user is: the user who ran sudo, or the current user for a dry run.
if [ "$(/usr/bin/id -u)" = 0 ]; then
  [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] || die "run it with sudo from the agent user's account, not as root directly"
  AGENT_USER="$SUDO_USER"
else
  [ "$MODE" = dry ] || die "--$MODE needs root: run  sudo $0 --$MODE"
  AGENT_USER="$(/usr/bin/id -un)"
fi
AGENT_UID="$(/usr/bin/id -u "$AGENT_USER")"
AGENT_GID="$(/usr/bin/id -g "$AGENT_USER")"
[ "$AGENT_UID" != 0 ] || die "the agent user cannot be root"
if [ "$(/usr/bin/id -u)" = 0 ]; then
  AGENT_HOME="$(/usr/bin/dscl . -read "/Users/$AGENT_USER" NFSHomeDirectory | /usr/bin/awk '{print $2}')"
else
  AGENT_HOME="$HOME"
fi
case "$AGENT_HOME" in /*) ;; *) die "home of $AGENT_USER not found" ;; esac
HUB_PUB="$AGENT_HOME/.memo-operator/operator-hub.pub"

# Run a command as the agent user (a no-op wrapper in a dry run, which already is that user).
as_user() {
  if [ "$(/usr/bin/id -u)" = 0 ]; then /usr/bin/sudo -H -u "$AGENT_USER" "$@"; else "$@"; fi
}

if [ "$MODE" = uninstall ]; then
  [ "$(/usr/bin/uname -s)" = Darwin ] || die "--uninstall runs on macOS only"
  say "{\"step\":\"plan\",\"action\":\"bootout\",\"path\":\"system/$LABEL\"}"
  say "{\"step\":\"plan\",\"action\":\"remove\",\"path\":\"$PLIST\"}"
  say "{\"step\":\"plan\",\"action\":\"remove\",\"path\":\"$DIR\"}"
  say "{\"step\":\"plan\",\"action\":\"remove\",\"path\":\"$STATE\"}"
  say "{\"step\":\"plan\",\"action\":\"remove\",\"path\":\"$SOCKDIR\"}"
  say "{\"step\":\"plan\",\"action\":\"keep\",\"path\":\"$LOGS\",\"detail\":\"the root journal stays for the record\"}"
  /bin/launchctl bootout "system/$LABEL" 2>/dev/null || true
  /bin/rm -f "$PLIST"
  for d in "$DIR" "$STATE" "$SOCKDIR"; do
    if [ -L "$d" ]; then die "$d is a symlink; not following it"; fi
    if [ -d "$d" ]; then /bin/rm -rf "$d"; fi
  done
  /bin/rmdir "$PARENT" 2>/dev/null || true
  say "{\"step\":\"uninstall\",\"label\":\"$LABEL\",\"kept\":\"$LOGS\",\"next\":\"as $AGENT_USER: deploy/mac/install-operator-agent.sh --install (back to max_tier exec)\"}"
  exit 0
fi

# The node to copy: --node, else the operator agent's plist, else PATH.
NODE="$NODE_ARG"
AGENT_PLIST="$AGENT_HOME/Library/LaunchAgents/$AGENT_LABEL.plist"
if [ -z "$NODE" ] && [ -f "$AGENT_PLIST" ] && [ -x /usr/libexec/PlistBuddy ]; then
  NODE="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$AGENT_PLIST" 2>/dev/null || true)"
fi
if [ -z "$NODE" ] && [ "$MODE" = dry ]; then NODE="$(command -v node || true)"; fi
case "$NODE" in /*) ;; *) die "node not found as an absolute path; pass --node <abs>" ;; esac
[ -f "$NODE" ] && [ -x "$NODE" ] || die "not an executable file: $NODE"
NODE_REAL="$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")"
if [ -L "$NODE_REAL" ]; then NODE_REAL="$(/bin/realpath "$NODE_REAL" 2>/dev/null || readlink -f "$NODE_REAL")"; fi
as_user "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=16)?0:1)' \
  || die "node >= 22.16 required ($NODE)"

# DEV-P6-35: root must not load a library the user can rewrite (Homebrew's node links /opt/homebrew).
LIBS=unchecked
if command -v otool >/dev/null 2>&1; then
  if /usr/bin/otool -L "$NODE_REAL" | /usr/bin/tail -n +2 | /usr/bin/awk '{print $1}' | /usr/bin/grep -qvE '^(/usr/lib/|/System/)'; then
    LIBS=user_writable
  else
    LIBS=system_only
  fi
fi
say "{\"step\":\"node\",\"path\":\"$NODE_REAL\",\"libraries\":\"$LIBS\"}"

# The hub key the helper will trust, by key id (SHA-256 of the SPKI DER, first 16 hex, as
# bridge/operator-signing.mjs computes it), to compare with lab before installing.
HUB_OK=0
if [ -f "$HUB_PUB" ] && [ ! -L "$HUB_PUB" ] && as_user "$NODE" "$HELPER" hub-key-id --from "$HUB_PUB"; then
  HUB_OK=1
  say "{\"step\":\"hub-pub-compare\",\"run\":\"ssh lab cat /etc/memo-operator/operator-hub.pub > /tmp/lab-hub.pub; node deploy/mac/operator-mac.mjs hub-key-id --from /tmp/lab-hub.pub\"}"
else
  say "{\"step\":\"hub-pub\",\"path\":\"$HUB_PUB\",\"state\":\"missing\"}"
fi

# The plan, then the rendered policy and plist (one JSON line each).
as_user "$NODE" "$HELPER" root-plan --home "$AGENT_HOME" --node "$NODE_REAL" --uid "$AGENT_UID" --gid "$AGENT_GID"
as_user "$NODE" "$HELPER" root-policy --home "$AGENT_HOME"
as_user "$NODE" "$HELPER" root-plist --home "$AGENT_HOME" --uid "$AGENT_UID" --gid "$AGENT_GID"

if [ "$MODE" = dry ]; then
  say "{\"step\":\"done\",\"installed\":false,\"next\":\"sudo $0 --install\"}"
  exit 0
fi

# --install, as root from here on.
[ "$(/usr/bin/uname -s)" = Darwin ] || die "--install runs on macOS only"
[ "$LIBS" = system_only ] || die "$NODE_REAL links libraries outside /usr/lib and /System (libraries: $LIBS); pass --node with an official node build (nvm)"
[ "$HUB_OK" = 1 ] || die "missing or invalid $HUB_PUB; install the operator agent first (deploy/mac/install-operator-agent.sh --hub-pub ...)"
[ "$(/usr/bin/stat -f '%u' "$HUB_PUB")" = "$AGENT_UID" ] || die "$HUB_PUB is not owned by $AGENT_USER"
[ -d "$REPO/node_modules/esbuild" ] || die "run pnpm install in $REPO first"
AS="/Library/Application Support"
[ "$(/usr/bin/stat -f '%u' "$AS")" = 0 ] || die "$AS is not owned by root"
case "$(/usr/bin/stat -f '%Lp' "$AS")" in *[2367]?|*?[2367]) die "$AS is writable by group or other" ;; esac
for d in "$PARENT" "$DIR"; do
  if [ -L "$d" ]; then die "$d is a symlink"; fi
  if [ -e "$d" ] && [ "$(/usr/bin/stat -f '%u' "$d")" != 0 ]; then die "$d exists and is not owned by root"; fi
done

TMP="$(/usr/bin/mktemp -d /tmp/memo-operator-root.XXXXXX)"
trap '/bin/rm -rf "$TMP"' EXIT
/usr/sbin/chown "$AGENT_USER" "$TMP"
say "{\"step\":\"build\",\"as\":\"$AGENT_USER\",\"dir\":\"$TMP\"}"
as_user "$NODE" "$REPO/scripts/build-operator.mjs" --root --out "$TMP/bundle" >/dev/null
as_user "$NODE" "$HELPER" root-policy --home "$AGENT_HOME" --out "$TMP/policy.json" >/dev/null
as_user "$NODE" "$HELPER" root-plist --home "$AGENT_HOME" --uid "$AGENT_UID" --gid "$AGENT_GID" --out "$TMP/$LABEL.plist" >/dev/null
COMMIT="$(as_user /usr/bin/git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
if [ "$COMMIT" != unknown ] && [ -n "$(as_user /usr/bin/git -C "$REPO" status --porcelain --untracked-files=no 2>/dev/null)" ]; then COMMIT="$COMMIT-dirty"; fi
echo "$COMMIT" > "$TMP/VERSION"
# From here the user can no longer change what root copies.
/usr/sbin/chown -R root:wheel "$TMP"
/bin/chmod -R go-w "$TMP"

say "{\"step\":\"copy\",\"dir\":\"$DIR\",\"owner\":\"root:wheel\",\"commit\":\"$COMMIT\"}"
/usr/bin/install -d -o root -g wheel -m 0755 "$PARENT" "$DIR" "$DIR/bin" "$DIR/bridge"
/usr/bin/install -S -o root -g wheel -m 0555 "$NODE_REAL" "$L_NODE"
/usr/bin/install -S -o root -g wheel -m 0444 "$TMP/bundle/bridge/operator-root-mac-cli.mjs" "$L_SCRIPT"
/usr/bin/install -S -o root -g wheel -m 0444 "$TMP/bundle/bridge/operator-job-supervisor.mjs" "$DIR/bridge/operator-job-supervisor.mjs"
/usr/bin/install -S -o root -g wheel -m 0444 "$TMP/bundle/package.json" "$DIR/package.json"
/usr/bin/install -S -o root -g wheel -m 0444 "$TMP/VERSION" "$DIR/VERSION"
/usr/bin/install -S -o root -g wheel -m 0444 "$TMP/policy.json" "$DIR/policy.json"
/usr/bin/install -S -o root -g wheel -m 0444 "$HUB_PUB" "$DIR/operator-hub.pub"
for d in "$PARENT" "$DIR" "$DIR/bin" "$DIR/bridge"; do /usr/sbin/chown root:wheel "$d"; /bin/chmod 0755 "$d"; done
/usr/bin/install -d -o root -g wheel -m 0700 "$STATE" "$LOGS"
for d in "$STATE" "$LOGS"; do /usr/sbin/chown root:wheel "$d"; /bin/chmod 0700 "$d"; done

say "{\"step\":\"check\",\"run\":\"$L_NODE $L_SCRIPT --check\"}"
/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin MEMO_OPERATOR_ROOT_DIR="$DIR" MEMO_OPERATOR_AGENT_UID="$AGENT_UID" \
  MEMO_OPERATOR_AGENT_GID="$AGENT_GID" MEMO_OPERATOR_USER_FROZEN="$AGENT_HOME/.memo-operator/FROZEN" \
  "$L_NODE" "$L_SCRIPT" --check || die "the installed helper refused its own check; nothing loaded"

/usr/bin/plutil -lint "$TMP/$LABEL.plist" >/dev/null || die "plist does not lint"
/usr/bin/install -S -o root -g wheel -m 0644 "$TMP/$LABEL.plist" "$PLIST"
say "{\"step\":\"launchctl\",\"run\":\"launchctl bootstrap system $PLIST\"}"
/bin/launchctl bootout "system/$LABEL" 2>/dev/null || true
# bootout returns before the old job is fully gone; bootstrap then fails with error 5 for a moment.
LOADED=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if /bin/launchctl bootstrap system "$PLIST" 2>/dev/null; then LOADED=1; break; fi
  /bin/sleep 1
done
[ "$LOADED" = 1 ] || die "launchctl bootstrap system $PLIST failed; see launchctl print system/$LABEL and $LOGS/helper.log"
say "{\"step\":\"install\",\"label\":\"$LABEL\",\"plist\":\"$PLIST\",\"check\":\"sudo launchctl print system/$LABEL | head -20; sudo tail $LOGS/helper.log\",\"next\":\"as $AGENT_USER: deploy/mac/install-operator-agent.sh --install\"}"
