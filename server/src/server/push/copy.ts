/**
 * Human push copy (spec §11). The lock screen is the product's front door on mobile:
 * a notification body is a sentence about what pi did, never raw event JSON.
 */

const MAX_BODY = 120;

export function truncate(text: string, max = MAX_BODY): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** Pull assistant text out of an event that embeds a message ({ role, content } shapes). */
export function assistantTextFrom(event: unknown): string | null {
  if (typeof event !== "object" || event === null) return null;
  const message = (event as { message?: unknown }).message;
  const source = typeof message === "object" && message !== null ? message : event;
  const content = (source as { content?: unknown }).content;
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    for (let i = content.length - 1; i >= 0; i--) {
      const part = content[i] as { type?: unknown; text?: unknown };
      if (typeof part?.text === "string" && part.text.trim() && part.type !== "thinking") {
        return part.text;
      }
    }
  }
  return null;
}

/** Body for a turn-completed push: the assistant's closing words, else a plain sentence. */
export function turnEndSummary(event: unknown, podName: string): string {
  const text = assistantTextFrom(event);
  return text ? truncate(text) : `pi finished a task in ${podName}`;
}
