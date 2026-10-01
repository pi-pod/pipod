import * as dns from "node:dns/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { run, runOk } from "./exec.js";
import type { EgressPolicy } from "../wire.js";

const NETNS_DIR = "/var/run/netns";

/**
 * Apply an nftables ruleset from a private temp file. nftables 1.0.9+ refuses `-f -` when
 * stdin is a pipe ("Not a regular file"), which is exactly how a spawned child receives it;
 * a regular file works on every version deployed and on CI runners alike.
 */
async function nftApply(command: [string, ...string[]], ruleset: string): Promise<void> {
  const file = path.join(os.tmpdir(), `pps-nft-${process.pid}-${randomUUID()}.nft`);
  fs.writeFileSync(file, ruleset, { mode: 0o600 });
  try {
    const [binary, ...args] = command;
    await runOk(binary, [...args, "-f", file]);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export interface NetworkPlan {
  /** Stable per-sandbox index; owns one address on the bridge subnet. */
  index: number;
  name: string;
  address: string;
  gateway: string;
  prefixLen: number;
}

/** Named netns so the whole network is configured before the container's first process runs. */
export function netnsName(sandboxId: string): string {
  return `pps-${sandboxId}`;
}

export function netnsPath(sandboxId: string): string {
  return `${NETNS_DIR}/${netnsName(sandboxId)}`;
}

function ipToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export function planAddress(cidr: string, index: number): NetworkPlan {
  const [base, lenRaw] = cidr.split("/");
  const prefixLen = Number(lenRaw ?? 16);
  const network = ipToInt(base!) & (prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0);
  const host = index + 2; // .0 is the network, .1 is the bridge itself
  const max = 2 ** (32 - prefixLen) - 2;
  if (host > max) throw new Error(`bridge subnet ${cidr} exhausted at ${max} sandboxes`);
  return {
    index,
    name: "",
    address: intToIp(network + host),
    gateway: intToIp(network + 1),
    prefixLen,
  };
}

/**
 * Egress is fail-closed: a request that says nothing about the network gets no Internet.
 * Open mode stays available, but a sandbox only reaches the Internet because a caller asked
 * for it in as many words — the default cannot be an abuse channel nobody opted into.
 * The DNS servers and the keepalive host are added at apply time, so an empty allowlist is
 * still a working sandbox.
 */
export function resolveEgress(requested?: EgressPolicy): EgressPolicy {
  return requested ?? { mode: "allowlist", hosts: [] };
}

export function egressRuleset(mode: EgressPolicy["mode"], v4: string[], v6: string[]): string {
  const v4Rule = v4.length > 0 ? `ip daddr { ${v4.join(", ")} } accept` : "";
  const v6Rule = v6.length > 0 ? `ip6 daddr { ${v6.join(", ")} } accept` : "";
  return `
table inet pps_egress {
  chain output {
    type filter hook output priority filter; policy ${mode === "open" ? "accept" : "drop"};
    ct state established,related accept
    oifname "lo" accept
    # Cloud metadata is host infrastructure, not Internet egress. Keep it unreachable even
    # when users deliberately choose open mode.
    ip daddr 169.254.0.0/16 reject with icmp type admin-prohibited
    ip6 daddr fe80::/10 reject with icmpv6 type admin-prohibited
    ${v4Rule}
    ${v6Rule}
    ${mode === "allowlist" ? "reject with icmpx type admin-prohibited" : ""}
  }
}
`;
}

export class Network {
  readonly resourcePrefix: string;
  readonly natTable: string;

  constructor(
    private readonly bridge: string,
    private readonly cidr: string,
    private readonly dnsServers: string[],
    resourcePrefix = "pps",
  ) {
    const normalized = resourcePrefix.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 8);
    if (!normalized) throw new Error("network resource prefix must contain an alphanumeric character");
    this.resourcePrefix = normalized;
    this.natTable = `${normalized}_nat`;
  }

  /** veth names are capped at 15 chars; the service prefix isolates independent instances. */
  private vethNames(index: number): { host: string; peer: string } {
    return { host: `${this.resourcePrefix}${index}h`, peer: `${this.resourcePrefix}${index}p` };
  }

  async ensureBridge(): Promise<void> {
    const plan = planAddress(this.cidr, -1); // gateway only
    const existing = await run("ip", ["link", "show", this.bridge]);
    if (existing.code !== 0) {
      await runOk("ip", ["link", "add", this.bridge, "type", "bridge"]);
    }
    const addrs = await run("ip", ["-4", "addr", "show", "dev", this.bridge]);
    if (!addrs.stdout.includes(`${plan.gateway}/`)) {
      await run("ip", ["addr", "add", `${plan.gateway}/${plan.prefixLen}`, "dev", this.bridge]);
    }
    await runOk("ip", ["link", "set", this.bridge, "up"]);
    fs.writeFileSync("/proc/sys/net/ipv4/ip_forward", "1");
    await this.ensureNat();
  }

  private async ensureNat(): Promise<void> {
    const ruleset = `
table ip ${this.natTable} {
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    ip saddr ${this.cidr} oifname != "${this.bridge}" masquerade
  }
}
`;
    await run("nft", ["delete", "table", "ip", this.natTable]);
    await nftApply(["nft"], ruleset);
  }

  /** Test/decommission cleanup. Live service shutdown deliberately leaves its bridge in place. */
  async destroyServiceNetwork(): Promise<void> {
    await run("nft", ["delete", "table", "ip", this.natTable]);
    await run("ip", ["link", "delete", this.bridge]);
  }

  async create(sandboxId: string, index: number): Promise<NetworkPlan> {
    const plan = planAddress(this.cidr, index);
    const { host, peer } = this.vethNames(index);
    const ns = netnsName(sandboxId);

    await this.destroy(sandboxId, index);
    fs.mkdirSync(NETNS_DIR, { recursive: true });
    await runOk("ip", ["netns", "add", ns]);
    await runOk("ip", ["link", "add", host, "type", "veth", "peer", "name", peer]);
    await runOk("ip", ["link", "set", peer, "netns", ns]);
    await runOk("ip", ["link", "set", host, "master", this.bridge]);
    await runOk("ip", ["link", "set", host, "up"]);
    await this.inNs(ns, ["ip", "link", "set", "lo", "up"]);
    await this.inNs(ns, ["ip", "addr", "add", `${plan.address}/${plan.prefixLen}`, "dev", peer]);
    await this.inNs(ns, ["ip", "link", "set", peer, "up"]);
    await this.inNs(ns, ["ip", "route", "add", "default", "via", plan.gateway]);
    return { ...plan, name: ns };
  }

  private async inNs(ns: string, argv: string[], input?: string): Promise<void> {
    await runOk("ip", ["netns", "exec", ns, ...argv], input === undefined ? {} : { input });
  }

  /**
   * Enforcement is CIDR-level (§8): hostnames are resolved here, once, at apply time.
   * The keepalive host is always allowed — an allowlist that blocks it silently converts
   * every detached pod into an idle-timeout casualty.
   */
  async applyEgress(
    sandboxId: string,
    policy: EgressPolicy,
    extraHosts: string[] = [],
  ): Promise<{ v4: string[]; v6: string[] }> {
    const ns = netnsName(sandboxId);

    const v4 = new Set<string>();
    const v6 = new Set<string>();
    if (policy.mode === "allowlist") {
      for (const entry of [...policy.hosts, ...extraHosts, ...this.dnsServers]) {
        if (/^[\d.]+\/\d+$/.test(entry) || /^[\da-fA-F:]+\/\d+$/.test(entry)) {
          (entry.includes(":") ? v6 : v4).add(entry);
          continue;
        }
        if (/^[\d.]+$/.test(entry)) {
          v4.add(`${entry}/32`);
          continue;
        }
        if (/^[\da-fA-F:]+$/.test(entry) && entry.includes(":")) {
          v6.add(`${entry}/128`);
          continue;
        }
        // A records only: sandboxes get an IPv4 address on a NATed bridge and no IPv6 route,
        // so an AAAA entry would allow an address that is unreachable regardless.
        for (const ip of await dns.resolve4(entry).catch(() => [] as string[])) v4.add(`${ip}/32`);
      }
    }

    const ruleset = egressRuleset(policy.mode, [...v4], [...v6]);
    await run("ip", ["netns", "exec", ns, "nft", "delete", "table", "inet", "pps_egress"]);
    await nftApply(["ip", "netns", "exec", ns, "nft"], ruleset);
    return { v4: [...v4], v6: [...v6] };
  }

  async destroy(sandboxId: string, index: number): Promise<void> {
    const {host}=this.vethNames(index);
    await run("ip",["netns","del",netnsName(sandboxId)]);
    await run("ip",["link","del",host]);
  }

  /** Shadow mode requires positive absence, not best-effort idempotent deletes. */
  async destroyVerified(sandboxId:string,index:number):Promise<void>{
    const name=netnsName(sandboxId),{host}=this.vethNames(index);
    const list=async()=>await runOk("ip",["netns","list"]);
    let names=(await list()).split("\n").map(line=>line.trim().split(/\s+/)[0]).filter(Boolean);
    if(names.includes(name)){
      const deleted=await run("ip",["netns","del",name]);
      names=(await list()).split("\n").map(line=>line.trim().split(/\s+/)[0]).filter(Boolean);
      if(names.includes(name))throw new Error(`network namespace ${name} remains after delete (${deleted.code})`);
    }
    const sysNet="/sys/class/net";
    if(!fs.existsSync(sysNet))throw new Error("network interface absence cannot be verified");
    if(fs.existsSync(path.join(sysNet,host))){
      const deleted=await run("ip",["link","del",host]);
      if(fs.existsSync(path.join(sysNet,host)))
        throw new Error(`sandbox interface ${host} remains after delete (${deleted.code})`);
    }
  }

  resolvConf(): string {
    return `${this.dnsServers.map((s) => `nameserver ${s}`).join("\n")}\noptions ndots:0\n`;
  }
}
