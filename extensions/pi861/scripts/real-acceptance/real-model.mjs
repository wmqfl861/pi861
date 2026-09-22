import { runRealAcceptance } from "../../src/live/real-acceptance.ts";

// Operator-only, default closed; running this requires explicit prior model/spend authorization.
// PI861_REAL_MODEL_ACCEPTANCE=1; PI861_REAL_MODEL_BUDGET=1..5; PI861_REAL_MODEL_ID;
// PI861_REAL_MODEL_URL=approved HTTPS Chat Completions endpoint; PI861_REAL_MODEL_KEY_ENV=key variable name.
// One fixed public prompt, max_tokens=8, no tools/stream/retries. This does not alter model configuration.
// No files or business data; readers/timers close and the report omits credentials and generated text.
const report = await runRealAcceptance("model");
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode = report.status === "failed" ? 1 : 0;
