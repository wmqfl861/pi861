import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

// P1-Q adversarial HTTP fixture for web-security tests (K6, reused by P2-E). Real loopback
// server on an ephemeral port, no credentials, fully deterministic. Behaviors are selected by
// the request path so tests can point a URL at the fixture directly:
//
//   /redirect?to=<url>[&status=301|302|307]  redirect to an arbitrary location (use private or
//                                             metadata URLs to assert the client refuses them)
//   /hang                                    accept the request, never respond (timeout injection)
//   /drip?chunks=5&delay=100                 paced chunks, then end (slow-response injection)
//   /status?code=503&body=text               fixed status and body
//   /proxy?target=<url>&rebindAfter=1&alt=<url>
//                                            forward proxy hop: the first rebindAfter+1 requests
//                                            fetch target, later requests fetch alt. This models
//                                            DNS rebinding (the target address changes between
//                                            connections) without touching the host resolver.
//
// Every connection and request is counted so tests can assert zero-attempt guarantees
// (R5.12: unauthorized requests must produce zero connections and zero HTTP attempts).

export function startFaultProxy() {
	const connections = [];
	const requests = [];
	const server = createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("error", () => {});
		request.on("end", () => {
			const url = new URL(request.url ?? "/", "http://fixture.invalid");
			requests.push({ method: request.method, path: url.pathname, query: url.searchParams, body: Buffer.concat(chunks).toString("utf8") });
			if (url.pathname === "/redirect") {
				const to = url.searchParams.get("to");
				if (!to) {
					response.writeHead(400, { "content-type": "text/plain" });
					response.end("missing to");
					return;
				}
				const status = Number(url.searchParams.get("status") ?? "302");
				response.writeHead(status >= 300 && status < 400 ? status : 302, { location: to });
				response.end();
				return;
			}
			if (url.pathname === "/hang") {
				// Intentionally never respond; the socket stays open until the client aborts.
				return;
			}
			if (url.pathname === "/drip") {
				const total = Number(url.searchParams.get("chunks") ?? "5");
				const delayMs = Number(url.searchParams.get("delay") ?? "100");
				response.writeHead(200, { "content-type": "text/plain" });
				let sent = 0;
				const sendNext = () => {
					if (sent >= total) {
						response.end();
						return;
					}
					sent += 1;
					response.write(`chunk-${sent}\n`);
					setTimeout(sendNext, Number.isSafeInteger(delayMs) && delayMs > 0 ? delayMs : 100);
				};
				sendNext();
				return;
			}
			if (url.pathname === "/status") {
				const code = Number(url.searchParams.get("code") ?? "503");
				response.writeHead(Number.isSafeInteger(code) && code > 0 ? code : 503, { "content-type": "text/plain" });
				response.end(url.searchParams.get("body") ?? "fixture status");
				return;
			}
			if (url.pathname === "/proxy") {
				const target = url.searchParams.get("target");
				const alt = url.searchParams.get("alt") ?? target;
				const rebindAfter = Number(url.searchParams.get("rebindAfter") ?? "0");
				const sameHost = requests.filter((item) => item.path === "/proxy" && item.query.get("target") === target).length;
				const destination = sameHost > rebindAfter + 1 ? alt : target;
				if (!destination) {
					response.writeHead(400, { "content-type": "text/plain" });
					response.end("missing target");
					return;
				}
				const upstream = new URL(destination);
				const upstreamRequest = upstream.protocol === "https:" ? httpsRequest(upstream, { method: "GET" }) : httpRequest(upstream, { method: "GET" });
				upstreamRequest.on("response", (upstreamResponse) => {
					response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
					upstreamResponse.on("data", (chunk) => response.write(chunk));
					upstreamResponse.on("end", () => response.end());
				});
				upstreamRequest.on("error", () => {
					if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
					response.end("fixture upstream failure");
				});
				upstreamRequest.end();
				return;
			}
			response.writeHead(404, { "content-type": "text/plain" });
			response.end("no fixture behaviour");
		});
	});
	server.on("connection", (socket) => {
		connections.push({ remoteAddress: socket.remoteAddress ?? "", at: Date.now() });
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = server.address().port;
			resolve({
				url: `http://127.0.0.1:${port}`,
				port,
				connections,
				requests,
				close: () =>
					new Promise((done) => {
						server.closeAllConnections();
						server.close(() => done());
					}),
			});
		});
	});
}

export async function withFaultProxy(run) {
	const fixture = await startFaultProxy();
	try {
		return await run(fixture);
	} finally {
		await fixture.close();
	}
}
