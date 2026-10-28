// Parse exactly the Git index snapshot, not potentially different worktree files.
import { spawnSync } from 'node:child_process';

function git(args) {
  const result = spawnSync('git', args, { maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || Buffer.from('git index read failed\n'));
    process.exit(1);
  }
  return result.stdout;
}

const paths = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
  .toString('utf8').split('\0').filter(Boolean);
let errors = 0;
for (const path of paths) {
  if (!/\.(?:mjs|cjs|js|json)$/.test(path)) continue;
  const staged = git(['show', ':' + path]);
  if (path.endsWith('.json')) {
    try { JSON.parse(staged.toString('utf8')); }
    catch (error) {
      console.error('Invalid staged JSON:', path, error.message);
      errors++;
    }
    continue;
  }
  const mode = path.endsWith('.cjs') ? 'commonjs' : 'module';
  const check = spawnSync(process.execPath, ['--check', '--input-type=' + mode], {
    input: staged, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (check.status !== 0) {
    console.error('Invalid staged JavaScript:', path);
    console.error(check.stderr || check.stdout);
    errors++;
  }
}
if (errors) process.exit(1);
console.log('staged JS/JSON syntax: OK');
