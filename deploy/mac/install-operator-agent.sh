#!/bin/bash
# Install the Memo Bridge operator agent `operator-mac` on this Mac (Phase 6, TODO-P6-13).
# Read docs/OPERATOR.md first. Idempotent: rerunning changes only what differs, and an existing
# key is never regenerated.
#
# Usage, from a memo-bridge checkout with `pnpm install` done:
#   deploy/mac/install-operator-agent.sh [--hub-pub <file>]             prepare and stage
#   deploy/mac/install-operator-agent.sh [--hub-pub <file>] --install   ... then load in launchd
#   deploy/mac/install-operator-agent.sh --uninstall                    unload, remove the plist
#
# Without --install nothing outside these paths is touched, and launchd is not called:
#   ~/.memo-operator/                     0700  agent.key 0600 (created if absent, never printed),
#                                               operator-mac.pub, hub-ca.crt, operator-hub.pub,
#                                               policy.json (all 0444), state/ 0700
#   ~/.local/share/memo-bridge/operator/        the pinned agent bundle (files 0444)
#   ~/Library/Logs/memo-operator/         0700  logs and the hash-chained audit journal
#   $MEMO_OPERATOR_STAGING (default ~/.local/share/memo-bridge/operator/launchd/)
#                                               dev.memolabs.memo-operator-agent.plist
# --install copies the staged plist to ~/Library/LaunchAgents and bootstraps it in gui/<uid>.
# It refuses until hub-ca.crt and operator-hub.pub are in place.
#
# Inputs:
#   --hub-pub <file>   the hub's operator signing public key, from lab:
#                      ssh lab cat /etc/memo-operator/operator-hub.pub > /tmp/operator-hub.pub
#   MEMO_OPERATOR_NODE absolute node to run the agent with (default: `command -v node`, >= 22.16)
#   MEMO_OPERATOR_HUB_CA  the hub CA (default: the probe agent's ~/.config/memo-bridge/hub-ca.crt)
# The agent reaches the hub through the existing tunnel dev.memolabs.memo-bridge-tunnel
# (127.0.0.1:9444 -> lab 127.0.0.1:9443); this script does not create or change that tunnel.
set -euo pipefail
umask 077

die() { echo "install-operator-agent: $*" >&2; exit 1; }

INSTALL=0; UNINSTALL=0; HUB_PUB=""
while [ $# -gt 0 ]; do
  case "$1" in
    --install) INSTALL=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --hub-pub) [ $# -ge 2 ] || die "--hub-pub needs a file"; HUB_PUB="$2"; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

case "${HOME:-}" in /*) ;; *) die "HOME must be an absolute path" ;; esac
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
HELPER="$REPO/deploy/mac/operator-mac.mjs"
LABEL="dev.memolabs.memo-operator-agent"
CONF="$HOME/.memo-operator"
RUNTIME="$HOME/.local/share/memo-bridge/operator"
STAGING="${MEMO_OPERATOR_STAGING:-$RUNTIME/launchd}"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(/usr/bin/id -u)"

if [ "$UNINSTALL" = 1 ]; then
  [ "$(/usr/bin/uname -s)" = Darwin ] || die "--uninstall runs on macOS only"
  /bin/launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  /bin/rm -f "$TARGET"
  echo "{\"step\":\"uninstall\",\"label\":\"$LABEL\",\"kept\":\"$CONF\"}"
  exit 0
fi

NODE="${MEMO_OPERATOR_NODE:-$(command -v node || true)}"
case "$NODE" in /*) ;; *) die "node not found as an absolute path; set MEMO_OPERATOR_NODE" ;; esac
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=16)?0:1)' \
  || die "node >= 22.16 required ($NODE)"
[ -d "$REPO/node_modules/esbuild" ] || die "run pnpm install in $REPO first"

# 1. Identity of operator-mac: generated once, 0600; only the public key path is printed.
"$NODE" "$HELPER" keygen --home "$HOME"

# 2. Hub TLS CA, the same one the probe agent pins.
HUB_CA="${MEMO_OPERATOR_HUB_CA:-$HOME/.config/memo-bridge/hub-ca.crt}"
if [ -f "$HUB_CA" ]; then
  "$NODE" "$HELPER" hub-ca --home "$HOME" --from "$HUB_CA"
else
  echo "{\"step\":\"hub-ca\",\"state\":\"missing\",\"expected\":\"$HUB_CA\"}"
fi

# 3. Hub operator signing public key (optional here, required by --install).
if [ -n "$HUB_PUB" ]; then
  "$NODE" "$HELPER" hub-pub --home "$HOME" --from "$HUB_PUB"
elif [ ! -f "$CONF/operator-hub.pub" ]; then
  echo "{\"step\":\"hub-pub\",\"state\":\"missing\",\"hint\":\"--hub-pub <file from lab /etc/memo-operator/operator-hub.pub>\"}"
fi

# 4. Policy, read-only, checked through bridge/operator-policy.mjs and the project registry.
"$NODE" "$HELPER" policy --home "$HOME"

# 5. Pinned bundle of bridge/operator-agent-cli.mjs, outside every write root of the policy.
BUILD="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/memo-operator-build.XXXXXX")"
trap '/bin/rm -rf "$BUILD"' EXIT
"$NODE" "$REPO/scripts/build-operator.mjs" --out "$BUILD" >/dev/null
COMMIT="$(/usr/bin/git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
if [ "$COMMIT" != unknown ] && [ -n "$(/usr/bin/git -C "$REPO" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
  COMMIT="$COMMIT-dirty"
fi
if [ "$COMMIT" = unknown ]; then
  "$NODE" "$HELPER" runtime --home "$HOME" --from "$BUILD"
else
  "$NODE" "$HELPER" runtime --home "$HOME" --from "$BUILD" --commit "$COMMIT"
fi

# 6. launchd job, staged.
"$NODE" "$HELPER" plist --home "$HOME" --node "$NODE" --out "$STAGING"

if [ "$INSTALL" = 0 ]; then
  echo "{\"step\":\"done\",\"installed\":false,\"next\":\"rerun with --install once operator-hub.pub is in place and lab-infra has copied $CONF/operator-mac.pub to the hub\"}"
  exit 0
fi

# 7. --install: load it.
[ "$(/usr/bin/uname -s)" = Darwin ] || die "--install runs on macOS only"
[ -f "$CONF/hub-ca.crt" ] || die "missing $CONF/hub-ca.crt"
[ -f "$CONF/operator-hub.pub" ] || die "missing $CONF/operator-hub.pub (use --hub-pub)"
/usr/bin/plutil -lint "$STAGING/$LABEL.plist" >/dev/null || die "plist does not lint"
/bin/mkdir -p "$HOME/Library/LaunchAgents"
/bin/cp "$STAGING/$LABEL.plist" "$TARGET"
/bin/chmod 0644 "$TARGET"
/bin/launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# bootout returns before the old job is fully gone; bootstrap then fails with error 5 for a moment.
LOADED=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if /bin/launchctl bootstrap "$DOMAIN" "$TARGET" 2>/dev/null; then LOADED=1; break; fi
  /bin/sleep 1
done
[ "$LOADED" = 1 ] || die "launchctl bootstrap $DOMAIN $TARGET failed; see launchctl print $DOMAIN/$LABEL"
echo "{\"step\":\"install\",\"label\":\"$LABEL\",\"plist\":\"$TARGET\",\"check\":\"launchctl print $DOMAIN/$LABEL; tail ~/Library/Logs/memo-operator/stderr.log\"}"
