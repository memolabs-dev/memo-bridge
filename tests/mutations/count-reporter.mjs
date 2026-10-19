// node:test reporter for the mutation harness. It writes one JSON line to its destination:
//   {"tests": n, "passed": [key...], "failed": [{key, failureType}...]}
// key is "<name>@<line>:<column>", stable between the baseline and the mutated run (the tests are
// never patched). Suites, skipped and todo tests are left out. The harness reads this structure,
// never the human output:
//   - a header pattern that selects no test gives tests: 0;
//   - a mutant is killed only by a test that passed in the baseline and now fails with
//     failureType 'testCodeFailure' (an assertion or an error thrown by the test body). A file
//     that cannot load reports one failure named after the file with no failureType; a timeout
//     reports 'testTimeoutFailure'; neither is a kill.
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
    else result.failed.push({ key, failureType: details?.error?.failureType ?? null });
  }
  yield `${JSON.stringify(result)}\n`;
}
