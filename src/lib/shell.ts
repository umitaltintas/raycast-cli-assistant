import { spawn } from "./spawn";
import { homedir, userInfo } from "node:os";
import { IS_WINDOWS, resolvePowerShell, shellLang } from "./platform";

const TIMEOUT_MS = 120_000;
// Enough for the model to work with; huge outputs would only cost tokens.
const MAX_OUTPUT = 20_000;

export interface ShellResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
}

// Redirected, PowerShell writes in the OEM code page, colors errors with ANSI
// codes (7.2+ has $PSStyle) and turns progress bars into CLIXML noise.
const POWERSHELL_PREAMBLE = [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "$OutputEncoding = [Text.Encoding]::UTF8",
  "$ProgressPreference = 'SilentlyContinue'",
  "if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }",
  "",
].join("\n");

// Only Codex's commands run here (from its `approve` block); Claude Code runs
// its own. macOS: a login shell, so Homebrew & co. are on PATH (Raycast's own
// PATH is minimal). Windows: PowerShell, Codex's shell there. It takes the
// command as an argument (-EncodedCommand would be safer still, but 5.1 then
// sends errors as CLIXML; -File would be subject to the execution policy).
function shellArgs(command: string): [string, string[]] {
  if (!IS_WINDOWS) return ["/bin/zsh", ["-lc", command]];
  return [
    resolvePowerShell(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      POWERSHELL_PREAMBLE + command,
    ],
  ];
}

// Runs a command the user approved. stdout and stderr are interleaved.
export function runApprovedCommand(command: string): Promise<ShellResult> {
  const { username } = userInfo();
  const [bin, args] = shellArgs(command);
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: homedir(),
      env: {
        ...process.env,
        USER: process.env.USER ?? username,
        LOGNAME: process.env.LOGNAME ?? username,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let timedOut = false;
    const collect = (chunk: Buffer) => (output += chunk.toString());
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      // On Windows this ends the whole tree (see spawn.ts).
      child.kill("SIGTERM");
    }, TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ output: err.message, exitCode: null, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ output, exitCode: code, timedOut });
    });
  });
}

// The follow-up message that hands the result back to the model.
export function commandResultPrompt(command: string, r: ShellResult): string {
  const trimmed =
    r.output.length > MAX_OUTPUT
      ? `${r.output.slice(0, MAX_OUTPUT)}\n… (${r.output.length - MAX_OUTPUT} more characters cut)`
      : r.output;
  const status = r.timedOut
    ? `was stopped after ${TIMEOUT_MS / 1000} s`
    : `exited with code ${r.exitCode}`;
  return [
    `I approved and ran your command; it ${status}.`,
    `\`\`\`${shellLang(undefined)}`,
    command,
    "```",
    "Output:",
    "```",
    trimmed.trimEnd() || "(no output)",
    "```",
    "Continue with my request.",
  ].join("\n");
}
