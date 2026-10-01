/**
 * Source for the user-facing commands shared by every generated pi-pod extension.
 *
 * Kept as generated source because the uploaded extension must be standalone: it cannot import
 * launcher files that exist only on the host. Function names are prefixed so composing it with
 * the RPC and TUI modules cannot create accidental bindings.
 */
export function buildPodCompanionSource(): string {
  return `import { execFileSync as piPodExecFileSync } from "node:child_process";

function piPodInPod() {
  return process.env.PI_POD === "1" || process.env.PI_POD_SANDBOX === "1";
}

function piPodId() {
  return process.env.PI_POD_ID || process.env.PI_POD_SANDBOX_ID || "unknown";
}

function piPodGit(args, opts = {}) {
  try {
    return piPodExecFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    }).trim();
  } catch (error) {
    if (opts.allowFailure) return null;
    throw error;
  }
}

function piPodHas(bin) {
  try {
    piPodExecFileSync("sh", ["-c", "command -v " + bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function piPodFormatUptime(createdEpochSeconds) {
  const created = Number(createdEpochSeconds);
  if (!Number.isFinite(created) || created <= 0) return "unknown";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - created);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return hours + "h " + minutes + "m";
  if (minutes > 0) return minutes + "m " + remainder + "s";
  return remainder + "s";
}

function piPodFormatEgress(raw) {
  if (!raw) return "unknown";
  if (raw === "open") return "open (unrestricted)";
  if (raw.startsWith("allowlist:")) {
    const hosts = raw.slice("allowlist:".length).split(",").filter(Boolean);
    return "allowlist (" + hosts.length + " entr" + (hosts.length === 1 ? "y" : "ies") + ")\\n    " + hosts.join("\\n    ");
  }
  return raw;
}

function piPodStatus() {
  const branch = piPodGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true });
  const dirty = piPodGit(["status", "--porcelain"], { allowFailure: true }) || "";
  const dirtyCount = dirty.split("\\n").filter((line) => line.trim() !== "").length;

  let unpushed = "unknown";
  if (branch) {
    const log = piPodGit(["log", "--oneline", "--no-decorate", "origin/" + branch + "..HEAD"], {
      allowFailure: true,
    });
    unpushed = log === null ? "unknown" : String(log.split("\\n").filter((line) => line.trim() !== "").length);
  }

  return [
    "pi-pod session",
    "  provider     " + (process.env.PI_POD_PROVIDER || "unknown"),
    "  pod id       " + piPodId(),
    "  image        " + (process.env.PI_POD_IMAGE || "unknown"),
    "  project      " + (process.env.PI_POD_PROJECT || "unknown"),
    "  uptime       " + piPodFormatUptime(process.env.PI_POD_CREATED),
    "  egress       " + piPodFormatEgress(process.env.PI_POD_EGRESS),
    "  branch       " + (branch || "(detached HEAD)"),
    "  unpushed     " + unpushed + " commit(s)",
    "  dirty        " + dirtyCount + " file(s)",
  ].join("\\n");
}

function piPodCompareUrl(remoteUrl, branch) {
  let url = remoteUrl.trim().replace(/\\.git$/, "");
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\\/)(.+)$/.exec(url);
  if (scp) url = "https://" + scp[1] + "/" + scp[2];
  url = url.replace(/^ssh:\\/\\/(?:[^@/]+@)?/, "https://").replace(/^git:\\/\\//, "https://");
  return url + "/compare/" + encodeURIComponent(branch) + "?expand=1";
}

function piPodPush() {
  const branch = piPodGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true });
  if (!branch) return "HEAD is detached — check out a branch before pushing. (/pod-push never force-pushes.)";

  const output = [];
  try {
    const pushed = piPodExecFileSync("git", ["push", "--set-upstream", "origin", branch], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    output.push(pushed.trim() || "pushed " + branch + " to origin");
  } catch (error) {
    const stderr = error && error.stderr ? String(error.stderr).trim() : "";
    return "push failed:\\n" + (stderr || String(error));
  }

  if (piPodHas("gh")) {
    try {
      const url = piPodExecFileSync("gh", ["pr", "view", "--json", "url", "--jq", ".url"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (url) {
        output.push("existing PR: " + url);
        return output.join("\\n");
      }
    } catch {}
  }

  const remote = piPodGit(["remote", "get-url", "origin"], { allowFailure: true });
  if (remote) output.push("open a PR: " + piPodCompareUrl(remote, branch));
  return output.join("\\n");
}

function installPiPodCompanion(pi) {
  const notInPod = "not in a pod — this command only works inside a pi-pod session";
  const register = (name, description, action) => {
    pi.registerCommand(name, {
      description,
      handler: async (_args, ctx) => {
        const text = piPodInPod() ? action() : notInPod;
        ctx.ui.notify(text, "info");
        return text;
      },
    });
  };
  register("pod-status", "Show pi-pod status (provider, image, egress, git state)", piPodStatus);
  register("pod-push", "Push the current branch and print a PR link", piPodPush);
}
`;
}
