import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(process.cwd());
// The server and the detached job runner it starts from its own directory ship together.
const bundled = ['plugin/server/dist/index.mjs', 'plugin/server/dist/job-runner.mjs'].map(file => join(root, file));
if (!bundled.every(file => existsSync(file))) {
  console.error('First run npm run build');
  process.exit(1);
}
const zipPath = join(root, 'dist/memo-bridge-plugin-portable.zip');
mkdirSync(join(root,'dist'),{recursive:true});
const stage = mkdtempSync(join(tmpdir(),'memo-bridge-pkg-'));
try {
  const dest = join(stage, 'memo-bridge');
  cpSync(join(root,'plugin'), dest, {recursive:true});
  const python = [
    'import zipfile, pathlib, sys',
    'root=pathlib.Path(sys.argv[1]); output=sys.argv[2]',
    'with zipfile.ZipFile(output,"w",zipfile.ZIP_DEFLATED,compresslevel=9) as z:',
    '  for p in root.rglob("*"):',
    '    if p.is_file(): z.write(p,p.relative_to(root))'
  ].join('\n');
  const cmd = spawnSync('python3', ['-c', python, stage, zipPath], {encoding:'utf8'});
  if (cmd.status !== 0) throw new Error(cmd.stderr || 'Packaging failed');
  console.log(zipPath);
} finally { rmSync(stage,{recursive:true,force:true}); }
