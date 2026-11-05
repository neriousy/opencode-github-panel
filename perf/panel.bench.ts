import { bench, script } from "@hona/strobe"

// The panel's CPU work that grows with the repository: the History graph and a pull request's diff.
//   bunx strobe bench perf/panel.bench.ts --check
//   bunx strobe bench perf/panel.bench.ts --base origin/main --head .
export default bench({
  targets: { work: script("./harness.ts") },
  params: { size: { run: [300], more: [3000] } },
  cases: {
    graph: { primary: "cpu.work", run: ({ call, params }) => call("graph", params.size) },
    diff: { primary: "cpu.work", run: ({ call, params }) => call("diff", Math.round(params.size / 10)) },
  },
})
