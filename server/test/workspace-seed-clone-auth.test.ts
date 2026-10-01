/**
 * The clone script's credential path, end to end: a local HTTP git server that demands Basic
 * auth, and the in-pod script authenticating through the env-only credential helper. This is
 * the one thing a `file://` clone cannot prove — that the helper git runs actually hands the
 * token over, and that neither argv, the resulting checkout, nor any output carries it.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { workspaceCloneSource } from "../src/server/pods/workspace-seed.js";

const USERNAME = "x-access-token";
const PASSWORD = "ghp_HTTPCLONESECRET0123456789abcdef";

/** Minimal Basic-auth front for `git http-backend`, speaking CGI over a pipe. */
const AUTH_GIT_SERVER = `import base64, os, subprocess, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

root, user, password, backend = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
expected = "Basic " + base64.b64encode((user + ":" + password).encode()).decode()

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *args):
        pass
    def _serve(self):
        if self.headers.get("Authorization") != expected:
            body = b"auth required"
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="git"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        path_info, _, query = self.path.partition("?")
        length = int(self.headers.get("Content-Length") or 0)
        payload = self.rfile.read(length) if length else b""
        env = dict(os.environ)
        env.update({
            "GIT_PROJECT_ROOT": root,
            "GIT_HTTP_EXPORT_ALL": "1",
            "PATH_INFO": path_info,
            "QUERY_STRING": query,
            "REQUEST_METHOD": self.command,
            "REMOTE_USER": user,
            "CONTENT_TYPE": self.headers.get("Content-Type") or "",
            "CONTENT_LENGTH": str(length),
        })
        proc = subprocess.run([backend], input=payload, capture_output=True, env=env)
        head, _, body = proc.stdout.partition(b"\\r\\n\\r\\n")
        status = 200
        headers = []
        for line in head.decode("latin-1").split("\\r\\n"):
            name, _, value = line.partition(":")
            if name.strip().lower() == "status":
                status = int(value.strip().split()[0])
            elif name:
                headers.append((name.strip(), value.strip()))
        self.send_response(status)
        for name, value in headers:
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        self._serve()
    def do_POST(self):
        self._serve()

server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(server.server_address[1], flush=True)
server.serve_forever()
`;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      "-c",
      "core.editor=true",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_EDITOR: "true",
        GIT_SEQUENCE_EDITOR: "true",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.test",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function findHttpBackend(): string | null {
  const execPath = spawnSync("git", ["--exec-path"], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: "true",
    },
  });
  if (execPath.status !== 0) return null;
  const candidate = path.join(execPath.stdout.trim(), "git-http-backend");
  return fs.existsSync(candidate) ? candidate : null;
}

const backend = findHttpBackend();

describe("workspace clone over authenticated HTTP", { skip: backend ? false : "git-http-backend is not installed" }, () => {
  let root: string;
  let server: ChildProcess;
  let url: string;
  let commit: string;
  /** A commit main never reached: requesting it forces the script's fetch-and-reset path. */
  let sideCommit: string;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pod-clone-auth-"));
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    git(work, "init", "-q", "-b", "main");
    git(work, "config", "user.email", "test@example.test");
    git(work, "config", "user.name", "test");
    fs.writeFileSync(path.join(work, "README.md"), "# seeded\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "seed");
    commit = git(work, "rev-parse", "HEAD");
    git(work, "checkout", "-q", "-b", "side");
    fs.writeFileSync(path.join(work, "side.md"), "# side\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "side");
    sideCommit = git(work, "rev-parse", "HEAD");
    git(work, "checkout", "-q", "main");
    git(root, "clone", "-q", "--bare", work, "repo.git");

    const serverScript = path.join(root, "server.py");
    fs.writeFileSync(serverScript, AUTH_GIT_SERVER);
    server = spawn("python3", [serverScript, root, USERNAME, PASSWORD, backend!], { stdio: ["ignore", "pipe", "pipe"] });
    const port = await new Promise<string>((resolve, reject) => {
      let buffered = "";
      server.stdout!.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
        const line = buffered.split("\n")[0];
        if (line && buffered.includes("\n")) resolve(line.trim());
      });
      server.on("exit", (code) => reject(new Error(`git server exited with ${code}`)));
    });
    url = `http://127.0.0.1:${port}/repo.git`;
  });

  after(() => {
    server?.kill();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function runClone(
    env: Record<string, string>,
    want = commit,
  ): { status: number | null; output: string; workdir: string; tmpdir: string } {
    const caseRoot = fs.mkdtempSync(path.join(root, "case-"));
    const workdir = path.join(caseRoot, "workspace");
    const tmpdir = path.join(caseRoot, "tmp");
    fs.mkdirSync(workdir);
    const result = spawnSync(
      "python3",
      ["-c", workspaceCloneSource(), workdir, tmpdir, url, "main", want],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_EDITOR: "true",
          GIT_SEQUENCE_EDITOR: "true",
          ...env,
        },
        timeout: 120_000,
      },
    );
    return { status: result.status, output: `${result.stdout}${result.stderr}`, workdir, tmpdir };
  }

  it("refuses anonymously and never prompts", () => {
    const run = runClone({});
    assert.notEqual(run.status, 0);
    assert.match(run.output, /git clone failed/);
    assert.equal(fs.readdirSync(run.workdir).length, 0, "a failed clone leaves the workdir empty");
    assert.equal(fs.existsSync(run.tmpdir), false, "the clone scratch directory is removed");
  });

  it("authenticates through the env-only helper and leaves no trace of the token", () => {
    const run = runClone({ PI_POD_GIT_USERNAME: USERNAME, PI_POD_GIT_PASSWORD: PASSWORD });
    assert.equal(run.status, 0, run.output);
    const trailer = JSON.parse(run.output.trim().split("\n").at(-1)!) as { ok: boolean; commit: string };
    assert.equal(trailer.ok, true);
    assert.equal(trailer.commit, commit);
    assert.equal(fs.readFileSync(path.join(run.workdir, "README.md"), "utf8"), "# seeded\n");
    assert.equal(git(run.workdir, "rev-parse", "HEAD"), commit);
    assert.equal(git(run.workdir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.equal(git(run.workdir, "remote", "get-url", "origin"), url, "the remote URL carries no userinfo");
    const gitDir = path.join(run.workdir, ".git");
    for (const file of ["config", "FETCH_HEAD", "logs/HEAD"]) {
      const target = path.join(gitDir, file);
      if (!fs.existsSync(target)) continue;
      const text = fs.readFileSync(target, "utf8");
      assert.equal(text.includes(PASSWORD), false, `${file} must not contain the token`);
      assert.equal(text.includes("credential"), false, `${file} must not persist a credential helper`);
    }
    assert.equal(run.output.includes(PASSWORD), false, "script output must not contain the token");
    assert.equal(fs.existsSync(run.tmpdir), false, "the clone scratch directory is removed");
  });

  it("fetches a commit the branch tip moved past with the same env-only credential", () => {
    const run = runClone({ PI_POD_GIT_USERNAME: USERNAME, PI_POD_GIT_PASSWORD: PASSWORD }, sideCommit);
    assert.equal(run.status, 0, run.output);
    const trailer = JSON.parse(run.output.trim().split("\n").at(-1)!) as { ok: boolean; commit: string };
    assert.equal(trailer.commit, sideCommit);
    assert.equal(git(run.workdir, "rev-parse", "HEAD"), sideCommit);
    assert.equal(git(run.workdir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.equal(fs.readFileSync(path.join(run.workdir, "side.md"), "utf8"), "# side\n");
    assert.equal(run.output.includes(PASSWORD), false, "script output must not contain the token");
    const config = fs.readFileSync(path.join(run.workdir, ".git", "config"), "utf8");
    assert.equal(config.includes("credential"), false, "the fetch must not persist a credential helper");
  });

  it("scrubs a rejected token from its own error output", () => {
    const run = runClone({ PI_POD_GIT_USERNAME: USERNAME, PI_POD_GIT_PASSWORD: `${PASSWORD}-wrong` });
    assert.notEqual(run.status, 0);
    assert.match(run.output, /git clone failed/);
    assert.equal(run.output.includes(PASSWORD), false, "script output must not contain the token");
    assert.equal(fs.readdirSync(run.workdir).length, 0);
  });
});
