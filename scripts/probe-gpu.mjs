// Local hardware discovery only. Does not start an MCP server, jobs or remote hub.
import { probeNvidiaGpus } from '../server/runners/gpu.mjs';

const report = await probeNvidiaGpus();
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
