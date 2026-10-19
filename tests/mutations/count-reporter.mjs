// node:test reporter for the mutation harness. It writes one JSON line to its destination:
//   {"tests": n, "passed": [key...], "failed": [{key, failureType, assertion, error}...]}
// key is "<name>@<line>:<column>", stable between the baseline and the mutated run (the tests are
// never patched). Suites, skipped and todo tests are left out. The harness reads this structure,
// never the human output:
//   - a header pattern that selects no test gives tests: 0;
//   - a mutant is killed only by a test that passed in the baseline and now fails with
//     failureType 'testCodeFailure' AND assertion: true, i.e. what the test threw is an
//     AssertionError (code ERR_ASSERTION). error names what was thrown (AssertionError, TypeError,
//     ...). A TypeError from production code, a file that cannot load (one failure named after the
//     file with no failureType) and a timeout ('testTimeoutFailure') are never a kill.
// Run with --experimental-test-isolation=none so the runner adds no synthetic per-file test (in
// 'process' mode a file whose tests are all filtered out still reports one passing test named
// after the file).
export default async function* countReporter(source) {
  const result = { tests: 0, passed: [], failed: [] };
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { name, line, column, details, skip, todo } = event.data;
    if (details?.type === 'suite' || skip !== undefined || todo !== undefined) continue;
    result.tests += 1;
    const key = `${name}@${line}:${column}`;
    if (event.type === 'test:pass') result.passed.push(key);
    else {
      const error = details?.error;
      const thrown = error?.cause ?? error;
      const assertion = [thrown, error].some(e => e?.code === 'ERR_ASSERTION' || e?.name === 'AssertionError');
      result.failed.push({ key, failureType: error?.failureType ?? null, assertion, error: thrown?.name ?? thrown?.code ?? null });
    }
  }
  yield `${JSON.stringify(result)}\n`;
}
