import { createHash } from "node:crypto";
import type { ExecutionIdentity } from "./identity.ts";
import { isValidScope, validateExecutionIdentity } from "./identity.ts";

/**
 * C7 artifact contract: controlled references to large or sensitive results. Content is stored
 * out-of-band; consumers receive integrity-checked, scope-guarded, bounded windows instead of
 * raw bytes. Revocation (grant withdrawal, task teardown) makes later reads fail uniformly with
 * missing artifacts, so existence is not leaked through error shapes.
 */

export interface ArtifactReference {
	artifactId: string;
	contentDigest: string;
	byteSize: number;
	scope: string;
	producedBy: ExecutionIdentity;
	producedAt: number;
}

export interface ArtifactWindow {
	artifactId: string;
	offset: number;
	length: number;
	totalBytes: number;
	/** True when this window covers every byte of the artifact. */
	complete: boolean;
	content: Uint8Array;
}

export class ArtifactUnavailable extends Error {
	constructor(artifactId: string) {
		super(`Artifact not available: ${artifactId}`);
	}
}

export function contentDigestOf(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

export function verifyArtifactContent(content: Uint8Array, reference: ArtifactReference): boolean {
	return content.length === reference.byteSize && contentDigestOf(content) === reference.contentDigest;
}

/**
 * In-memory reference implementation. Real deployments back it with the storage service; the
 * contract semantics (integrity, scope check, bounded windows, uniform revocation failures) are
 * what M2/M3/M5 integrate against.
 */
export class ControlledArtifactStore {
	private readonly artifacts = new Map<string, { reference: ArtifactReference; content: Uint8Array }>();
	private readonly revoked = new Set<string>();
	private readonly limits: { maxArtifactBytes: number };

	constructor(limits: { maxArtifactBytes: number } = { maxArtifactBytes: 32 * 1024 * 1024 }) {
		if (!Number.isSafeInteger(limits.maxArtifactBytes) || limits.maxArtifactBytes < 1) throw new Error("Invalid artifact size limit");
		this.limits = limits;
	}

	put(content: Uint8Array | string, meta: { scope: string; producedBy: ExecutionIdentity; artifactId?: string; now: number }): ArtifactReference {
		const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
		if (!bytes.length || bytes.byteLength > this.limits.maxArtifactBytes) throw new Error("Artifact content is empty or over the size limit");
		if (!isValidScope(meta.scope) || !Number.isFinite(meta.now)) throw new Error("Invalid artifact metadata");
		validateExecutionIdentity(meta.producedBy);
		const artifactId = meta.artifactId ?? `art-${contentDigestOf(bytes).slice(0, 24)}`;
		const existing = this.artifacts.get(artifactId);
		if (existing) {
			if (existing.reference.contentDigest !== contentDigestOf(bytes)) throw new Error("Artifact ids are immutable");
			return { ...existing.reference };
		}
		if (this.revoked.has(artifactId)) throw new Error("Artifact id was revoked and cannot be rewritten");
		const reference: ArtifactReference = {
			artifactId, contentDigest: contentDigestOf(bytes), byteSize: bytes.byteLength,
			scope: meta.scope, producedBy: structuredClone(meta.producedBy), producedAt: meta.now,
		};
		this.artifacts.set(artifactId, { reference, content: new Uint8Array(bytes) });
		return { ...reference };
	}

	describe(artifactId: string, viewer: { readScopes: string[] }): ArtifactReference {
		const entry = this.requireViewable(artifactId, viewer);
		return { ...entry.reference };
	}

	window(artifactId: string, viewer: { readScopes: string[] }, offset: number, length: number): ArtifactWindow {
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1) {
			throw new Error("Artifact windows need non-negative offsets and positive lengths");
		}
		const entry = this.requireViewable(artifactId, viewer);
		const start = Math.min(offset, entry.content.length);
		const end = Math.min(offset + length, entry.content.length);
		const slice = entry.content.slice(start, end);
		return {
			artifactId, offset: start, length: slice.length, totalBytes: entry.content.length,
			complete: start === 0 && end === entry.content.length,
			content: slice,
		};
	}

	revoke(artifactId: string): void {
		if (!artifactId) throw new Error("Artifact id required");
		this.revoked.add(artifactId);
		this.artifacts.delete(artifactId);
	}

	private requireViewable(artifactId: string, viewer: { readScopes: string[] }): { reference: ArtifactReference; content: Uint8Array } {
		if (!artifactId || !viewer.readScopes?.length) throw new Error("Invalid artifact viewer");
		const entry = this.artifacts.get(artifactId);
		// Missing, revoked and out-of-scope all fail identically; existence must not leak.
		if (!entry || !viewer.readScopes.includes(entry.reference.scope)) throw new ArtifactUnavailable(artifactId);
		return entry;
	}
}
