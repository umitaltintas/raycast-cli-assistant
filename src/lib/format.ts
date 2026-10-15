import { IS_WINDOWS } from "./platform";
import { ModelError, RateLimit } from "./types";

function clock(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(
    undefined,
    sameDay
      ? { hour: "2-digit", minute: "2-digit" }
      : { weekday: "short", hour: "2-digit", minute: "2-digit" },
  );
}

export function rateLimitLines(
  r?: RateLimit,
): { title: string; text: string }[] {
  const lines: { title: string; text: string }[] = [];
  if (r?.fiveHour) {
    lines.push({
      title: "5-Hour Limit",
      text: `${Math.round(r.fiveHour.utilization * 100)}% · resets ${clock(r.fiveHour.resetsAt)}`,
    });
  }
  if (r?.sevenDay) {
    lines.push({
      title: "Weekly Limit",
      text: `${Math.round(r.sevenDay.utilization * 100)}% · resets ${clock(r.sevenDay.resetsAt)}`,
    });
  }
  return lines;
}

// "Sonnet 5.5 · 4.2 s" under an answer.
export function footerMarkdown(
  model: string | undefined,
  label: (m: string) => string,
  durationMs?: number,
): string {
  const parts = [
    model ? label(model) : undefined,
    durationMs ? `${(durationMs / 1000).toFixed(1)} s` : undefined,
  ].filter(Boolean);
  return parts.length ? `\n\n---\n\n_${parts.join(" · ")}_` : "";
}

export function errorMarkdown(error: ModelError): string {
  const codex = error.provider === "codex";
  switch (error.kind) {
    case "not-installed":
      if (IS_WINDOWS) {
        return codex
          ? "## Codex CLI not found\n\nInstall it: `npm i -g @openai/codex`\n\nIf it lives elsewhere, set **Codex CLI Path** (the `codex.exe`, not `codex.cmd`) in the extension preferences."
          : "## Claude Code CLI not found\n\nInstall it in PowerShell: `irm https://claude.ai/install.ps1 | iex`\n\nIf it lives elsewhere, set **Claude CLI Path** (the `claude.exe`) in the extension preferences.";
      }
      return codex
        ? "## Codex CLI not found\n\nInstall it: `brew install codex` (or `npm i -g @openai/codex`). The ChatGPT app also ships one.\n\nIf it lives elsewhere, set **Codex CLI Path** in the extension preferences."
        : "## Claude Code CLI not found\n\nInstall it: `curl -fsSL https://claude.ai/install.sh | bash`\n\nIf it lives elsewhere, set **Claude CLI Path** in the extension preferences.";
    case "not-logged-in":
      return codex
        ? `## Not logged in to Codex\n\nRun \`codex login\` in a terminal and sign in with your ChatGPT account.\n\n\`\`\`\n${error.message}\n\`\`\``
        : `## Not logged in to Claude\n\nRun \`claude\` in a terminal and sign in with \`/login\`.\n\n\`\`\`\n${error.message}\n\`\`\``;
    case "usage-limit":
      return `## Usage limit reached\n\n${error.message}`;
    case "cancelled":
      return "_Stopped._";
    default:
      return `## Error\n\n\`\`\`\n${error.message}\n\`\`\``;
  }
}
