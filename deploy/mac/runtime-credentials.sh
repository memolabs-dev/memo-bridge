#!/usr/bin/env bash
# Sourced by install-runtime-agent.sh. Staging must NEVER update credentials read
# by an already-running Mac agent. Only the explicit --install path promotes them.
# No tokens, keys or file contents are logged.
#
# Every command below carries its own `|| return 1`. The installer calls these helpers as
# `helper || die ...`, and in that context bash ignores `set -e`, inside subshells too: without
# the explicit returns a failed install or mv would be skipped and the helper would still
# return 0 (review of #311, 2026-11-26).
set -euo pipefail

RUNTIME_CREDENTIAL_FILES="agent-key ledger-gh push-gh"

_runtime_regular() { [ -f "$1" ] && [ ! -L "$1" ]; }

# stage_runtime_credentials <stage dir> <probe agent key> <gh binary> <app key path or "">
stage_runtime_credentials() {
  local stage="$1" source_agent="$2" gh="$3" app_key="$4"
  [ ! -L "$stage" ] || return 1
  /bin/mkdir -p "$stage" || return 1
  /bin/chmod 0700 "$stage" || return 1
  _runtime_regular "$source_agent" || return 1
  /usr/bin/install -m 0600 "$source_agent" "$stage/agent-key.tmp" || return 1
  /bin/mv -f "$stage/agent-key.tmp" "$stage/agent-key" || return 1
  local token token_length name
  token="$("$gh" auth token --hostname github.com 2>/dev/null || true)"
  # Length checked apart: macOS /bin/bash 3.2 refuses a regex bound above 255 (RE_DUP_MAX).
  token_length="$(printf '%s' "$token" | /usr/bin/wc -c | /usr/bin/tr -d ' ')" || return 1
  [[ "$token" =~ ^[A-Za-z0-9_.-]+$ ]] && [ "$token_length" -ge 20 ] && [ "$token_length" -le 2048 ] || return 1
  for name in ledger-gh push-gh; do
    printf '%s\n' "$token" > "$stage/$name.tmp" || return 1
    /bin/chmod 0600 "$stage/$name.tmp" || return 1
    /bin/mv -f "$stage/$name.tmp" "$stage/$name" || return 1
  done
  token=""
  if [ -n "$app_key" ]; then
    _runtime_regular "$app_key" || return 1
    /usr/bin/install -m 0600 "$app_key" "$stage/app-key.tmp" || return 1
    /bin/mv -f "$stage/app-key.tmp" "$stage/app-key" || return 1
  else
    # Only the STAGED copy goes; the LIVE App key is decided at --install (app mode below).
    /bin/rm -f "$stage/app-key" || return 1
  fi
}

# promote_runtime_credentials <stage dir> <live dir> <app mode>
#   app mode: install  replace the live app-key with the staged one (--app-key)
#             remove   delete the live app-key (--remove-app-key, the only way to drop it)
#             keep     no App change; refused while a live app-key exists, so a forgotten
#                      --app-key never deletes App access
# Everything is validated and copied next to the live directory first; the live files the
# agent reads are then replaced one by one, and any failure puts the previous ones back.
# On success the previous files stay in <live>.prev until finish_runtime_credentials
# (or restore_runtime_credentials, if the step after this one fails).
promote_runtime_credentials() {
  local stage="$1" live="$2" app_mode="$3" name
  local next="$live.next" prev="$live.prev"
  case "$app_mode" in install|remove|keep) ;; *) return 1 ;; esac
  [ -d "$stage" ] && [ ! -L "$stage" ] && [ ! -L "$live" ] || return 1
  # A <live>.prev left by an interrupted run may hold the only good copy: never overwrite it.
  [ ! -e "$prev" ] && [ ! -L "$prev" ] && [ ! -L "$next" ] || return 1
  for name in $RUNTIME_CREDENTIAL_FILES; do
    _runtime_regular "$stage/$name" || return 1
  done
  if [ "$app_mode" = install ]; then _runtime_regular "$stage/app-key" || return 1; fi
  if [ "$app_mode" = keep ] && { [ -e "$live/app-key" ] || [ -L "$live/app-key" ]; }; then return 1; fi
  for name in $RUNTIME_CREDENTIAL_FILES app-key; do
    [ ! -L "$live/$name" ] || return 1
  done

  # 1. Copy: nothing the agent reads changes yet.
  /bin/mkdir -p "$live" || return 1
  /bin/chmod 0700 "$live" || return 1
  /bin/rm -rf "$next" || return 1
  /bin/mkdir -m 0700 "$next" "$prev" || { /bin/rm -rf "$next" "$prev"; return 1; }
  for name in $RUNTIME_CREDENTIAL_FILES; do
    /usr/bin/install -m 0600 "$stage/$name" "$next/$name" || { /bin/rm -rf "$next" "$prev"; return 1; }
  done
  if [ "$app_mode" = install ]; then
    /usr/bin/install -m 0600 "$stage/app-key" "$next/app-key" || { /bin/rm -rf "$next" "$prev"; return 1; }
  fi
  # A file absent from <live>.prev was absent from <live>: restoring removes it.
  for name in $RUNTIME_CREDENTIAL_FILES app-key; do
    if [ -f "$live/$name" ]; then
      /bin/cp -p "$live/$name" "$prev/$name" || { /bin/rm -rf "$next" "$prev"; return 1; }
    fi
  done

  # 2. Replace, rolling back on the first failure.
  for name in $RUNTIME_CREDENTIAL_FILES; do
    /bin/mv -f "$next/$name" "$live/$name" || { restore_runtime_credentials "$live"; return 1; }
  done
  case "$app_mode" in
    install) /bin/mv -f "$next/app-key" "$live/app-key" || { restore_runtime_credentials "$live"; return 1; } ;;
    remove) /bin/rm -f "$live/app-key" || { restore_runtime_credentials "$live"; return 1; } ;;
  esac
  /bin/rmdir "$next" || { restore_runtime_credentials "$live"; return 1; }
}

# Put back the live credentials promote_runtime_credentials replaced.
restore_runtime_credentials() {
  local live="$1" name
  local prev="$live.prev"
  [ -d "$prev" ] && [ ! -L "$prev" ] || return 1
  for name in $RUNTIME_CREDENTIAL_FILES app-key; do
    if [ -f "$prev/$name" ]; then
      /bin/mv -f "$prev/$name" "$live/$name" || return 1
    else
      /bin/rm -f "$live/$name" || return 1
    fi
  done
  /bin/rmdir "$prev" || return 1
  /bin/rm -rf "$live.next" || return 1
}

# The install went through: drop the copies of the previous credentials.
finish_runtime_credentials() {
  local live="$1"
  [ ! -L "$live.prev" ] || return 1
  /bin/rm -rf "$live.prev" || return 1
}
