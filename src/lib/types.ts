import { getPreferenceValues } from "@raycast/api";
import { RequestOptions } from "./options";
import { Shell } from "./platform";
import { Provider } from "./provider";

export interface RateLimit {
  fiveHour?: { utilization: number; resetsAt: number };
  sevenDay?: { utilization: number; resetsAt: number };
}

export interface RunOptions extends RequestOptions {
  prompt: string;
  model?: string;
  systemPrompt?: string;
  // Multi-turn chat. Claude: --session-id, then --resume. Codex: the thread id
  // recorded for this session, then `codex exec resume`.
  sessionId?: string;
  signal?: AbortSignal;
  onText?: (fullText: string) => void;
  onSteps?: (steps: string[]) => void;
  // Claude with tools: a shell command waits mid-turn until this resolves.
  onPermission?: (request: PermissionRequest) => Promise<PermissionAnswer>;
}

// Run it, or don't; a note with "don't" tells Claude what to do instead.
export interface PermissionAnswer {
  allow: boolean;
  note?: string;
}

// A shell command waiting for the user's answer while the model works.
export interface PermissionRequest {
  // The tool call's id.
  id: string;
  command: string;
  shell: Shell;
  // The tool call's own one-line summary.
  description?: string;
}

export interface DeniedCommand {
  command: string;
  shell: Shell;
}

export interface RunResult {
  text: string;
  isError: boolean;
  error?: ModelError;
  rateLimit?: RateLimit;
  durationMs?: number;
  // Codex: shell commands from its `approve` block; they wait for the user's
  // approval and then run in the extension (see shell.ts).
  commands?: string[];
  // Claude: shell commands Claude Code refused without asking the user (e.g.
  // auto mode). Only listed: the extension never runs Claude's commands.
  denied?: DeniedCommand[];
  // What the model did on the way (see steps.ts).
  steps?: string[];
}

export type ModelErrorKind =
  "not-installed" | "not-logged-in" | "usage-limit" | "cancelled" | "other";

export interface ModelError {
  kind: ModelErrorKind;
  message: string;
  provider?: Provider;
}

const DEFAULT_SYSTEM_PROMPT = [
  "You are a concise assistant invoked from Raycast.",
  "Reply in the language the user writes in.",
  "Skip filler and preambles; get straight to the answer.",
  "Use Markdown when helpful; use fenced code blocks with a language tag for code.",
].join(" ");

export function systemPrompt(base = DEFAULT_SYSTEM_PROMPT): string {
  const extra = getPreferenceValues<Preferences>().extraInstructions?.trim();
  return extra
    ? `${base}\n\nAdditional instructions from the user: ${extra}`
    : base;
}
