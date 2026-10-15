import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export const IS_WINDOWS = process.platform === "win32";

// Names and hints that differ between macOS and Windows.
export const FILE_MANAGER = IS_WINDOWS ? "File Explorer" : "Finder";
export const MOD_KEY = IS_WINDOWS ? "Ctrl+" : "⌘";

// The shell a command was written for, to show it with the right syntax
// highlighting. On Windows Claude Code has both a Bash (Git Bash) and a
// PowerShell tool, and Codex's own shell is PowerShell.
export type Shell = "bash" | "powershell";
export const DEFAULT_SHELL: Shell = IS_WINDOWS ? "powershell" : "bash";

export function shellLang(shell: Shell | undefined): string {
  return (shell ?? DEFAULT_SHELL) === "powershell" ? "powershell" : "sh";
}

// Raycast on Windows sets LC_ALL to a BCP 47 tag ("en-US-u-ca-gregory-…").
// Git Bash can't use it and warns on every command ("setlocale: LC_ALL:
// cannot change locale"), so locale variables that aren't POSIX names are
// dropped; Git Bash then uses its own default.
const POSIX_LOCALE =
  /^(C|POSIX|[A-Za-z]{2,3}(_[A-Za-z]{2})?)(\.[\w-]+)?(@\w+)?$/;

export function withPosixLocale(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!IS_WINDOWS) return env;
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) =>
        !(key === "LANG" || key.startsWith("LC_")) ||
        POSIX_LOCALE.test(value ?? ""),
    ),
  );
}

// "~/…" (or "~\…" on Windows) in a preference path means the home folder.
export function expandHome(path: string): string {
  return path.replace(/^~(?=[\\/]|$)/, homedir());
}

function onPath(file: string): string[] {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, file));
}

// A path set in the preferences wins. Otherwise the known install locations
// are tried, and on Windows then PATH (Raycast on macOS doesn't inherit the
// shell PATH, on Windows it does). On Windows only .exe counts: npm's .cmd
// shims can't be spawned without a shell, which would mangle the arguments.
export function findBinary(
  custom: string | undefined,
  candidates: string[],
  name: string,
): string | undefined {
  if (custom?.trim()) {
    const path = expandHome(custom.trim());
    return existsSync(path) ? path : undefined;
  }
  const file = IS_WINDOWS ? `${name}.exe` : name;
  const all = IS_WINDOWS ? [...candidates, ...onPath(file)] : candidates;
  return all.find((p) => existsSync(p));
}

// PowerShell 7 if installed (Claude Code's PowerShell tool prefers it too),
// else the Windows PowerShell 5.1 that every Windows has.
export function resolvePowerShell(): string {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const candidates = [
    join(programFiles, "PowerShell", "7", "pwsh.exe"),
    ...onPath("pwsh.exe"),
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ];
  return candidates.find((p) => existsSync(p)) ?? "powershell.exe";
}
