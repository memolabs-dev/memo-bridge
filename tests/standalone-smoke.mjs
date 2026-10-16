import { smokeStandalone } from './helpers/standalone-smoke.mjs';

const report = await smokeStandalone({ built: true });
process.stdout.write(JSON.stringify(report) + '\n');
