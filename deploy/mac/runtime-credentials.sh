#!/usr/bin/env bash
# Sourced by install-runtime-agent.sh. Staging must NEVER update credentials read
# by an already-running Mac agent. Only the explicit --install path promotes them.
# No tokens, keys or file contents are logged.
set -euo pipefail

stage_runtime_credentials() {
  local stage="$1" source_agent="$2" gh="$3" app_key="$4"
  [ ! -L "$stage" ] || return 1
  /bin/mkdir -p "$stage"
  /bin/chmod 0700 "$stage"
  [ -f "$source_agent" ] && [ ! -L "$source_agent" ] || return 1
  /usr/bin/install -m 0600 "$source_agent" "$stage/agent-key.tmp"
  /bin/mv -f "$stage/agent-key.tmp" "$stage/agent-key"
  local token token_length
  token="$("$gh" auth token --hostname github.com 2>/dev/null || true)"
  token_length="$(printf '%s' "$token" | /usr/bin/wc -c | /usr/bin/tr -d ' ')"
  [[ "$token" =~ ^[A-Za-z0-9_.-]+$ ]] && [ "$token_length" -ge 20 ] && [ "$token_length" -le 2048 ] || return 1
  local name
  for name in ledger-gh push-gh; do
    printf '%s\n' "$token" > "$stage/$name.tmp"
    /bin/chmod 0600 "$stage/$name.tmp"
    /bin/mv -f "$stage/$name.tmp" "$stage/$name"
  done
  token=""
  if [ -n "$app_key" ]; then
    [ -f "$app_key" ] && [ ! -L "$app_key" ] || return 1
    /usr/bin/install -m 0600 "$app_key" "$stage/app-key.tmp"
    /bin/mv -f "$stage/app-key.tmp" "$stage/app-key"
  else
    # The STAGED policy will be without the App; never delete the LIVE App key.
    /bin/rm -f "$stage/app-key"
  fi
}

promote_runtime_credentials() {
  local stage="$1" live="$2" has_app="$3"
  [ -d "$stage" ] && [ ! -L "$stage" ] && [ ! -L "$live" ] || return 1
  local name
  for name in agent-key ledger-gh push-gh; do
    [ -f "$stage/$name" ] && [ ! -L "$stage/$name" ] || return 1
  done
  if [ "$has_app" = 1 ]; then
    [ -f "$stage/app-key" ] && [ ! -L "$stage/app-key" ] || return 1
  fi
  # Validate everything before changing the credential directory used by launchd.
  /bin/mkdir -p "$live"
  /bin/chmod 0700 "$live"
  for name in agent-key ledger-gh push-gh; do
    /usr/bin/install -m 0600 "$stage/$name" "$live/$name.tmp"
  done
  if [ "$has_app" = 1 ]; then
    /usr/bin/install -m 0600 "$stage/app-key" "$live/app-key.tmp"
  fi
  for name in agent-key ledger-gh push-gh; do
    /bin/mv -f "$live/$name.tmp" "$live/$name"
  done
  if [ "$has_app" = 1 ]; then
    /bin/mv -f "$live/app-key.tmp" "$live/app-key"
  else
    # Deliberately remove old App access ONLY during an explicit install of a
    # runtime with no App policy. A harmless --stage never executes this branch.
    /bin/rm -f "$live/app-key"
  fi
}
