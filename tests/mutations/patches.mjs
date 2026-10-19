// Reading a mutant patch without applying it: which files it names, and what it actually changes.
// Shared by the mutation harness (tests/mutations/run.mjs, scope check before git apply) and the
// ratchet (scripts/uni-ratchet.mjs, which compares a patch of the PR with the one on main). No
// dependency and no file system access: the ratchet imports it from the base checkout without
// installing anything.
//
// The reader understands what git apply understands from a mutant: a free-text preamble (the
// `# test:` header), then per file a `diff --git` line or a `---`/`+++` pair, git's extended
// header lines, and hunks whose `@@ -a,b +c,d @@` counts say exactly how many lines they hold.
// Counting the hunk lines is what tells a removed line that starts with `-- ` from the header of
// the next file. Anything it cannot read with certainty throws: callers refuse the patch.

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const EXTENDED = /^(old mode|new mode|deleted file mode|new file mode|copy from|copy to|rename from|rename to|similarity index|dissimilarity index|index) /;

// -p1, as git apply does by default: drop the first path component (a/ or b/).
function stripComponent(raw, line) {
  const path = raw.split('\t', 1)[0];
  if (path === '/dev/null') return null;
  if (path.startsWith('"')) throw new Error(`quoted path on line ${line} (a mutant names plain paths only)`);
  const slash = path.indexOf('/');
  if (slash < 1 || slash === path.length - 1) throw new Error(`path without a leading component on line ${line}: ${path}`);
  return path.slice(slash + 1);
}

// The two paths of `diff --git a/X b/Y`. Unambiguous when X === Y; otherwise the rename/copy and
// ---/+++ lines name them too, and both readings are kept (a false extra path only refuses more).
function gitLinePaths(rest, line) {
  if (rest.includes('"')) throw new Error(`quoted path on line ${line} (a mutant names plain paths only)`);
  if (rest.length % 2 === 1) {
    const half = (rest.length - 1) / 2;
    const a = rest.slice(0, half); const b = rest.slice(half + 1);
    if (rest[half] === ' ' && a.startsWith('a/') && b.startsWith('b/') && a.slice(2) === b.slice(2)) return [a.slice(2)];
  }
  const match = /^a\/(.+?) b\/(.+)$/.exec(rest);
  if (!match) throw new Error(`unreadable "diff --git" line ${line}`);
  return [match[1], match[2]];
}

// { preamble: string[], files: [{ header: string[], paths: string[], body: string[] }] }.
// header holds the diff --git, extended and ---/+++ lines; body the hunk lines (with their @@
// line) or a binary payload. Text between files that git apply ignores is dropped.
export function parsePatch(text) {
  const lines = String(text).split('\n');
  if (lines.at(-1) === '') lines.pop();
  const preamble = [];
  const files = [];
  let file = null;
  let i = 0;
  const startFile = () => { file = { header: [], paths: [], body: [] }; files.push(file); };
  const addPath = path => { if (path !== null && !file.paths.includes(path)) file.paths.push(path); };
  while (i < lines.length) {
    const line = lines[i];
    const n = i + 1;
    if (line.startsWith('diff --git ')) {
      startFile();
      file.header.push(line);
      for (const p of gitLinePaths(line.slice('diff --git '.length), n)) addPath(p);
      i++;
      while (i < lines.length && EXTENDED.test(lines[i])) {
        const ext = lines[i];
        file.header.push(ext);
        const named = /^(?:copy|rename) (?:from|to) (.*)$/.exec(ext);
        if (named) {
          if (named[1].startsWith('"')) throw new Error(`quoted path on line ${i + 1} (a mutant names plain paths only)`);
          addPath(named[1]);
        }
        i++;
      }
      if (lines[i]?.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
        file.header.push(lines[i], lines[i + 1]);
        addPath(stripComponent(lines[i].slice(4), i + 1));
        addPath(stripComponent(lines[i + 1].slice(4), i + 2));
        i += 2;
      }
      i = readBody(lines, i, file);
      continue;
    }
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ') && HUNK.test(lines[i + 2] ?? '')) {
      startFile();
      file.header.push(line, lines[i + 1]);
      addPath(stripComponent(line.slice(4), n));
      addPath(stripComponent(lines[i + 1].slice(4), n + 1));
      i = readBody(lines, i + 2, file);
      continue;
    }
    if (HUNK.test(line)) throw new Error(`hunk on line ${n} before any file header`);
    if (!files.length) preamble.push(line);
    i++;
  }
  return { preamble, files };
}

function readBody(lines, i, file) {
  if (lines[i] === 'GIT binary patch') {
    while (i < lines.length && !lines[i].startsWith('diff --git ')) file.body.push(lines[i++]);
    return i;
  }
  while (i < lines.length && HUNK.test(lines[i])) {
    const [, , oldCount = '1', , newCount = '1'] = HUNK.exec(lines[i]);
    file.body.push(lines[i]);
    let old = Number(oldCount); let added = Number(newCount);
    i++;
    while (old > 0 || added > 0) {
      if (i >= lines.length) throw new Error(`hunk ends early at the end of the patch (${file.paths.join(', ')})`);
      const line = lines[i];
      const kind = line === '' ? ' ' : line[0];
      if (kind === ' ') { old--; added--; } else if (kind === '-') old--; else if (kind === '+') added--;
      else if (kind !== '\\') throw new Error(`unexpected line ${i + 1} inside a hunk: ${line.slice(0, 60)}`);
      if (old < 0 || added < 0) throw new Error(`hunk on line ${i + 1} holds more lines than its @@ header says`);
      file.body.push(line);
      i++;
    }
    while (lines[i]?.startsWith('\\')) file.body.push(lines[i++]);
  }
  return i;
}

// Every path the patch names (old and new side of a rename or copy included), or throws.
export function patchPaths(text) {
  const { files } = parsePatch(text);
  if (!files.length) throw new Error('the patch names no file');
  return [...new Set(files.flatMap(f => f.paths))];
}

// What a mutant does, without where it lands: the `# test:` header lines, each file's header
// (paths, modes, renames; never the `index` blob ids or similarity scores, which move with the
// code) and the -/+ lines of its hunks in order. Context lines, @@ line numbers and the other
// comment lines are left out, so a patch re-anchored on moved code keeps its signature; a changed
// `# test:` pattern, target file or -/+ line does not. Throws when the patch cannot be read.
export function patchSignature(text) {
  const { preamble, files } = parsePatch(text);
  if (!files.length) throw new Error('the patch names no file');
  const signature = preamble.filter(line => line.startsWith('# test:')).map(line => line.trimEnd());
  for (const file of files) {
    signature.push(...file.header.filter(line => !/^(index|similarity index|dissimilarity index) /.test(line)));
    if (file.body[0] === 'GIT binary patch') signature.push(...file.body);
    else signature.push(...file.body.filter(line => line.startsWith('-') || line.startsWith('+')));
  }
  return signature;
}

const TEST_SUFFIX = '.test.mjs';

// Ruling 4: a mutant <name>.patch targets tests/invariants/<prefix>.test.mjs for the LONGEST
// invariant <prefix> such that <name> starts with "<prefix>-". Takes invariant names (without
// .test.mjs) and patch file names; returns { map: Map<invariant, patch[]>, orphans: patch[] }.
export function assignMutants(invariants, patchFiles) {
  const names = [...invariants].sort();
  const map = new Map(names.map(n => [n, []]));
  const orphans = [];
  for (const file of [...patchFiles].filter(n => n.endsWith('.patch')).sort()) {
    const name = file.slice(0, -'.patch'.length);
    const target = names.filter(inv => name.startsWith(`${inv}-`) && name.length > inv.length + 1)
      .sort((a, b) => b.length - a.length)[0];
    if (target) map.get(target).push(file); else orphans.push(file);
  }
  return { map, orphans };
}
export const invariantName = file => (file.endsWith(TEST_SUFFIX) ? file.slice(0, -TEST_SUFFIX.length) : null);
