import { getPreferenceValues } from "@raycast/api";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

// Both CLIs take the same levels: claude --effort, codex model_reasoning_effort.
export const EFFORTS: { value: Effort; title: string }[] = [
  { value: "low", title: "Low" },
  { value: "medium", title: "Medium" },
  { value: "high", title: "High" },
  { value: "xhigh", title: "Extra High" },
  { value: "max", title: "Max" },
];

// What a request may use beyond plain text. Each command decides how its
// answer starts (Ask AI and Chat from the preferences): each option makes
// requests bigger, and an answer that uses it slower.
export interface RequestOptions {
  webSearch?: boolean;
  effort?: Effort;
  // Read files and run shell commands: Claude Code asks mid-turn before one
  // that changes something (or decides itself in auto mode, if turned on);
  // Codex in its read-only sandbox, such a command only after approval.
  tools?: boolean;
  // Finder selection: the selected folders (or those of the selected files).
  // Codex runs in the first one; Claude gets the paths in the prompt.
  readDirs?: string[];
}

export function defaultOptions(): RequestOptions {
  const prefs = getPreferenceValues<Preferences>();
  return {
    webSearch: prefs.webSearch || undefined,
    effort: (prefs.effort as Effort) || undefined,
    tools: prefs.chatTools || undefined,
  };
}

export function effortTitle(effort: Effort | undefined): string {
  return EFFORTS.find((e) => e.value === effort)?.title ?? "CLI Default";
}

// Short markers for titles: "Web · Tools · High".
export function optionBadges(o: RequestOptions | undefined): string[] {
  const badges: string[] = [];
  if (o?.webSearch) badges.push("Web");
  if (o?.tools) badges.push("Tools");
  if (o?.effort) badges.push(effortTitle(o.effort));
  return badges;
}
