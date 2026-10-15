import { homedir } from "node:os";
import { IS_WINDOWS } from "./platform";

// What the model did while answering (searches, files read, commands run),
// shown live and kept above the answer. Read-only commands can run without
// asking, so this is also where the user sees them.

const clip = (s: string, n = 90) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;
const code = (s: string) =>
  `\`${clip(s.replace(/\s+/g, " ")).replace(/`/g, "'")}\``;

// Windows paths can come with either slash and any case.
function shortPath(p: string): string {
  const home = homedir();
  const norm = (s: string) =>
    IS_WINDOWS ? s.replace(/\//g, "\\").toLowerCase() : s;
  return norm(p).startsWith(norm(home)) ? `~${p.slice(home.length)}` : p;
}

function webStep(queryOrUrl: string): string {
  return /^https?:\/\//.test(queryOrUrl)
    ? `🌐 Opened ${clip(queryOrUrl)}`
    : `🔎 Searched the web: ${clip(queryOrUrl)}`;
}

export const SEARCHING_STEP = "🔎 Searching the web…";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function claudeStep(name: string, input: any): string | undefined {
  switch (name) {
    case "Bash":
    case "PowerShell":
      return input?.command ? `💻 Ran ${code(input.command)}` : undefined;
    case "Read":
      return input?.file_path
        ? `📄 Read ${shortPath(input.file_path)}`
        : undefined;
    case "Glob":
      return input?.pattern ? `🗂 Looked for ${code(input.pattern)}` : undefined;
    case "Grep":
      return input?.pattern
        ? `🗂 Searched files for ${code(input.pattern)}`
        : undefined;
    case "WebSearch":
      return input?.query ? webStep(input.query) : SEARCHING_STEP;
    case "WebFetch":
      return input?.url ? webStep(input.url) : undefined;
    default:
      return undefined;
  }
}

// Codex reports commands wrapped as /bin/zsh -lc '<command>' (or "<command>");
// on Windows as <path>\pwsh.exe [-NoProfile] -Command '<command>', the path
// quoted when it has spaces.
const SHELL_WRAPPER = IS_WINDOWS
  ? /^(['"]?)[^'"]*?(?:pwsh|powershell|bash)(?:\.exe)?\1 (?:-\w+ )*?-(?:Command|l?c) (?<q>['"])(?<cmd>[\s\S]*)\k<q>$/i
  : /^\S*\/(?:ba|z)?sh -l?c (?<q>['"])(?<cmd>[\s\S]*)\k<q>$/;

export function codexCommandStep(command: string): string {
  const m = command.match(SHELL_WRAPPER)?.groups;
  const inner = !m
    ? command
    : m.q === "'"
      ? m.cmd.replace(/'\\''/g, "'")
      : m.cmd.replace(/\\(["\\$`])/g, "$1");
  return `💻 Ran ${code(inner)}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function codexWebStep(item: any): string {
  const q = item?.action?.query || item?.query;
  return q ? webStep(q) : SEARCHING_STEP;
}

export function stepsMarkdown(steps: string[] | undefined): string {
  if (!steps?.length) return "";
  return `${steps.map((s) => `> ${s}`).join("  \n")}\n\n`;
}
