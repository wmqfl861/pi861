import { createServer } from "node:http";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";

/**
 * Deterministic local HTTP fixture server for search-backend and web-read tests.
 * Binds 127.0.0.1 on an ephemeral port; routes match on method plus path-without-query.
 * Routes: { method?, path (exact or "*"), status?, headers?, body? (string|Buffer),
 * delayMs? (before response), encoding? ("gzip"|"deflate"|"br"),
 * chunks? ([{ data, delayMs }]) for paced streaming }.
 */
const encoders = { gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync };

export function startHttpFixture(routes) {
	const requests = [];
	const server = createServer((request, response) => {
		const received = [];
		request.on("data", (chunk) => received.push(chunk));
		request.on("error", () => {});
		request.on("end", () => {
			requests.push({ method: request.method, url: request.url, headers: { ...request.headers }, body: Buffer.concat(received).toString("utf8") });
			const pathOnly = (request.url ?? "").split("?")[0];
			const route = routes.find((candidate) => (candidate.method ?? "GET") === request.method &&
				(candidate.path === "*" || candidate.path === pathOnly));
			if (!route) {
				response.writeHead(404, { "content-type": "text/plain" });
				response.end("no fixture route");
				return;
			}
			const reply = () => {
				const headers = { ...(route.headers ?? {}) };
				let body = route.body ?? "";
				if (typeof body === "string" && route.encoding) {
					const encode = encoders[route.encoding];
					if (!encode) { response.writeHead(500, { "content-type": "text/plain" }); response.end("unknown fixture encoding"); return; }
					body = encode(Buffer.from(body, "utf8"));
					headers["content-encoding"] = route.encoding;
				}
				response.writeHead(route.status ?? 200, headers);
				if (route.chunks) {
					let index = 0;
					const sendNext = () => {
						if (index >= route.chunks.length) { response.end(); return; }
						const piece = route.chunks[index++];
						setTimeout(() => { response.write(piece.data); sendNext(); }, piece.delayMs ?? 0);
					};
					sendNext();
				} else response.end(body);
			};
			if (route.delayMs) setTimeout(reply, route.delayMs);
			else reply();
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({
				url: `http://127.0.0.1:${server.address().port}`,
				port: server.address().port,
				requests,
				close: () => new Promise((done) => {
					server.closeAllConnections();
					server.close(() => done());
				}),
			});
		});
	});
}

export async function withHttpFixture(routes, run) {
	const fixture = await startHttpFixture(routes);
	try {
		return await run(fixture);
	} finally {
		await fixture.close();
	}
}
