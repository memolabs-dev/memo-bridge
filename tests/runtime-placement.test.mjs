import test from 'node:test';
import assert from 'node:assert/strict';
import { executableRuntimeHost } from '../bridge/runtime-placement.mjs';

test('VPS runner preserves its established behavior', () => {
  assert.equal(executableRuntimeHost('vps', {}), 'vps');
});
test('Mac runtime is disabled unless explicitly opted in', () => {
  assert.throws(() => executableRuntimeHost('mac', {}), /runtime_host_not_enabled/);
  assert.throws(() => executableRuntimeHost('mac', {MEMO_BRIDGE_MAC_RUNTIME_ENABLED:'true'}), /runtime_host_not_enabled/);
  assert.throws(() => executableRuntimeHost('mac', {MEMO_BRIDGE_MAC_RUNTIME_ENABLED:'disabled'}), /runtime_host_not_enabled/);
  assert.equal(executableRuntimeHost('mac', {MEMO_BRIDGE_MAC_RUNTIME_ENABLED:'enabled'}), 'mac');
});
test('Unknown host never gains runtime access through Mac flag', () => {
  assert.throws(() => executableRuntimeHost('windows', {MEMO_BRIDGE_MAC_RUNTIME_ENABLED:'enabled'}), /runtime_host_not_enabled/);
  assert.throws(() => executableRuntimeHost('', {MEMO_BRIDGE_MAC_RUNTIME_ENABLED:'enabled'}), /runtime_host_not_enabled/);
});
