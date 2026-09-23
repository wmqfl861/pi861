#!/usr/bin/env node
/**
 * Production entries are a coverage contract, not a convention.
 *
 * extensions/pi861 ships entry points a host or operator actually starts (Pi extension entry,
 * programmatic install entry, operator CLIs, composition examples). If one of them silently falls
 * out of biome, a tsconfig, or the package entry declaration, nothing else in `npm run check`
 * notices: the file just stops being verified while still shipping. This script pins the registry
 * (scripts/pi861-production-entries.json) against the real configs and the real files, so:
 *
 *   - removing an entry's glob from biome.json / tsconfig.json / tsconfig.entries.json fails;
 *   - deleting a registered entry file, or its package.json declaration, fails;
 *   - adding a new production script/example without registering it fails;
 *   - dropping checkJs/allowJs from the entries tsconfig fails.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function fail(message) {
	failures.push(message);
}

function readJson(path) {
	if (!existsSync(path)) {
		fail(`${relative(ROOT, path)} is missing`);
		return undefined;
	}
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		fail(`${relative(ROOT, path)} is not valid JSON: ${error.message}`);
		return undefined;
	}
}

/** Minimal glob matcher for the pattern vocabulary used by these configs: **, *, ? and literals. */
function globToRegExp(pattern) {
	let source = "";
	let i = 0;
	while (i < pattern.length) {
		const char = pattern[i];
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				if (pattern[i + 2] === "/") {
					// "**/" matches zero or more whole directories: a/**/*.ts covers a/b.ts too.
					source += "(?:.*/)?";
					i += 3;
					continue;
				}
				source += ".*";
				i += 2;
				continue;
			}
			source += "[^/]*";
			i += 1;
			continue;
		}
		if (char === "?") {
			source += "[^/]";
			i += 1;
			continue;
		}
		source += char.replace(/[\\^$.+()[\]{}|]/g, "\\$&");
		i += 1;
	}
	return new RegExp(`^${source}$`);
}

function normalize(path) {
	return path.split("\\").join("/");
}

function matchesAny(path, patterns) {
	return patterns.some((pattern) => globToRegExp(pattern).test(normalize(path)));
}

/** biome `files.includes`: later entries win; `!` negates. Mirrors the semantics we rely on. */
function biomeCovers(path, includes) {
	let covered = false;
	for (const entry of includes) {
		const negative = entry.startsWith("!");
		const pattern = negative ? entry.slice(1) : entry;
		if (globToRegExp(pattern).test(normalize(path))) covered = !negative;
	}
	return covered;
}

const registry = readJson(join(ROOT, "scripts", "pi861-production-entries.json"));
const biome = readJson(join(ROOT, "biome.json"));
const rootTsconfig = readJson(join(ROOT, "tsconfig.json"));
const entriesTsconfig = readJson(join(ROOT, "extensions", "pi861", "tsconfig.entries.json"));
const extensionPackage = readJson(join(ROOT, "extensions", "pi861", "package.json"));

if (registry && biome && rootTsconfig && entriesTsconfig && extensionPackage) {
	const assertions = registry.configAssertions;
	const entries = registry.entries;
	const reserved = registry.reserved ?? [];
	const tsEntries = entries.filter((entry) => entry.language === "ts");
	const mjsEntries = entries.filter((entry) => entry.language === "mjs");

	// 1. Required coverage patterns must exist verbatim, so a narrowed glob cannot silently pass.
	for (const pattern of assertions.biomeFilesIncludesMustContain) {
		if (!biome.files?.includes?.includes(pattern)) {
			fail(`biome.json files.includes lost the production pattern "${pattern}"`);
		}
	}
	for (const pattern of assertions.rootTsconfigIncludeMustContain) {
		if (!rootTsconfig.include?.includes(pattern)) {
			fail(`root tsconfig.json include lost the production pattern "${pattern}"`);
		}
	}
	for (const pattern of assertions.entriesTsconfigIncludeMustContain) {
		if (!entriesTsconfig.include?.includes(pattern)) {
			fail(`extensions/pi861/tsconfig.entries.json include lost the production pattern "${pattern}"`);
		}
	}

	// 2. Every registered entry must actually be matched by the configs (not just by the verbatim
	//    patterns above: this catches a future include-list reorganization that drops a file).
	const biomeIncludes = biome.files?.includes ?? [];
	for (const entry of entries) {
		if (!biomeCovers(entry.path, biomeIncludes)) {
			fail(`${entry.path} is not covered by biome.json files.includes`);
		}
	}
	const rootInclude = rootTsconfig.include ?? [];
	const rootExclude = rootTsconfig.exclude ?? [];
	for (const entry of tsEntries) {
		if (!matchesAny(entry.path, rootInclude)) {
			fail(`${entry.path} is not covered by root tsconfig.json include`);
		}
		if (matchesAny(entry.path, rootExclude)) {
			fail(`${entry.path} is excluded by root tsconfig.json exclude`);
		}
	}
	// tsconfig.entries.json patterns are relative to extensions/pi861.
	const entriesInclude = entriesTsconfig.include ?? [];
	for (const entry of entries) {
		const relativePath = normalize(relative(join(ROOT, "extensions", "pi861"), join(ROOT, entry.path)));
		if (!matchesAny(relativePath, entriesInclude)) {
			fail(`${entry.path} is not covered by extensions/pi861/tsconfig.entries.json include`);
		}
	}

	// 3. The entries tsconfig must keep checking JavaScript, not just parse it.
	for (const [option, expected] of Object.entries(assertions.entriesTsconfigRequires)) {
		if (entriesTsconfig.compilerOptions?.[option] !== expected) {
			fail(`extensions/pi861/tsconfig.entries.json must set compilerOptions.${option}=${expected}`);
		}
	}

	// 4. The Pi extension entry declaration must stay exact and the file must exist.
	const declared = extensionPackage.pi?.extensions;
	const expectedDeclaration = assertions.extensionPackagePiExtensionsMustBe;
	if (JSON.stringify(declared) !== JSON.stringify(expectedDeclaration)) {
		fail(
			`extensions/pi861/package.json pi.extensions must be ${JSON.stringify(expectedDeclaration)} but is ${JSON.stringify(declared)}`,
		);
	}
	for (const declaration of expectedDeclaration) {
		const declaredPath = join(ROOT, "extensions", "pi861", declaration);
		if (!existsSync(declaredPath)) fail(`extensions/pi861/package.json declares missing entry "${declaration}"`);
	}

	// 5. Registered entries must exist on disk.
	for (const entry of entries) {
		if (!existsSync(join(ROOT, entry.path))) fail(`registered production entry ${entry.path} does not exist`);
	}

	// 6. Reserved future entries must already be covered by today's globs, so landing them cannot
	//    slip past the chain.
	for (const reservedEntry of reserved) {
		if (!biomeCovers(reservedEntry.path, biomeIncludes)) {
			fail(`reserved entry ${reservedEntry.path} would not be covered by biome.json`);
		}
		const relativePath = normalize(relative(join(ROOT, "extensions", "pi861"), join(ROOT, reservedEntry.path)));
		if (!matchesAny(relativePath, entriesInclude)) {
			fail(`reserved entry ${reservedEntry.path} would not be covered by tsconfig.entries.json`);
		}
	}

	// 7. Discovery: every production-shaped file under scripts/ and examples/ plus the two TS
	//    entries must be registered, and vice versa. New entries cannot ship unregistered.
	const discovered = new Set(["extensions/pi861/runtime.ts", "extensions/pi861/index.ts"]);
	const extensionRoot = join(ROOT, "extensions", "pi861");
	function walk(dir) {
		for (const item of readdirSync(dir, { withFileTypes: true })) {
			if (item.isDirectory()) {
				walk(join(dir, item.name));
				continue;
			}
			if (item.name.endsWith(".mjs")) {
				discovered.add(normalize(relative(ROOT, join(dir, item.name))));
			}
		}
	}
	walk(join(extensionRoot, "scripts"));
	walk(join(extensionRoot, "examples"));
	const registered = new Set(entries.map((entry) => normalize(entry.path)));
	for (const path of discovered) {
		if (!registered.has(path)) fail(`production-shaped file ${path} is not registered in pi861-production-entries.json`);
	}
	for (const path of registered) {
		if (!discovered.has(path)) fail(`registered entry ${path} is not discoverable under scripts/, examples/ or the declared TS entries`);
	}
}

if (failures.length > 0) {
	console.error(`check-pi861-entries: ${failures.length} production entry coverage failure(s):`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exitCode = 1;
} else {
	console.log("check-pi861-entries: all production entries are registered, linted, typed and declared");
}
