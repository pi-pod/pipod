import * as fs from "node:fs";
import * as path from "node:path";

export function envFilePlausiblyIgnored(projectRoot: string, relPath: string): boolean {
  const posixRel = relPath.split(path.sep).join("/");
  const base = path.posix.basename(posixRel);
  const dir = path.posix.dirname(posixRel);
  const candidates = [
    path.join(projectRoot, ".gitignore"),
    ...(dir !== "." ? [path.join(projectRoot, dir, ".gitignore")] : []),
  ];
  const covers = (rawLine: string, target: string): boolean => {
    let line = rawLine.trim();
    if (line === "" || line.startsWith("#")) return false;
    if (line.startsWith("/")) line = line.slice(1);
    if (line.endsWith("/")) line = line.slice(0, -1);
    if (line === "*" || line === target || line === base) return true;
    if (target.startsWith(`${line}/`)) return true;
    return line.endsWith("*") && target.startsWith(line.slice(0, -1));
  };
  for (const file of candidates) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const target = file === candidates[0] ? posixRel : base;
    if (text.split(/\r?\n/).some((line) => covers(line, target))) return true;
  }
  return false;
}
