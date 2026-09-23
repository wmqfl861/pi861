import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

process.on("SIGTERM", () => {});
if (process.argv[2] === "descendant") {
	process.send?.({ ready: true });
	setInterval(() => {}, 1000);
} else {
	const descendant = spawn(process.execPath, [process.argv[1], "descendant"], {
		stdio: ["ignore", "ignore", "ignore", "ipc"],
		env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH },
	});
	await new Promise((resolve, reject) => {
		descendant.once("message", resolve);
		descendant.once("error", reject);
	});
	const lines = createInterface({ input: process.stdin });
	for await (const line of lines) {
		const input = JSON.parse(line);
		if (input.method === "hang") continue;
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: input.id, result: { parent: process.pid, descendant: descendant.pid, requestId: input.id } })}\n`);
	}
}
