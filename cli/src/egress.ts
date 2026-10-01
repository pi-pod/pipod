export const PIPOD_ENDPOINT_HINTS: Record<string, string> = {
  GH_TOKEN: "github.com",
  GITHUB_TOKEN: "github.com",
  GIT_TOKEN: "github.com",
};

export const PI_AUTH_HOST = "api.anthropic.com";
export const CLAUDE_AUTH_HOSTS: readonly string[] = ["api.anthropic.com", "platform.claude.com"];

export const BASE_URL_KEYS = [
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "AZURE_OPENAI_ENDPOINT",
  "PI_BASE_URL",
] as const;
