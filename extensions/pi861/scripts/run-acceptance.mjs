import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseAcceptanceConfig, runAcceptance } from "../src/live/acceptance.ts";

// Trusted operator-only CLI: node scripts/run-acceptance.mjs ABSOLUTE_CONFIG [ABSOLUTE_REPORT_JSON]
// Commands execute in the configured artifact workspace with only PATH/SystemRoot and explicit env.
const [configPath, reportPath] = process.argv.slice(2);
try {
	if (!configPath || !isAbsolute(configPath) || (reportPath && !isAbsolute(reportPath)))
		throw new Error("Absolute config/report paths required");
	const report = await runAcceptance(parseAcceptanceConfig(JSON.parse(readFileSync(configPath, "utf8"))));
	const text = JSON.stringify(report, null, 2);
	if (reportPath) writeFileSync(reportPath, `${text}\n`, { mode: 0o600 });
	process.stdout.write(`${text}\n`);
	process.exitCode = report.status === "passed" ? 0 : 1;
} catch {
	process.stderr.write("Acceptance could not run; check the trusted config and artifact workspace.\n");
	process.exitCode = 1;
}
