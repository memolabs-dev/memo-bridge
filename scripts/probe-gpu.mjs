// Local, read-only, vendor-neutral hardware discovery. Does not start remote MCP/jobs.
import { probeGpus } from '../server/runners/gpu-inventory.mjs';

const report = await probeGpus();
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
