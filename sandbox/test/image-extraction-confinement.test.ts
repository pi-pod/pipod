import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { extractLayerBlob } from "../src/images/store.js";

function tar(entries: Array<{ name: string; type?: string; link?: string; text?: string }>): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.text ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    for (const [offset, size, value] of [[100, 8, 0o644], [108, 8, 0], [116, 8, 0], [124, 12, body.length], [136, 12, 0]]) {
      header.write(value!.toString(8).padStart(size! - 1, "0") + "\0", offset!, size!);
    }
    header.fill(32, 148, 156);
    header.write(entry.type ?? "0", 156);
    header.write(entry.link ?? "", 157, 100);
    header.write("ustar\0", 257); header.write("00", 263);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

test("GNU tar extraction confines traversal, absolute names and symlink/hardlink targets", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "pps-tar-confinement-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outside = path.join(dir, "outside");
  await writeFile(outside, "untouched");
  const cases = [
    [{ name: "../outside", text: "overwritten" }],
    [{ name: outside, text: "overwritten" }],
    [{ name: "escape", type: "2", link: ".." }, { name: "escape/outside", text: "overwritten" }],
    [{ name: "escape", type: "1", link: "../outside" }, { name: "escape", text: "overwritten" }],
  ];
  for (let i = 0; i < cases.length; i++) {
    const blob = path.join(dir, `layer-${i}.tar`);
    await writeFile(blob, tar(cases[i]!));
    // GNU tar may reject an unsafe entry or strip the absolute prefix; either is safe.
    try { await extractLayerBlob(blob, "application/vnd.oci.image.layer.v1.tar", path.join(dir, `lower-${i}`)); }
    catch (error) { assert.match(String(error), /tar|Command failed/); }
    assert.equal(await readFile(outside, "utf8"), "untouched");
  }
});
