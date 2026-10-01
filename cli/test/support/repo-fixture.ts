/**
 * test/support/repo-fixture.ts — throwaway git repositories on disk.
 *
 * The push-state preflight, dirty-patch generation and gitignore hard-stop are all defined
 * in terms of real git behavior, so the tests use real git rather than a mock: a stub would
 * only prove that the stub matches the implementation's assumptions.
 */
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Fixture {
  dir: string;
  cleanup(): void;
  git(...args: string[]): string;
  write(relPath: string, contents: string): void;
  commit(message: string): void;
}

export function makeTempDir(prefix = "pi-pod-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Point `$HOME` at an empty directory for the duration of a test file.
 *
 * Needed by anything that goes through `main()`: it reads/creates machine client state under
 * `~/.pi-pod/`. Against a real home that would make the suite depend on developer preferences
 * and write to the developer's home directory — two things a test must never do.
 */
export function isolateHome(prefix = "pi-pod-home-"): { home: string; restore(): void } {
  const home = makeTempDir(prefix);
  // The pod-token environment is an identity too (nested pods): a suite running inside a pod
  // would otherwise inherit that pod's account session along with the ambient home.
  const saved = {
    HOME: process.env["HOME"],
    USERPROFILE: process.env["USERPROFILE"],
    PI_POD_SERVER_URL: process.env["PI_POD_SERVER_URL"],
    PI_POD_SERVER_TOKEN: process.env["PI_POD_SERVER_TOKEN"],
    PI_POD_SERVER_POD_ID: process.env["PI_POD_SERVER_POD_ID"],
  };
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
  delete process.env["PI_POD_SERVER_URL"];
  delete process.env["PI_POD_SERVER_TOKEN"];
  delete process.env["PI_POD_SERVER_POD_ID"];

  return {
    home,
    restore: () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.editor=true", ...args],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "pi-pod test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "pi-pod test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_EDITOR: "true",
        GIT_SEQUENCE_EDITOR: "true",
      },
    },
  ).trim();
}

/**
 * A throwaway repo, by default in its own temp directory.
 *
 * `dir` places it somewhere chosen instead — needed by anything about where a repo sits relative
 * to `$HOME`, since the config walk treats an ancestor differently from an unrelated directory.
 */
export function initRepo(opts: { bare?: boolean; dir?: string } = {}): Fixture {
  const dir = opts.dir ?? makeTempDir();
  fs.mkdirSync(dir, { recursive: true });
  const g = (...args: string[]) => runGit(dir, args);

  if (opts.bare) {
    g("init", "--bare", "--initial-branch=main", ".");
  } else {
    g("init", "--initial-branch=main", ".");
    g("config", "user.name", "pi-pod test");
    g("config", "user.email", "test@example.invalid");
    g("config", "commit.gpgsign", "false");
    g("config", "tag.gpgsign", "false");
    g("config", "core.editor", "true");
  }

  const fixture: Fixture = {
    dir,
    git: g,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    write: (relPath: string, contents: string) => {
      const target = path.join(dir, relPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    },
    commit: (message: string) => {
      g("add", "-A");
      g("commit", "-m", message);
    },
  };

  return fixture;
}

/** A working repo with an initial commit and a bare "remote" it is in sync with. */
export function initRepoWithRemote(): { repo: Fixture; remote: Fixture } {
  const remote = initRepo({ bare: true });
  const repo = initRepo();

  repo.write("README.md", "# fixture\n");
  repo.commit("initial");
  repo.git("remote", "add", "origin", remote.dir);
  repo.git("push", "-u", "origin", "main");

  return { repo, remote };
}

export function writeConfig(repoDir: string, config: Record<string, unknown> | string): string {
  const dir = path.join(repoDir, ".pi-pod");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "config.json");
  fs.writeFileSync(target, typeof config === "string" ? config : JSON.stringify(config, null, 2));
  return target;
}

export function writeEnv(repoDir: string, contents: string): string {
  const dir = path.join(repoDir, ".pi-pod");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "env");
  fs.writeFileSync(target, contents, { mode: 0o600 });
  return target;
}

export function gitignore(repoDir: string, lines: string[]): void {
  fs.writeFileSync(path.join(repoDir, ".gitignore"), lines.join("\n") + "\n");
}

/**
 * Serve a bare repository over git's dumb HTTP protocol, from a process of its own.
 *
 * The clone path only considers remotes a pod could actually fetch, which rules out the local
 * paths the other fixtures use. A static file server over `update-server-info` output is a real
 * remote by git's reckoning and needs no network — but it has to live outside this process,
 * because the code under test runs git synchronously and would block its own server's replies.
 */
const STATIC_SERVER = `
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const dir = process.argv[1];
const MOUNT = "/repo.git";
const server = http.createServer((req, res) => {
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

export async function serveBareRepo(
  dir: string,
): Promise<{ url: string; refresh(): void; close(): Promise<void> }> {
  const refresh = (): void => void runGit(dir, ["update-server-info"]);
  refresh();

  const child = spawn(process.execPath, ["-e", STATIC_SERVER, dir], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<string>((resolve, reject) => {
    let seen = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      seen += chunk;
      const match = /port=(\d+)/.exec(seen);
      if (match) resolve(match[1]!);
    });
    child.once("exit", () => reject(new Error(`static git server exited early: ${seen}`)));
  });

  return {
    url: `http://127.0.0.1:${port}/repo.git`,
    refresh,
    close: async () => {
      child.kill();
    },
  };
}
