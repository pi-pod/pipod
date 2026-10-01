#!/usr/bin/env node
/**
 * scripts/ensure-user-config.mjs — package.json `postinstall`.
 *
 * Writes `~/.pi-pod/config.json` from the packaged template, so pi pod's settings for this
 * machine exist from the moment it is installed rather than the first time someone goes
 * looking for a file that is not there.
 *
 * Deliberately standalone, and deliberately dumb. It cannot import the launcher: `npm install`
 * in a source checkout runs this before `npm run build`, so `dist/` may not exist yet. The
 * part worth sharing is the file's *contents*, and that is shared — both this script and
 * `src/userconfig.ts` write the same `templates/user-config.jsonc`, and a unit test checks
 * that template against pi pod's built-in defaults.
 *
 * `src/userconfig.ts` does the same thing at the top of every command, which is what covers an
 * install that never ran this (`--ignore-scripts`, or a build that landed after the install).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

try {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (home) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const dir = path.join(home, ".pi-pod");

    const source = path.join(root, "templates", "user-config.jsonc");
    const target = path.join(dir, "config.json");
    if (!fs.existsSync(target) && fs.existsSync(source)) {
      fs.mkdirSync(dir, { recursive: true });
      // wx rather than a plain write: an existsSync check is not a lock, and clobbering
      // someone's edited settings is the one outcome this must never have.
      fs.writeFileSync(target, fs.readFileSync(source, "utf8"), { flag: "wx", mode: 0o644 });
      fs.chmodSync(target, 0o644);
      process.stdout.write(`pi pod: created ${target}\n`);
    }
    fs.mkdirSync(path.join(dir, "secrets"), { recursive: true, mode: 0o700 });
  }
} catch {
  // Never fail an install over this. The launcher writes these itself on first run.
}
