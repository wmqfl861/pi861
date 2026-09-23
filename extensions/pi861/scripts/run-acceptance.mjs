import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
	parseAcceptanceConfig,
	parseAcceptanceManifest,
	runAcceptance,
	validateWorkerPairEvidence,
} from "../src/live/acceptance.ts";

// Trusted operator-only acceptance runner. Two modes:
//   Suite:     node scripts/run-acceptance.mjs --suite <unit|hosts|pg17|mcp|web|workers|ax|local> --manifest ABS --evidence ABS
//   Positional node scripts/run-acceptance.mjs ABS_CONFIG ABS_REPORT_JSON [ABS_REPORT_MD]
// Commands execute only from the trusted manifest/config, in the configured artifact workspace,
// with PATH/SystemRoot plus explicitly whitelisted environment names. Real external services
// (scripts/real-acceptance/*) are never reachable from here: their scripts are refused and
// their PI861_REAL_* opt-ins cannot be passed through suite manifests. The runner exits 0
// only when every required check passed; skip, not-run, missing or timed-out checks never pass.

const arguments_ = process.argv.slice(2);

function fenced(text) {
	return "````text\n" + (text ? `${text.replace(/\n$/, "")}\n\n` : "\n") + "````";
}

function renderMarkdown(report, header) {
	const lines = [
		"# pi861 acceptance report",
		"",
		`- Status: **${report.status}**`,
		...(header?.suite ? [`- Suite: ${header.suite}`] : []),
		`- Started: ${report.startedAt}`,
		`- Code SHA: \`${report.codeSha}\``,
		`- Workspace: \`${report.workspace}\``,
		`- Workspace digest: \`${report.workspaceDigest}\``,
		`- Workspace changed: ${report.workspaceChanged}`,
		`- Environment: node ${report.environment.node}, platform ${report.environment.platform}, arch ${report.environment.arch}`,
		`- Outcomes: pass ${report.outcomes.pass}, fail ${report.outcomes.fail}, skip ${report.outcomes.skip}, not-run ${report.outcomes["not-run"]}, blocked ${report.outcomes.blocked}`,
		"- Independent review: not-performed",
	];
	if (header?.requiredChecks?.length) {
		lines.push("", "## Required checks", "");
		for (const item of header.requiredChecks)
			lines.push(`- ${item.id}: **${item.status}** (outcome: ${item.outcome})`);
	}
	if (header?.workerPair)
		lines.push(
			"",
			"## Worker pair",
			"",
			`- Valid: ${header.workerPair.valid}`,
			`- Workers: ${header.workerPair.workers}`,
			`- Distinct pids: ${header.workerPair.distinctPids}`,
			`- Distinct workspaces: ${header.workerPair.distinctWorkspaces}`,
			...(header.workerPair.reason ? [`- Reason: ${header.workerPair.reason}`] : []),
		);
	lines.push("", "## Checks");
	for (const check of report.checks) {
		lines.push(
			"",
			`### ${check.id}`,
			"",
			`- Kind: ${check.kind}`,
			`- Status: ${check.status} (outcome: ${check.outcome})`,
			`- Exit code: ${check.exitCode ?? "none"}; termination: ${check.termination}`,
			`- Command digest: \`${check.commandDigest}\``,
			`- Evidence: \`${check.evidence}\``,
			`- Environment: ${check.environmentNames.join(", ")}`,
		);
		if (check.counts)
			lines.push(
				`- Tests: ${check.counts.tests}, Passed: ${check.counts.passed}, Failed: ${check.counts.failed}, Skipped: ${check.counts.skipped}, Cancelled: ${check.counts.cancelled}, Todo: ${check.counts.todo}`,
			);
		lines.push(
			"",
			"Command:",
			"",
			fenced(JSON.stringify([check.command, ...check.args], null, 2)),
			"",
			"Stdout:",
			"",
			fenced(check.stdout),
			"",
			"Stderr:",
			"",
			fenced(check.stderr),
		);
	}
	return `${lines.join("\n")}\n`;
}

function distinctPaths(paths) {
	return new Set(paths).size === paths.length;
}

async function runSuiteMode() {
	const flags = new Map();
	for (let index = 0; index < arguments_.length; index += 2) {
		const name = arguments_[index];
		if (!name?.startsWith("--") || !arguments_[index + 1]) throw new Error(`Malformed runner flags near ${name ?? "end"}`);
		flags.set(name, arguments_[index + 1]);
	}
	const suite = flags.get("--suite"),
		manifestPath = flags.get("--manifest"),
		evidencePath = flags.get("--evidence");
	if (suite === undefined || manifestPath === undefined || evidencePath === undefined)
		throw new Error("Suite mode requires --suite, --manifest and --evidence");
	for (const [name, value] of flags) {
		if (name !== "--suite" && name !== "--manifest" && name !== "--evidence") throw new Error(`Unknown flag ${name}`);
		if (name !== "--suite" && !isAbsolute(value)) throw new Error(`${name} requires an absolute path`);
	}
	if (!distinctPaths([manifestPath, evidencePath])) throw new Error("Manifest and evidence paths must be distinct");

	const manifest = parseAcceptanceManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
	if (manifest.suite !== suite) throw new Error(`Manifest suite ${manifest.suite} does not match requested suite ${suite}`);
	for (const check of manifest.checks)
		if (check.command.includes("real-acceptance") || check.args.some((argument) => argument.includes("real-acceptance")))
			throw new Error(`Check ${check.id} routes to the default-closed real-service scripts; suites cannot invoke them`);

	const passthrough = {};
	for (const name of manifest.environmentNames)
		if (process.env[name] !== undefined) passthrough[name] = process.env[name];
	const checks = manifest.checks.map((check) => ({ ...check, env: { ...passthrough, ...check.env } }));

	let workerPair;
	if (manifest.suite === "workers") {
		try {
			workerPair = validateWorkerPairEvidence(JSON.parse(readFileSync(manifest.workerPairEvidence, "utf8")));
		} catch {
			workerPair = { valid: false, workers: 0, distinctPids: false, distinctWorkspaces: false, reason: "unreadable worker pair evidence" };
		}
	}

	const acceptance = await runAcceptance({ workspace: manifest.workspace, checks, expectedCommit: manifest.expectedCommit });
	const byId = new Map(acceptance.checks.map((check) => [check.id, check]));
	const requiredChecks = manifest.requiredChecks.map((id) => ({
		id,
		status: byId.get(id)?.status ?? "not-run",
		outcome: byId.get(id)?.outcome ?? "not-run",
	}));
	const missing = requiredChecks.filter((item) => item.status === "not-run").length > 0,
		unpassed = requiredChecks.some((item) => item.status !== "passed");
	const status =
		missing || unpassed || workerPair?.valid === false || acceptance.status === "failed"
			? "failed"
			: acceptance.status === "incomplete"
				? "incomplete"
				: "passed";
	const evidence = {
		version: 1,
		suite,
		startedAt: acceptance.startedAt,
		manifestPath,
		environmentNames: manifest.environmentNames,
		...(workerPair ? { workerPair } : {}),
		requiredChecks,
		status,
		acceptance,
	};
	writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
	writeFileSync(`${evidencePath}.md`, renderMarkdown(acceptance, { suite, requiredChecks, workerPair }), { mode: 0o600 });
	process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
	process.exitCode = status === "passed" ? 0 : 1;
}

async function runPositionalMode() {
	const [configPath, reportPath, markdownPath] = arguments_;
	if (!configPath || !isAbsolute(configPath)) throw new Error("Absolute config path required");
	if (!reportPath || !isAbsolute(reportPath)) throw new Error("Absolute report path required");
	if (markdownPath && !isAbsolute(markdownPath)) throw new Error("Absolute markdown path required");
	const markdown = markdownPath ?? (reportPath.endsWith(".json") ? `${reportPath.slice(0, -".json".length)}.md` : `${reportPath}.md`);
	if (!distinctPaths([configPath, reportPath, markdown]))
		throw new Error("Config and report paths must be distinct");
	const report = await runAcceptance(parseAcceptanceConfig(JSON.parse(readFileSync(configPath, "utf8"))));
	const text = JSON.stringify(report, null, 2);
	writeFileSync(reportPath, `${text}\n`, { mode: 0o600 });
	writeFileSync(markdown, renderMarkdown(report), { mode: 0o600 });
	process.stdout.write(`${text}\n`);
	process.exitCode = report.status === "passed" ? 0 : 1;
}

try {
	if (arguments_[0] === "--suite") await runSuiteMode();
	else await runPositionalMode();
} catch (error) {
	process.stderr.write(`Acceptance could not run: ${error instanceof Error ? error.message : "unknown error"}\n`);
	process.exitCode = 1;
}
