import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ToolBinding } from "../capabilities.ts";
import { record } from "../search.ts";

/**
 * H-owned loader for trusted behavioral Skill publication cases (C7 evidence, R4.9).
 * Cases come only from an operator-provided absolute JSON file referenced by
 * PI861_SKILL_CASES; without the file publication fails honestly at validation
 * instead of fabricating behavioral evidence.
 */

export interface TrustedSkillCase {
	branchId: string;
	phase: string;
	instructionIncludes: string[];
	calls?: { binding: ToolBinding; args: Record<string, unknown>; expected: unknown }[];
}

export function loadTrustedSkillCases(path: string | undefined): Record<string, TrustedSkillCase[]> {
	if (!path) return {};
	if (!isAbsolute(path)) throw new Error("Set PI861_SKILL_CASES to an absolute trusted JSON path");
	const source = record(JSON.parse(readFileSync(path, "utf8")));
	if (!source) throw new Error("Invalid trusted skill cases document");
	const result: Record<string, TrustedSkillCase[]> = {};
	for (const [group, rawCases] of Object.entries(source)) {
		if (!/^[\w./-]{1,160}$/.test(group) || !Array.isArray(rawCases) || rawCases.length === 0)
			throw new Error(`Invalid trusted cases for skill group ${group}`);
		result[group] = rawCases.map((raw): TrustedSkillCase => {
			const value = record(raw);
			const rawIncludes: unknown = value?.instructionIncludes;
			const includes = Array.isArray(rawIncludes)
				? rawIncludes.filter((part): part is string => typeof part === "string" && part.trim().length > 0)
				: [];
			if (
				!value ||
				typeof value.branchId !== "string" ||
				!value.branchId.trim() ||
				typeof value.phase !== "string" ||
				!value.phase.trim() ||
				!includes.length ||
				includes.length !== (Array.isArray(rawIncludes) ? rawIncludes.length : -1)
			)
				throw new Error(`Invalid trusted case in group ${group}`);
			const sample: TrustedSkillCase = {
				branchId: value.branchId,
				phase: value.phase,
				instructionIncludes: includes,
			};
			if (value.calls !== undefined) {
				if (!Array.isArray(value.calls)) throw new Error(`Invalid trusted case calls in group ${group}`);
				sample.calls = value.calls.map((rawCall) => {
					const call = record(rawCall);
					const binding = record(call?.binding);
					const args = record(call?.args);
					const fields: unknown[] = binding
						? [binding.toolId, binding.accountId, binding.resourceId, binding.schemaHash, binding.phase]
						: [];
					if (
						!call ||
						!binding ||
						!args ||
						fields.length !== 5 ||
						fields.some((field) => typeof field !== "string" || !field) ||
						!("expected" in call)
					)
						throw new Error(`Invalid trusted case call in group ${group}`);
					return {
						binding: {
							toolId: String(binding.toolId),
							accountId: String(binding.accountId),
							resourceId: String(binding.resourceId),
							schemaHash: String(binding.schemaHash),
							phase: String(binding.phase),
						},
						args,
						expected: call.expected,
					};
				});
			}
			return sample;
		});
	}
	return result;
}
