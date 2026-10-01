#!/usr/bin/env node
// Restore the version-bound test catalog, not the current public provider catalog.
// Updating the release pin is a reviewed change; normal model generation is unchanged.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_DATA_MANIFEST_FILE, readModelDataProviderIds, validateGeneratedModelData } from "../packages/ai/scripts/model-data.ts";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");
const defaultPin = JSON.parse(readFileSync(join(root, "scripts/pi861-test-catalog.json"), "utf8"));

/** All arguments are trusted local package paths/configuration, never network URLs. */
export function hydrateTestCatalog(sourcePackageRoot, packageRoot, pin = defaultPin) {
	const source = JSON.parse(readFileSync(join(sourcePackageRoot, "package.json"), "utf8"));
	const target = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	if (source.name !== pin.packageName || target.name !== pin.packageName || source.version !== pin.version || target.version !== pin.version) {
		throw new Error(`Test catalog requires ${pin.packageName}@${pin.version} in both source and target`);
	}
	const sourceData = join(sourcePackageRoot, "dist/providers/data");
	const providerIds = readModelDataProviderIds(packageRoot);
	const expectedFiles = [...providerIds.map((id) => `${id}.json`), MODEL_DATA_MANIFEST_FILE].sort();
	const actualFiles = readdirSync(sourceData).sort();
	if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
		throw new Error("Published test catalog provider files do not match the source catalog");
	}
	for (const name of expectedFiles) {
		if (!lstatSync(join(sourceData, name)).isFile()) throw new Error(`Catalog entry must be a regular file: ${name}`);
	}
	const manifest = readFileSync(join(sourceData, MODEL_DATA_MANIFEST_FILE));
	if (createHash("sha256").update(manifest).digest("hex") !== pin.manifestSha256) {
		throw new Error("Published test catalog manifest does not match the pinned SHA256");
	}
	const providers = join(packageRoot, "src/providers");
	const destination = join(providers, "data");
	if (existsSync(destination) && !lstatSync(destination).isDirectory()) {
		throw new Error("Target model data must be a real directory");
	}
	const staging = mkdtempSync(join(providers, ".pi861-catalog-"));
	const stagedProviders = join(staging, "src/providers");
	const stagedData = join(stagedProviders, "data");
	const backup = join(staging, "previous-data");
	let preserveBackup = false;
	try {
		mkdirSync(stagedData, { recursive: true });
		copyFileSync(join(packageRoot, "src/models.generated.ts"), join(staging, "src/models.generated.ts"));
		for (const name of readdirSync(providers).filter((entry) => entry.endsWith(".models.ts"))) {
			copyFileSync(join(providers, name), join(stagedProviders, name));
		}
		for (const name of expectedFiles) copyFileSync(join(sourceData, name), join(stagedData, name));
		// Check every model value, schema version, provider set and file hash before replacing anything.
		validateGeneratedModelData(staging);
		const hadData = existsSync(destination);
		if (hadData) renameSync(destination, backup);
		try {
			renameSync(stagedData, destination);
		} catch (error) {
			if (hadData) {
				try { renameSync(backup, destination); }
				catch (rollbackError) {
					preserveBackup = true;
					throw new AggregateError([error, rollbackError], `Catalog replacement failed; original data preserved at ${backup}`);
				}
			}
			throw error;
		}
	} finally {
		if (!preserveBackup) rmSync(staging, { recursive: true, force: true });
	}
	return { version: pin.version, providers: providerIds.length, manifestSha256: pin.manifestSha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
	try {
		if (process.argv.length !== 3) throw new Error("Usage: node scripts/hydrate-pi861-test-catalog.mjs <extracted-pi-ai-package>");
		const result = hydrateTestCatalog(resolve(process.argv[2]), join(root, "packages/ai"));
		console.log(`Verified test catalog ${result.version}: ${result.providers} providers; manifest ${result.manifestSha256}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
