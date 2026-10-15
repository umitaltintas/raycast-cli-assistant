import { spawn } from "./spawn";
import { homedir, userInfo } from "node:os";
import {
  DEFAULT_SHELL,
  IS_WINDOWS,
  resolveGitBash,
  resolvePowerShell,
  Shell,
  shellLang,
  withPosixLocale,
} from "./platform";

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

// Git Bash reads the command from the environment: MSYS parses its Windows
// command line with its own quoting and glob rules. PowerShell takes it as an
// argument (-EncodedCommand would be safer still, but 5.1 then sends errors
// as CLIXML; -File would be subject to the execution policy).
const COMMAND_VAR = "CLI_ASSISTANT_COMMAND";

// macOS: a login shell, so Homebrew & co. are on PATH (Raycast's own PATH is
// minimal). Windows: the shell the command was written for, Git Bash (a login
// shell too, for /usr/bin) or PowerShell.
function shellArgs(command: string, shell: Shell): [string, string[]] | string {
  if (!IS_WINDOWS) return ["/bin/zsh", ["-lc", command]];
  if (shell === "bash") {
    const bash = resolveGitBash();
    if (!bash)
      return "Git Bash not found. Install Git for Windows or set CLAUDE_CODE_GIT_BASH_PATH.";
    return [bash, ["-lc", `eval "$${COMMAND_VAR}"`]];
  }
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
export function runApprovedCommand(
  command: string,
  shell: Shell = DEFAULT_SHELL,
): Promise<ShellResult> {
  const { username } = userInfo();
  const resolved = shellArgs(command, shell);
  if (typeof resolved === "string") {
    return Promise.resolve({
      output: resolved,
      exitCode: null,
      timedOut: false,
    });
  }
  const [bin, args] = resolved;
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: homedir(),
      env: {
        ...withPosixLocale(process.env),
        USER: process.env.USER ?? username,
        LOGNAME: process.env.LOGNAME ?? username,
        // Git Bash's login profile would cd to HOME without it.
        ...(IS_WINDOWS ? { [COMMAND_VAR]: command, CHERE_INVOKING: "1" } : {}),
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
export function commandResultPrompt(
  command: string,
  r: ShellResult,
  shell?: Shell,
): string {
  const trimmed =
    r.output.length > MAX_OUTPUT
      ? `${r.output.slice(0, MAX_OUTPUT)}\n… (${r.output.length - MAX_OUTPUT} more characters cut)`
      : r.output;
  const status = r.timedOut
    ? `was stopped after ${TIMEOUT_MS / 1000} s`
    : `exited with code ${r.exitCode}`;
  return [
    `I approved and ran your command; it ${status}.`,
    `\`\`\`${shellLang(shell)}`,
    command,
    "```",
    "Output:",
    "```",
    trimmed.trimEnd() || "(no output)",
    "```",
    "Continue with my request.",
  ].join("\n");
}
