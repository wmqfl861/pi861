import assert from "node:assert/strict";
import { test } from "node:test";
import { withHttpFixture } from "./fixtures/http-fixtures.mjs";
import { ResultStore } from "../src/result-store.ts";
import {
	extractText, resolveRedirect, validateWebTarget, webRead, WebReadFailure,
} from "../src/web-read.ts";

// Loopback literals are echoed; "localhost" maps to 127.0.0.1; every other name gets a fixed
// public address, so tests never touch real DNS or the network for foreign hosts.
const loopbackLookup = async (hostname) => {
	if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) return [hostname];
	if (hostname === "localhost") return ["127.0.0.1"];
	return ["93.184.216.34"];
};
const pinned = (answer) => async () => [answer];
const at = (fixture, path = "/") => `${fixture.url}${path}`;
const loopbackOptions = (extra = {}) => ({ allowLoopbackHttp: true, lookup: loopbackLookup, ...extra });
async function rejects(read, code, pattern) {
	await assert.rejects(read, (error) => error instanceof WebReadFailure && error.code === code &&
		(pattern === undefined || pattern.test(error.message)));
}

test("reads an html page, strips non-content markup and reports honest metadata", async () => {
	await withHttpFixture([{ path: "/", headers: { "content-type": "text/html; charset=utf-8" }, body:
		"<html><head><title>t</title><script>alert(1)</script><style>a{}</style></head>" +
		"<!-- hidden --><body><h1>Hello&nbsp;World</h1><noscript>no</noscript><p>a &amp; b &#38; c</p></body></html>",
	}], async (fixture) => {
		const found = await webRead(at(fixture), loopbackOptions({ scope: "project:alpha" }));
		assert.equal(found.body.kind, "inline");
		assert.equal(found.body.text, "t Hello World a & b & c");
		assert.equal(found.body.truncated, false);
		assert.equal(found.body.complete, true);
		assert.equal(found.contentType, "text/html");
		assert.equal(found.charset, "utf-8");
		assert.equal(found.policy, "general");
		assert.equal(found.redirects, 0);
		assert.equal(found.scope, "project:alpha");
		assert.deepEqual(found.cache, { hit: false, source: "direct" });
		assert.equal(found.untrusted, true);
		assert.ok(found.retrievedAt);
		assert.ok(found.url.endsWith("/"));
		// No credential or cookie headers ever accompany a general web read.
		const seen = fixture.requests[0];
		assert.equal(seen.headers.authorization, undefined);
		assert.equal(seen.headers.cookie, undefined);
		assert.equal(seen.headers.host, `127.0.0.1:${fixture.port}`);
	});
});

test("plain text and json bodies are returned verbatim", async () => {
	await withHttpFixture([
		{ path: "/text", headers: { "content-type": "text/plain" }, body: "line one\nline two" },
		{ path: "/json", headers: { "content-type": "application/json" }, body: "{\"a\":1}" },
	], async (fixture) => {
		const text = await webRead(at(fixture, "/text"), loopbackOptions());
		assert.equal(text.body.text, "line one\nline two");
		const json = await webRead(at(fixture, "/json"), loopbackOptions());
		assert.equal(json.body.text, "{\"a\":1}");
		assert.equal(json.contentType, "application/json");
	});
});

test("non-text and missing content types are refused", async () => {
	await withHttpFixture([
		{ path: "/png", headers: { "content-type": "image/png" }, body: "binary" },
		{ path: "/none", body: "no type" },
	], async (fixture) => {
		await rejects(() => webRead(at(fixture, "/png"), loopbackOptions()), "content_type_forbidden", /image\/png/);
		await rejects(() => webRead(at(fixture, "/none"), loopbackOptions()), "content_type_forbidden", /\(none\)/);
	});
});

test("redirects are followed with full per-hop revalidation", async () => {
	await withHttpFixture([
		{ path: "/start", status: 302, headers: { location: "/middle" } },
		{ path: "/middle", status: 302, headers: { location: "/final" } },
		{ path: "/final", headers: { "content-type": "text/html" }, body: "<p>done</p>" },
	], async (fixture) => {
		const found = await webRead(at(fixture, "/start"), loopbackOptions());
		assert.equal(found.body.text, "done");
		assert.equal(found.redirects, 2);
		assert.ok(found.url.endsWith("/final"));
	});
});

test("relative redirect targets resolve against the current hop", async () => {
	await withHttpFixture([
		{ path: "/rel", status: 303, headers: { location: "final" } },
		{ path: "/final", headers: { "content-type": "text/plain" }, body: "ok" },
	], async (fixture) => {
		const found = await webRead(at(fixture, "/rel"), loopbackOptions());
		assert.equal(found.body.text, "ok");
		assert.ok(found.url.endsWith("/final"));
	});
});

test("redirect chains beyond the limit are refused with hop count and target", async () => {
	await withHttpFixture([{ path: "/loop", status: 302, headers: { location: "/loop" } }], async (fixture) => {
		await rejects(() => webRead(at(fixture, "/loop"), loopbackOptions({ limits: { maxRedirects: 3 } })),
			"redirect_limit", /3 redirects/);
	});
});

test("a redirect to a private address is blocked even under the loopback flag", async () => {
	await withHttpFixture([
		{ path: "/start", status: 302, headers: { location: "http://192.168.1.5/inner" } },
	], async (fixture) => {
		await rejects(() => webRead(at(fixture, "/start"), loopbackOptions()), "blocked_address");
	});
});

test("redirect transition rules: downgrade refused, credentials refused, relative resolved", () => {
	assert.equal(resolveRedirect("https://a.example/x", "https://b.example/y"), "https://b.example/y");
	assert.equal(resolveRedirect("https://a.example/x/y", "z"), "https://a.example/x/z");
	assert.throws(() => resolveRedirect("https://a.example/x", "http://b.example/y"),
		(error) => error instanceof WebReadFailure && error.code === "redirect_downgrade");
	assert.throws(() => resolveRedirect("https://a.example/x", "https://user:pw@b.example/y"),
		(error) => error instanceof WebReadFailure && error.code === "credentials_in_url");
});

test("a redirect without a location header is a malformed response", async () => {
	await withHttpFixture([{ path: "/broken", status: 302, body: "" }], async (fixture) => {
		await rejects(() => webRead(at(fixture, "/broken"), loopbackOptions()), "malformed_response", /Location/);
	});
});

test("URL and address policy: private, metadata, mapped and link-local destinations are blocked", async () => {
	const check = (url, lookup, code, options = {}) => rejects(() => validateWebTarget(url, options, lookup), code);
	for (const address of ["10.1.2.3", "192.168.0.9", "172.16.0.1", "172.31.255.255", "169.254.169.254",
		"127.0.0.1", "0.0.0.0", "100.64.1.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::"]) {
		await check("https://service.example/", pinned(address), "blocked_address");
	}
	// 172.15.x sits outside 172.16/12 and stays public.
	assert.equal((await validateWebTarget("https://service.example/", {}, pinned("172.15.0.1"))).address, "172.15.0.1");
	// Loopback https is still blocked under the general policy; only the plain-http carve-out admits loopback.
	await check("https://127.0.0.1/", loopbackLookup, "blocked_address");
	assert.equal((await validateWebTarget("http://127.0.0.1:8080/", { allowLoopbackHttp: true }, loopbackLookup)).address, "127.0.0.1");
	// http without the flag, public https on a non-default port, credentials, fragments and bad URLs are all refused.
	await rejects(() => webRead("http://127.0.0.1/", { lookup: loopbackLookup }), "protocol_forbidden");
	await check("https://service.example:8443/", pinned("93.184.216.34"), "port_forbidden");
	await check("https://user:pw@service.example/", pinned("93.184.216.34"), "credentials_in_url");
	await check("https://service.example/#frag", pinned("93.184.216.34"), "invalid_url");
	await check("not-a-url", pinned("93.184.216.34"), "invalid_url");
	// Trailing-dot hosts are normalized before checks ("localhost." stays a loopback name).
	assert.equal((await validateWebTarget("http://localhost./", { allowLoopbackHttp: true }, loopbackLookup)).hostname, "localhost");
	// Windows note: "localhost" may resolve to ::1 or 127.0.0.1; both count as loopback here.
	assert.equal((await validateWebTarget("http://localhost/", { allowLoopbackHttp: true }, pinned("::1"))).address, "::1");
});

test("mixed DNS answers are judged as a whole: one private address blocks the hop", async () => {
	await rejects(() => validateWebTarget("https://service.example/", {}, async () => ["93.184.216.34", "10.0.0.7"]), "blocked_address");
	await rejects(() => validateWebTarget("http://service.example/", { allowLoopbackHttp: true }, async () => ["127.0.0.1", "93.184.216.34"]), "blocked_address");
});

test("the connection pins the validated address from a single resolution (DNS rebinding defense)", async () => {
	await withHttpFixture([{ path: "/", headers: { "content-type": "text/plain" }, body: "pinned" }], async (fixture) => {
		let lookups = 0;
		const singleAnswer = async () => {
			lookups++;
			// The injected resolver is the only path to an address. A kernel that re-resolved
			// through the real DNS for "service.example" would never reach this fixture.
			return ["127.0.0.1"];
		};
		const found = await webRead(`http://service.example:${fixture.port}/`, {
			allowLoopbackHttp: true, lookup: singleAnswer,
		});
		assert.equal(found.body.text, "pinned");
		assert.equal(lookups, 1);
		assert.equal(fixture.requests.length, 1);
	});
});

test("total and idle timeouts fire independently", async () => {
	await withHttpFixture([
		{ path: "/slow", delayMs: 1500, headers: { "content-type": "text/plain" }, body: "late" },
		{ path: "/stalled", headers: { "content-type": "text/plain" }, chunks: [{ data: "part" }, { data: "-two", delayMs: 1500 }] },
	], async (fixture) => {
		await rejects(() => webRead(at(fixture, "/slow"), loopbackOptions({ limits: { timeoutMs: 200 } })), "timeout");
		await rejects(() => webRead(at(fixture, "/stalled"), loopbackOptions({ limits: { timeoutMs: 10_000, idleTimeoutMs: 200 } })), "idle_timeout");
	});
});

test("external cancellation aborts immediately, before or during a request", async () => {
	await withHttpFixture([{ path: "/slow", delayMs: 1500, headers: { "content-type": "text/plain" }, body: "late" }], async (fixture) => {
		const pre = new AbortController();
		pre.abort(new Error("stop"));
		await rejects(() => webRead(at(fixture), loopbackOptions(), pre.signal), "cancelled", /cancelled/);
		assert.equal(fixture.requests.length, 0);
		const mid = new AbortController();
		const pending = webRead(at(fixture, "/slow"), loopbackOptions(), mid.signal);
		setTimeout(() => mid.abort(new Error("stop-mid")), 50);
		await rejects(() => pending, "cancelled", /cancelled/);
	});
});

test("oversized bodies truncate at the decoded cap with honest markers", async () => {
	await withHttpFixture([{ path: "/", headers: { "content-type": "text/plain" }, body: "x".repeat(8192) }], async (fixture) => {
		const found = await webRead(at(fixture), loopbackOptions({ limits: { maxBytes: 4096 } }));
		assert.equal(found.body.kind, "inline");
		assert.equal(found.body.text.length, 4096);
		assert.equal(found.body.truncated, true);
		assert.equal(found.body.complete, false);
	});
});

test("compressed responses decode, and compressed bombs are capped after decompression", async () => {
	await withHttpFixture([
		{ path: "/gzip", encoding: "gzip", headers: { "content-type": "text/plain" }, body: "gzip-ok" },
		{ path: "/deflate", encoding: "deflate", headers: { "content-type": "text/plain" }, body: "deflate-ok" },
		{ path: "/br", encoding: "br", headers: { "content-type": "text/plain" }, body: "br-ok" },
		{ path: "/bomb", encoding: "gzip", headers: { "content-type": "text/plain" }, body: "x".repeat(200_000) },
	], async (fixture) => {
		assert.equal((await webRead(at(fixture, "/gzip"), loopbackOptions())).body.text, "gzip-ok");
		assert.equal((await webRead(at(fixture, "/deflate"), loopbackOptions())).body.text, "deflate-ok");
		assert.equal((await webRead(at(fixture, "/br"), loopbackOptions())).body.text, "br-ok");
		const bombed = await webRead(at(fixture, "/bomb"), loopbackOptions({ limits: { maxBytes: 4096 } }));
		assert.equal(bombed.body.truncated, true);
		assert.equal(bombed.body.text.length, 4096);
	});
});

test("the raw wire byte cap is enforced independently of decompression", async () => {
	await withHttpFixture([{ path: "/", headers: { "content-type": "text/plain" }, body: "y".repeat(4096) }], async (fixture) => {
		const found = await webRead(at(fixture), loopbackOptions({ limits: { maxRawBytes: 512 } }));
		assert.equal(found.body.truncated, true);
		assert.equal(found.body.complete, false);
	});
});

test("unsupported content encodings are refused honestly", async () => {
	await withHttpFixture([{ path: "/", headers: { "content-type": "text/plain", "content-encoding": "compress" }, body: "x" }],
		async (fixture) => {
			await rejects(() => webRead(at(fixture), loopbackOptions()), "encoding_unsupported", /compress/);
		});
});

test("declared charsets are honored; broken or unknown charsets fail honestly", async () => {
	await withHttpFixture([
		{ path: "/latin1", headers: { "content-type": "text/plain; charset=iso-8859-1" }, body: Buffer.from([0x63, 0xe9, 0x64]) },
		{ path: "/badutf8", headers: { "content-type": "text/plain; charset=utf-8" }, body: Buffer.from([0x63, 0xff, 0x64]) },
		{ path: "/alien", headers: { "content-type": "text/plain; charset=x-alien-9" }, body: "x" },
	], async (fixture) => {
		const latin = await webRead(at(fixture, "/latin1"), loopbackOptions());
		assert.equal(latin.charset, "iso-8859-1");
		assert.equal(latin.body.text, "c\u00e9d");
		await rejects(() => webRead(at(fixture, "/badutf8"), loopbackOptions()), "charset_invalid");
		await rejects(() => webRead(at(fixture, "/alien"), loopbackOptions()), "charset_unsupported", /x-alien-9/);
	});
});

test("non-2xx statuses and empty bodies are reported as failures, never as content", async () => {
	await withHttpFixture([
		{ path: "/missing", status: 404, headers: { "content-type": "text/plain" }, body: "SECRET-NOT-FOUND-BODY" },
		{ path: "/boom", status: 500, body: "" },
		{ path: "/empty", status: 204 },
		{ path: "/zero", headers: { "content-type": "text/plain" }, body: "" },
	], async (fixture) => {
		await rejects(() => webRead(at(fixture, "/missing"), loopbackOptions()), "http_error", /HTTP 404/);
		await rejects(() => webRead(at(fixture, "/boom"), loopbackOptions()), "http_error", /HTTP 500/);
		await rejects(() => webRead(at(fixture, "/empty"), loopbackOptions()), "empty_body");
		await rejects(() => webRead(at(fixture, "/zero"), loopbackOptions()), "empty_body");
	});
});

test("approved internal endpoints use a separate policy and audit tag", async () => {
	await withHttpFixture([{ path: "/mcp", headers: { "content-type": "application/json" }, body: "{\"ok\":true}" }],
		async (fixture) => {
			const approved = await webRead(at(fixture, "/mcp"), {
				lookup: loopbackLookup,
				approvedEndpoints: [{ host: "127.0.0.1", port: fixture.port, purpose: "internal-mcp" }],
			});
			assert.equal(approved.policy, "approved-endpoint:internal-mcp");
			assert.equal(approved.body.text, "{\"ok\":true}");
			// Without the matching entry the same loopback endpoint stays refused, and the
			// approved list never widens the general policy for other hosts or ports.
			await rejects(() => webRead(at(fixture, "/mcp"), { lookup: loopbackLookup }), "protocol_forbidden");
			await rejects(() => webRead(at(fixture, "/mcp"), {
				lookup: loopbackLookup,
				approvedEndpoints: [{ host: "127.0.0.1", port: fixture.port + 1, purpose: "wrong-port" }],
			}), "protocol_forbidden");
			await rejects(() => webRead(at(fixture, "/mcp"), {
				lookup: loopbackLookup,
				approvedEndpoints: [{ host: "10.9.8.7", port: fixture.port, purpose: "wrong-host" }],
			}), "protocol_forbidden");
			// The approved list does not turn the general loopback flag into internal https access either.
			await rejects(() => validateWebTarget("https://127.0.0.1:8443/", { allowLoopbackHttp: true }, loopbackLookup), "blocked_address");
		});
});

test("oversized extracted bodies move to a controlled reference with owner-checked paging", async () => {
	const page = "<p>" + "word ".repeat(4000) + "</p>"; // well above the inline limit after extraction
	await withHttpFixture([{ path: "/", headers: { "content-type": "text/html" }, body: page }], async (fixture) => {
		const store = new ResultStore({ pageSize: 500 });
		const found = await webRead(at(fixture), loopbackOptions({ store, owner: "role:worker-a", limits: { inlineLimit: 1000 } }));
		assert.equal(found.body.kind, "reference");
		assert.ok(found.body.totalCharacters > 1000);
		assert.equal(found.body.truncated, false);
		const first = store.read(found.body.resultRef, "role:worker-a");
		assert.equal(first.complete, false);
		assert.equal(first.text.length, 500);
		let offset = first.nextOffset, hops = 1;
		while (!store.read(found.body.resultRef, "role:worker-a", offset).complete) {
			offset = store.read(found.body.resultRef, "role:worker-a", offset).nextOffset;
			hops++;
		}
		assert.ok(hops > 1);
		assert.throws(() => store.read(found.body.resultRef, "role:worker-b"), /Result not found/);
	});
});

test("without a store, oversized bodies degrade to an honestly truncated inline excerpt", async () => {
	await withHttpFixture([{ path: "/", headers: { "content-type": "text/plain" }, body: "z".repeat(5000) }], async (fixture) => {
		const found = await webRead(at(fixture), loopbackOptions({ limits: { inlineLimit: 100 } }));
		assert.equal(found.body.kind, "inline");
		assert.equal(found.body.text.length, 100);
		assert.equal(found.body.truncated, true);
		assert.equal(found.body.complete, false);
	});
});

test("deterministic extraction is exported and never calls a model", () => {
	assert.equal(extractText("<div>A</div><script>x</script>", "text/html"), "A");
	assert.equal(extractText("&lt;tag&gt; &quot;q&quot; &#65;", "text/html"), "<tag> \"q\" A");
	assert.equal(extractText("raw & amp;", "text/plain"), "raw & amp;");
	assert.equal(extractText("a\t\tb\n\n\n\nc", "text/html"), "a b\n\nc");
	assert.equal(extractText("<p>caf\u00e9</p>", "application/xhtml+xml"), "café");
});
