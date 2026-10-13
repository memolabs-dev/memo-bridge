// Child process used by the concurrency tests: one process = one MCP client session with
// its own SQLite connection to the shared state file.
import { coordinatorOn } from './coordinator-fixture.mjs';

const [stateDir] = process.argv.slice(2);
const { store, coordinator } = coordinatorOn(stateDir);
const opened = await coordinator.workspaceOpen({ project: 'drop', client_type: 'chatgpt', client_label: `worker ${process.pid}` });
process.send({ type: 'ready', workspace: opened });

process.on('message', async message => {
  if (message.type === 'claim') {
    const claim = await coordinator.taskClaim({ workspace_id: opened.workspace.workspace_id, task_id: message.task_id, ttl_seconds: 600 });
    process.send({ type: 'claimed', claim });
  }
  if (message.type === 'exit') {
    await store.close();
    process.exit(0);
  }
});
