/**
 * The template brief: what the agent in a pod is told about the template the pod launched
 * from. A template's author writes agent instructions, chiefly the access its pods are meant to
 * have ("read-write in staging, read-only in production"), and every session in a pod launched
 * from it reads them in its system prompt, next to what the platform enforces for that pod.
 *
 * The instructions are advisory. Access is what the pod was given: the secrets in its
 * environment, its egress policy, and a pod token that launches children and schedules jobs only
 * from this same template (lineage.ts). The brief says which is which, because an agent that
 * takes a sentence for the boundary reads a credential that allows more as permission to use it.
 *
 * Frozen at launch: the instructions travel in the launch report with the egress and secret
 * names they describe, and the brief is rendered from that report wherever the generated pi-pod
 * extension is uploaded. Editing a template changes the next launch, never what a running
 * agent was told.
 */
import type { PodExtensionSettings } from "../../core/client/pod-extension.js";
import type { TemplateRow } from "../templates/store.js";
import { egressPolicyFromDescription } from "./supervisor.js";
import type { ResolvedConfigReport } from "./types.js";

/** An allowlist names every builtin and derived host; past this many the list is noise. */
const MAX_LISTED_HOSTS = 40;

/** What a launch freezes into its report: nothing when the template has no instructions. */
export function launchAgentInstructions(
  template: Pick<TemplateRow, "name" | "agent_instructions"> | null,
): Pick<ResolvedConfigReport, "agentInstructions"> {
  const text = template?.agent_instructions?.trim();
  return template && text ? { agentInstructions: { template: template.name, text } } : {};
}

/** Everything in a launch report that shapes the generated pi-pod extension. */
export function podExtensionSettings(report: ResolvedConfigReport): PodExtensionSettings {
  const brief = renderTemplateBrief(report);
  return {
    sessionNaming: report.config.pi.sessionNaming,
    ...(brief ? { templateBrief: brief } : {}),
  };
}

/** The system-prompt section for a pod, or null when its template gave the agent nothing to read. */
export function renderTemplateBrief(
  report: Pick<ResolvedConfigReport, "agentInstructions" | "egress" | "secretKeys" | "secretScopes">,
): string | null {
  const instructions = report.agentInstructions;
  if (!instructions) return null;
  return [
    "## Pod template",
    `This pod was launched from the pod template ${JSON.stringify(instructions.template)}. Its author wrote ` +
      "these instructions for the agent in every pod launched from it:",
    "",
    "<template-instructions>",
    instructions.text,
    "</template-instructions>",
    "",
    "What the platform enforces for this pod:",
    `- Network: ${describeEgress(report.egress)}`,
    `- Secrets in the environment: ${describeSecrets(report)}`,
    "- Child pods you launch and scheduled jobs you create use this same template; the server refuses any other.",
    "",
    "The instructions describe the access this pod is meant to have. Stay within them even where a " +
      "credential or the network would allow more: the platform enforces only the list above. A blocked " +
      "host or a refused request is deliberate, so do not work around it. When a task needs access " +
      "beyond the instructions, stop and tell the user what is missing.",
  ].join("\n");
}

function describeEgress(egress: ResolvedConfigReport["egress"]): string {
  const policy = egressPolicyFromDescription(egress.description);
  if (policy?.mode === "open" || (!policy && egress.mode === "open")) return "open; any host is reachable.";
  if (!policy || policy.mode !== "allowlist") return "allowlist; only allowed hosts are reachable.";
  const listed = policy.hosts.slice(0, MAX_LISTED_HOSTS).join(", ");
  const more = policy.hosts.length - MAX_LISTED_HOSTS;
  return `allowlist; only these hosts are reachable: ${listed}${more > 0 ? ` and ${more} more` : ""}.`;
}

function describeSecrets(report: Pick<ResolvedConfigReport, "secretKeys" | "secretScopes">): string {
  if (report.secretKeys.length === 0) return "none.";
  const scopes = report.secretScopes ?? {};
  const named = report.secretKeys.map((key) => (scopes[key] ? `${key} (${scopes[key]})` : key));
  return `${named.join(", ")}. The scope in parentheses is where each is stored: the template, ` +
    "the user's own secrets, or the organization's.";
}
