import { execFile } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  piAuthPrintBearerCommand,
  piAuthProbeModel,
  readPiAuthOAuthProviders,
} from "./hostconfig.js";
import { debug } from "./log.js";

export async function refreshHostOAuthGrants(
  home: string,
  opts: {
    hostModel: { provider: string; model: string } | null;
    providers?: string[];
    probe?: (command: string, home: string) => Promise<boolean>;
  },
): Promise<string[]> {
  const probe = opts.probe ?? probeCredentialPrint;
  const providers = opts.providers ?? readPiAuthOAuthProviders(home);
  const failures: string[] = [];
  await Promise.all(
    providers.map(async (provider) => {
      const model = piAuthProbeModel(provider, opts.hostModel);
      if (model === null) return;
      const ok = await probe(piAuthPrintBearerCommand(provider, model), home).catch(() => false);
      if (!ok) failures.push(provider);
    }),
  );
  return failures.sort();
}

export async function probeCredentialPrint(command: string, home: string): Promise<boolean> {
  const argv = command.split(" ").slice(1);
  try {
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const cli = path.join(path.dirname(entry), "..", "dist", "cli.js");
    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [cli, ...argv],
        {
          timeout: 30_000,
          maxBuffer: 64 * 1024,
          env: { ...process.env, ...(home ? { HOME: home } : {}) },
        },
        (error, _stdout, stderr) => {
          if (error) {
            debug(`credential probe failed: ${(stderr || error.message).trim().split("\n")[0]}`);
            reject(error);
          } else {
            resolve();
          }
        },
      );
    });
    return true;
  } catch {
    return false;
  }
}
