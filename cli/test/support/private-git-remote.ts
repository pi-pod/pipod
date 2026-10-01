/**
 * test/support/private-git-remote.ts — a bare repository served over dumb HTTP behind Basic auth.
 *
 * The credentialed clone path is defined by what git does against a remote that answers 401
 * anonymously and 200 with the right token, so the test remote has to be exactly that: the
 * same static file server `serveBareRepo` uses, with one `Authorization` check in front. It
 * lives in its own process for the same reason — the code under test runs git synchronously.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const AUTH_SERVER = `
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const [dir, expected] = [process.argv[1], process.argv[2]];
const MOUNT = "/repo.git";
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== "Basic " + expected) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="private"' }).end();
    return;
  }
  const requested = decodeURIComponent((req.url || "/").split("?")[0]);
  const file = path.join(dir, path.normalize(requested.slice(MOUNT.length)));
  if (!requested.startsWith(MOUNT) || !file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
server.listen(0, "127.0.0.1", () => process.stdout.write("port=" + server.address().port + "\\n"));
`;

export interface PrivateGitRemote {
  /** The anonymous URL a checkout names as `origin`. */
  url: string;
  host: string;
  username: string;
  password: string;
  /** Re-run `update-server-info` after pushing so the dumb protocol sees the new refs. */
  refresh(): void;
  close(): Promise<void>;
}

export async function servePrivateBareRepo(
  dir: string,
  credential: { username: string; password: string },
): Promise<PrivateGitRemote> {
  const refresh = (): void => {
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.editor=true", "update-server-info"],
      {
        cwd: dir,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_EDITOR: "true",
          GIT_SEQUENCE_EDITOR: "true",
        },
      },
    );
  };
  refresh();
  const expected = Buffer.from(`${credential.username}:${credential.password}`).toString("base64");
  const child = spawn(process.execPath, ["-e", AUTH_SERVER, dir, expected], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<string>((resolve, reject) => {
    let seen = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      seen += chunk;
      const match = /port=(\d+)/.exec(seen);
      if (match) resolve(match[1]!);
    });
    child.once("exit", () => reject(new Error(`private git server exited early: ${seen}`)));
  });
  return {
    url: `http://127.0.0.1:${port}/repo.git`,
    host: `127.0.0.1:${port}`,
    username: credential.username,
    password: credential.password,
    refresh,
    close: async () => {
      child.kill();
    },
  };
}

/**
 * Point git's global config at a `store` credential helper holding one remote's token, the way
 * a developer machine holds a GitHub token. Returns a restore function for the env var.
 */
export function installStoredGitCredential(
  dir: string,
  remote: { url: string; username: string; password: string },
): () => void {
  const parsed = new URL(remote.url);
  const store = path.join(dir, "git-credentials");
  fs.writeFileSync(store, `${parsed.protocol}//${remote.username}:${remote.password}@${parsed.host}\n`, { mode: 0o600 });
  const config = path.join(dir, "gitconfig");
  fs.writeFileSync(config, `[credential]\n\thelper = store --file=${store}\n`);
  const saved = process.env["GIT_CONFIG_GLOBAL"];
  process.env["GIT_CONFIG_GLOBAL"] = config;
  return () => {
    if (saved === undefined) delete process.env["GIT_CONFIG_GLOBAL"];
    else process.env["GIT_CONFIG_GLOBAL"] = saved;
  };
}
