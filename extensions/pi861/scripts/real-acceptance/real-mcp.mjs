import { runRealAcceptance } from "../../src/live/real-acceptance.ts";

// Operator-only, default closed; explicit prior authorization for the exact MCP endpoint/account required.
// PI861_REAL_MCP_ACCEPTANCE=1; PI861_REAL_MCP_BUDGET=3..5;
// PI861_REAL_MCP_URL=approved HTTPS endpoint; PI861_REAL_MCP_KEY_ENV=key variable name.
// Three requests: initialize, initialized notification, one tools/list page. No tools/call or business writes.
// JSON responses only; an SSE-only endpoint fails honestly. No files/response content retained.
// Local readers/timers close; server-side session expiry remains the service's responsibility.
const report = await runRealAcceptance("mcp");
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode = report.status === "failed" ? 1 : 0;
