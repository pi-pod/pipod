import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Optional argument: the dist directory to check (default: this package's own).
const dist = process.argv[2] ? pathToFileURL(`${resolve(process.argv[2])}/`) : new URL("../dist/", import.meta.url);
const chunks = (await readdir(dist))
  .filter((name) => /^sandbox-[A-Z0-9]+\.js$/.test(name));
if (chunks.length !== 1) {
  throw new Error(`expected one sandbox provider chunk, found ${chunks.length}: ${chunks.join(", ")}`);
}

// Source-level tests load ws through tsx. Import the emitted ESM chunk too: bundling ws used
// to leave a hidden require("events") that failed only after production selected this provider.
const built = await import(new URL(chunks[0], dist));
const provider = built.createSandboxProvider({ url: "http://sandbox.invalid" });
if (provider.name !== "sandbox") {
  throw new Error(`built sandbox provider reported unexpected name ${String(provider.name)}`);
}
