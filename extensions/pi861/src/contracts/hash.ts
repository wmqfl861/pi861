import { createHash } from "node:crypto";

/** Canonical JSON encoding shared by every contract fingerprint. Identical semantics to src/memory.ts. */
export function canonical(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
			.join(",")}}`;
	}
	throw new Error("Only finite, plain JSON is accepted");
}

export function digest(value: unknown): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}
