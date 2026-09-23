import { runRealAcceptance } from "../../src/live/real-acceptance.ts";

// Operator-only, default closed. Requires prior authorization for this service and data scope.
// PI861_REAL_SEARCH_ACCEPTANCE=1; PI861_REAL_SEARCH_BUDGET=1..5; BRAVE_SEARCH_API_KEY.
// One fixed public query: PostgreSQL 17 release notes. No project data or persistent files.
// Cleanup: response readers/timers close; report omits keys and response content.
const report = await runRealAcceptance("search");
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode = report.status === "failed" ? 1 : 0;
