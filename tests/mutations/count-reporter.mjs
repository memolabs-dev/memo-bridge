// node:test reporter for the mutation harness: counts the tests that actually ran (suites,
// skipped and todo tests excluded) and writes one JSON line to its destination. The harness
// reads that count, never the human output: a header pattern that selects no test is caught by
// structure (tests: 0), not by matching text. Run with --experimental-test-isolation=none so
// the runner adds no synthetic per-file test (in 'process' mode a file whose tests are all
// filtered out still reports one passing test named after the file).
export default async function* countReporter(source) {
  const count = { tests: 0, passed: 0, failed: 0 };
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { details, skip, todo } = event.data;
    if (details?.type === 'suite' || skip !== undefined || todo !== undefined) continue;
    count.tests += 1;
    if (event.type === 'test:pass') count.passed += 1; else count.failed += 1;
  }
  yield `${JSON.stringify(count)}\n`;
}
