import test from 'node:test';
import { smokeStandalone } from './helpers/standalone-smoke.mjs';

test('standalone MCP stdio is independent from Memo Labs owner env and exposes no writes', async () => {
  await smokeStandalone();
});
