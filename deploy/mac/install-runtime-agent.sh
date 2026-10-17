#!/bin/bash
# Provision the Memo Bridge Mac runtime without exporting a GitHub token.
#
# This is intentionally a local, owner-run bootstrap. It reads the GitHub CLI's
# existing Keychain-backed login through `gh auth token` and writes the token only
# to a 0700 runtime credential directory. It never prints the token, copies it to
# the VPS, or puts it in a launchd environment variable.
#
# Usage (from a trusted memo-bridge checkout):
#   deploy/mac/install-runtime-agent.sh --owner-sub <Pocket-ID-sub> --install
#
# The hub configuration must separately contain the same owner_sub, the CDKF
# repository, and mac_runtime_routing: "enabled". This script does not change the
# hub and therefore cannot accidentally expose the private corpus.
set -euo pipefail
umask 077

die() { echo "install-runtime-agent: $*" >&2; exit 1; }

INSTALL=0
OWNER_SUB=""
REPO="memolabs-dev/clinical-data-knowledge-foundation"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install) INSTALL=1 ;;
    --owner-sub) [ "$#" -ge 2 ] || die "--owner-sub needs a value"; OWNER_SUB="$2"; shift ;;
    --repo) [ "$#" -ge 2 ] || die "--repo needs a value"; REPO="$2"; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

[ "$(uname -s)" = Darwin ] || die "this installer runs on macOS only"
[[ "$OWNER_SUB" =~ ^[A-Za-z0-9._@-]{1,120}$ ]] || die "--owner-sub is required"
[[ "$REPO" =~ ^memolabs-dev/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ ]] || die "invalid --repo"

MEMO_HOME="${HOME:?HOME is required}"
NODE="$(command -v node || true)"
GH="$(command -v gh || true)"
[ -n "$NODE" ] && [ -x "$NODE" ] || die "node is required"
[ -n "$GH" ] && [ -x "$GH" ] || die "GitHub CLI is required"
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=16)?0:1)' \
  || die "node >= 22.16 is required"

SOURCE_KEY="$MEMO_HOME/.config/memo-bridge/agent.key"
SOURCE_CA="$MEMO_HOME/.config/memo-bridge/hub-ca.crt"
BUNDLE="$MEMO_HOME/.local/share/memo-bridge/runtime/bridge/agent-cli.mjs"
CONFIG="$MEMO_HOME/.local/share/memo-bridge/runtime-config"
CREDS="$CONFIG/credentials"
POLICY_DIR="$MEMO_HOME/.local/share/memo-bridge/owner-policy"
POLICY="$POLICY_DIR/private-repos.json"
LABEL="dev.memolabs.memo-bridge-agent"
PLIST="$MEMO_HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

[ -f "$SOURCE_KEY" ] || die "missing existing probe identity: $SOURCE_KEY"
[ -f "$SOURCE_CA" ] || die "missing hub CA: $SOURCE_CA"
[ -f "$BUNDLE" ] || die "missing deployed runtime bundle: $BUNDLE"

# gh obtains the Keychain-held token locally. Nothing captures it in logs or env.
TOKEN="$("$GH" auth token --hostname github.com 2>/dev/null || true)"
[[ "$TOKEN" =~ ^[A-Za-z0-9_.-]{20,2048}$ ]] || die "GitHub CLI has no usable github.com token"

mkdir -p "$CREDS" "$POLICY_DIR" "$MEMO_HOME/Library/Logs/memo-bridge" "$MEMO_HOME/Library/LaunchAgents"
chmod 0700 "$CONFIG" "$CREDS" "$POLICY_DIR"
install -m 0600 "$SOURCE_KEY" "$CREDS/agent-key"
printf '%s\n' "$TOKEN" > "$CREDS/ledger-gh"
chmod 0600 "$CREDS/ledger-gh"
TOKEN="" # do not retain it beyond the protected file write

TMP_POLICY="$(mktemp "$POLICY_DIR/.private-repos.XXXXXX")"
trap 'rm -f "$TMP_POLICY" "$PLIST.tmp"' EXIT
printf '{"schema":"memolabs.owner-private-repos.v1","owner_sub":"%s","repos":["%s"]}\n' "$OWNER_SUB" "$REPO" > "$TMP_POLICY"
chmod 0600 "$TMP_POLICY"
mv -f "$TMP_POLICY" "$POLICY"

cat > "$PLIST.tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$BUNDLE</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>MEMO_BRIDGE_AGENT_MODE</key><string>runtime</string>
    <key>MEMO_BRIDGE_MAC_RUNTIME_ENABLED</key><string>enabled</string>
    <key>MEMO_BRIDGE_AGENT_CONFIG</key><string>$MEMO_HOME/.config/memo-bridge</string>
    <key>CREDENTIALS_DIRECTORY</key><string>$CREDS</string>
    <key>MEMO_BRIDGE_AGENT_URL</key><string>wss://127.0.0.1:9444/agent</string>
    <key>MEMO_BRIDGE_HOST</key><string>mac</string>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
  <key>KeepAlive</key><true/><key>RunAtLoad</key><true/><key>ThrottleInterval</key><integer>30</integer>
  <key>StandardErrorPath</key><string>$MEMO_HOME/Library/Logs/memo-bridge/stderr.log</string>
  <key>StandardOutPath</key><string>$MEMO_HOME/Library/Logs/memo-bridge/stdout.log</string>
</dict></plist>
EOF
plutil -lint "$PLIST.tmp" >/dev/null
chmod 0644 "$PLIST.tmp"

if [ "$INSTALL" = 1 ]; then
  mv -f "$PLIST.tmp" "$PLIST"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  launchctl kickstart -k "$DOMAIN/$LABEL"
  echo '{"ok":true,"installed":true,"next":"enable the guarded VPS routing config, then run the CDKF E2E check"}'
else
  echo '{"ok":true,"installed":false,"next":"credentials and policy were prepared; rerun with --install to switch the agent to runtime mode"}'
fi
