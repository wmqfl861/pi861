// Adapted from the independent M5 review fixture
// C:\Albert\project\pi861-briefs\m5-review-457ccf2\fixture-extraction.mjs (do not modify the original).
// It measures the real wall clock of extractText on N bytes of malformed HTML ("&lt;" repeated).
import { extractText } from "../../src/web-extract.ts";
const bytes = Number(process.argv[2] ?? "100000");
const input = "<".repeat(bytes);
const start = performance.now();
const output = extractText(input, "text/html");
console.log(JSON.stringify({ bytes, milliseconds: Math.round(performance.now() - start), outputLength: output.length }));
