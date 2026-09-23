/**
 * Deterministic first-pass text extraction (R7.6). Single linear scan, no backtracking
 * and no repeated whole-string passes, so a bounded malformed page can never monopolize
 * a CPU: every input character is examined a bounded number of times. No DOM-level
 * intelligence and never a model call. In production this runs inside the controlled
 * extraction boundary (src/live/web-extract-process.ts), never on the host event loop.
 */
const namedEntities: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function printCodePoint(code: number, fallback: string): string {
	if (!Number.isSafeInteger(code) || code < 9 || code > 0x10ffff) return fallback;
	try {
		return String.fromCodePoint(code);
	} catch {
		return fallback;
	}
}
function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string): string => {
		if (body.startsWith("#x") || body.startsWith("#X"))
			return printCodePoint(Number.parseInt(body.slice(2), 16), match);
		if (body.startsWith("#")) return printCodePoint(Number.parseInt(body.slice(1), 10), match);
		const named = namedEntities[body];
		return named !== undefined ? named : match;
	});
}
export function isHtmlLikeMime(mime: string): boolean {
	return (
		mime === "text/html" ||
		mime === "application/xhtml+xml" ||
		mime === "application/xml" ||
		mime === "text/xml" ||
		mime.endsWith("+xml")
	);
}
function isAsciiLetter(code: number): boolean {
	return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
}
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(["script", "style", "noscript"]);
/** Consume a tag starting at {@link start} ("<..."), up to and including its ">" (or to end of input). */
function skipTag(body: string, start: number): number {
	const end = body.indexOf(">", start + 1);
	return end === -1 ? body.length : end + 1;
}
/** Consume raw element content plus its closing tag; unterminated content is dropped to the end. */
function skipRawText(lower: string, from: number, close: string, length: number): number {
	let at = lower.indexOf(close, from);
	while (at !== -1) {
		const after = at + close.length;
		const code = after < length ? lower.charCodeAt(after) : -1;
		if (code === -1 || code === 0x3e /* > */ || code === 0x2f /* / */ || code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
			const end = lower.indexOf(">", after);
			return end === -1 ? length : end + 1;
		}
		at = lower.indexOf(close, at + 1);
	}
	return length;
}
/** Deterministic linear extraction; exported for direct testing and the extraction child. */
export function extractText(body: string, mime: string): string {
	if (!isHtmlLikeMime(mime)) return body.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
	const lower = body.toLowerCase(); // one precomputed copy; every name scan below is a forward-only indexOf
	const pieces: string[] = [];
	let pendingSpace = false; // a dropped separator may yield at most one space before more text
	let newlineRun = 0; // consecutive newlines kept, capped at two
	const emitText = (run: string): void => {
		const decoded = decodeEntities(run);
		for (let i = 0; i < decoded.length; i++) {
			const code = decoded.charCodeAt(i);
			if (code === 0x20 || code === 0x09) {
				if (newlineRun === 0) pendingSpace = true;
			} else if (code === 0x0a || code === 0x0d) {
				pendingSpace = false;
				if (newlineRun < 2) {
					pieces.push("\n");
					newlineRun += 1;
				}
				if (code === 0x0d && decoded.charCodeAt(i + 1) === 0x0a) i += 1;
			} else if (code <= 0x1f || code === 0x7f) {
				// control characters never reach extracted text
			} else {
				if (pendingSpace) pieces.push(" ");
				pendingSpace = false;
				newlineRun = 0;
				pieces.push(decoded.slice(i, i + 1));
			}
		}
	};
	const separator = (): void => {
		if (newlineRun === 0) pendingSpace = true;
	};
	let i = 0;
	while (i < body.length) {
		const open = body.indexOf("<", i);
		if (open === -1) {
			emitText(body.slice(i));
			break;
		}
		if (open > i) emitText(body.slice(i, open));
		const next = open + 1 < body.length ? body.charCodeAt(open + 1) : -1;
		if (next === 0x21 /* ! */ || next === 0x2f /* / */ || (next >= 0x30 && next <= 0x39) /* digit */) {
			if (body.startsWith("<!--", open)) {
				const end = body.indexOf("-->", open + 4);
				i = end === -1 ? body.length : end + 3;
			} else i = skipTag(body, open);
			separator();
			continue;
		}
		if (next === 0x3f /* ? */) {
			i = skipTag(body, open);
			separator();
			continue;
		}
		if (isAsciiLetter(next)) {
			let end = open + 1;
			while (end < body.length && isAsciiLetter(body.charCodeAt(end))) end += 1;
			const name = lower.slice(open + 1, end);
			if (RAW_TEXT_ELEMENTS.has(name)) {
				const afterOpen = skipTag(body, open);
				i = afterOpen >= body.length ? afterOpen : skipRawText(lower, afterOpen, `</${name}`, body.length);
			} else i = skipTag(body, open);
			separator();
			continue;
		}
		emitText("<"); // "<" not starting markup stays literal text
		i = open + 1;
	}
	return pieces.join("").trim();
}
