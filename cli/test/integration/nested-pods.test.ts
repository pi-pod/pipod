/**
 * Nested pods through the real `main()`: inside a pod, the scoped token the server injected
 * is the account session. The CLI launches children, sees only its own subtree, drives a
 * child headlessly, and refuses to orphan live work.
 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { main } from "../../src/cli.js";
import { setColor } from "../../src/log.js";
import { FakeAccountServer, fakePod } from "../support/fake-account-server.js";
import { isolateHome } from "../support/repo-fixture.js";

setColor(false);

const HOME = isolateHome();
const savedCwd = process.cwd();
const SUPERVISOR = "0198f5a0-0000-7000-8000-00000000000a";
const STRANGER = "0198f5a0-0000-7000-8000-0000000000ff";
let server: FakeAccountServer;

before(async () => {
  server = new FakeAccountServer({
    answerPrompts: true,
    pods: [
      fakePod({ id: SUPERVISOR, name: "supervisor", project: null }),
      fakePod({ id: STRANGER, name: "someone-else", project: null }),
    ],
  });
  await server.start();
  process.chdir(HOME.home);
  process.env["PI_POD_SERVER_URL"] = server.url;
  process.env["PI_POD_SERVER_TOKEN"] = `ppt_${SUPERVISOR}`;
  process.env["PI_POD_SERVER_POD_ID"] = SUPERVISOR;
});

after(async () => {
  process.chdir(savedCwd);
  delete process.env["PI_POD_SERVER_URL"];
  delete process.env["PI_POD_SERVER_TOKEN"];
  delete process.env["PI_POD_SERVER_POD_ID"];
  await server.stop();
  HOME.restore();
});

async function capture(argv: string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const sink = ((chunk: string | Uint8Array) => {
    if (typeof chunk !== "string") return origOut(chunk);
    chunks.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink;
  try {
    return { code: await main(argv), out: chunks.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe("pi pod inside a pod (nested pods)", () => {
  it("uses the injected pod token as its session, with no login on disk", async () => {
    assert.ok(!fs.existsSync(path.join(HOME.home, ".pi-pod", "auth.json")));
    const listed = await capture(["list", "--all"]);
    assert.equal(listed.code, 0);
    assert.match(listed.out, /supervisor/);
    // The other pod in the organization is not this pod's business.
    assert.doesNotMatch(listed.out, /someone-else/);
  });

  it("launches a child that records this pod as its parent, and never syncs pi auth", async () => {
    const before = server.calls.length;
    const launched = await capture(["--yes"]);
    assert.equal(launched.code, 0);

    const calls = server.calls.slice(before);
    assert.equal(calls.some((call) => call.path.startsWith("/v1/pi-auth")), false);
    assert.equal(calls.some((call) => call.path.startsWith("/v1/model-credentials")), false);
    assert.ok(calls.some((call) => call.method === "POST" && call.path === "/v1/pods"));
    const child = server.pods.find((pod) => pod.parentPodId === SUPERVISOR);
    assert.ok(child, "the launch must be recorded as a child of the calling pod");
    assert.equal(child.lineageDepth, 1);
  });

  it("renders the subtree with children indented under their parent", async () => {
    const listed = await capture(["list", "--all"]);
    const child = server.pods.find((pod) => pod.parentPodId === SUPERVISOR)!;
    const lines = listed.out.split("\n");
    const parentLine = lines.findIndex((line) => line.includes("supervisor"));
    const childLine = lines.findIndex((line) => line.includes(child.name));
    assert.ok(parentLine >= 0 && childLine > parentLine, "a child is listed beneath its parent");
    assert.match(lines[childLine]!, /└ /);
  });

  it("drives a child's session headlessly through the gateway", async () => {
    const child = server.pods.find((pod) => pod.parentPodId === SUPERVISOR)!;
    const before = server.calls.length;
    const driven = await capture(["attach", child.id, "--", "summarize the repo"]);
    assert.equal(driven.code, 0);
    assert.ok(
      server.calls
        .slice(before)
        .some((call) => call.method === "POST" && call.path === `/v1/pods/${child.id}/ws-ticket`),
    );
  });

  it("refuses to reach a pod it did not launch", async () => {
    const denied = await capture(["archive", STRANGER]).catch((e: Error) => ({ code: 1, out: e.message }));
    assert.equal(denied.code, 1);
  });

  it("co-locates a child with --on self and never seeds the shared host workdir", async () => {
    // A project with no init script would normally seed its tree into the pod's workdir.
    // A co-located child's workdir is the host's own — seeding would overwrite host files,
    // so the launch must skip the seed with a loud warning instead.
    const cwd = path.join(HOME.home, "seed-project");
    fs.mkdirSync(path.join(cwd, ".pi-pod"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi-pod", "config.json"), "{}\n");
    fs.writeFileSync(path.join(cwd, "README.md"), "seed-me\n");
    process.chdir(cwd);
    const before = server.calls.length;
    try {
      const launched = await capture(["--on", "self", "--yes", "--", "say hi"]);
      assert.equal(launched.code, 0);
      assert.match(launched.out, /workspace seed skipped — a co-located pod shares its host's workdir/);
      const calls = server.calls.slice(before);
      assert.equal(
        calls.some((call) => call.method === "POST" && /^\/v1\/pods\/[^/]+\/files$/.test(call.path)),
        false,
        "a co-located launch must never seed files into the shared host workdir",
      );
      const launchCall = calls.find((call) => call.method === "POST" && call.path === "/v1/pods");
      assert.deepEqual((launchCall?.body as { placement?: unknown }).placement, { host: "self" });
      assert.ok(
        server.pods.some((pod) => pod.parentPodId === SUPERVISOR),
        "the co-located child is recorded under this pod",
      );
    } finally {
      process.chdir(HOME.home);
    }
  });

  it("keeps a pod whose live children are not part of the cleanup", async () => {
    const child = server.pods.find((pod) => pod.parentPodId === SUPERVISOR)!;
    const grandchild = fakePod({
      id: "0198f5a0-0000-7000-8000-0000000000c1",
      name: "worker",
      project: null,
      parentPodId: child.id,
      lineageDepth: 2,
    });
    server.pods.push(grandchild);
    child.state = "archived";

    const collected = await capture(["gc", "--delete", "--yes"]);
    assert.equal(collected.code, 0);
    assert.match(collected.out, /kept pod .*pods it launched are still running/);
    assert.ok(server.pods.some((pod) => pod.id === child.id), "a parent of live work survives gc");
  });
});
