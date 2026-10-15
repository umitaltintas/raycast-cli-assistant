import { environment, getPreferenceValues } from "@raycast/api";
import { spawn } from "./spawn";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { findBinary, IS_WINDOWS, Shell, withPosixLocale } from "./platform";
import { currentModel } from "./models";
import { claudeStep } from "./steps";
import {
  ModelError,
  RateLimit,
  RunOptions,
  RunResult,
  systemPrompt,
} from "./types";

export function resolveClaudeBinary(): string | undefined {
  return findBinary(
    getPreferenceValues<Preferences>().claudePath,
    IS_WINDOWS
      ? [join(homedir(), ".local", "bin", "claude.exe")]
      : [
          join(homedir(), ".local/bin/claude"),
          "/opt/homebrew/bin/claude",
          "/usr/local/bin/claude",
        ],
    "claude",
  );
}

// --setting-sources "" also skips the user's settings.json, so its proxy
// variables are read here and passed to the child process.
function proxyEnv(): Record<string, string> {
  try {
    const settings = JSON.parse(
      readFileSync(join(homedir(), ".claude/settings.json"), "utf8"),
    );
    const env = settings?.env ?? {};
    const keys = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];
    return Object.fromEntries(
      keys.filter((k) => typeof env[k] === "string").map((k) => [k, env[k]]),
    );
  } catch {
    return {};
  }
}

export function childEnv(): NodeJS.ProcessEnv {
  // The locale also reaches Claude Code's own Bash tool.
  const env: NodeJS.ProcessEnv = {
    ...withPosixLocale(process.env),
    ...proxyEnv(),
  };
  // Raycast extension processes have no USER/LOGNAME. Claude Code looks up its
  // Keychain login with them and reports "Not logged in" without them
  // (verified 2026-10-11).
  const { username } = userInfo();
  env.USER ??= username;
  env.LOGNAME ??= username;
  // With ANTHROPIC_API_KEY set, -p always uses it instead of the subscription.
  delete env.ANTHROPIC_API_KEY;
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1";
  env.DISABLE_AUTOUPDATER = "1";
  return env;
}

// Session files go to ~/.claude/projects/<cwd>; run in the extension's own
// folder so they don't mix with real projects.
export function workDir(): string {
  const dir = join(environment.supportPath, "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// A cancelled first turn can still leave a session file, so check the disk
// instead of guessing: reusing an id with --session-id fails as "in use".
function sessionExists(sessionId: string): boolean {
  const root = join(homedir(), ".claude/projects");
  try {
    return readdirSync(root).some((d) =>
      existsSync(join(root, d, `${sessionId}.jsonl`)),
    );
  } catch {
    return false;
  }
}

function classifyError(message: string): ModelError {
  if (
    /not logged in|login expired|\/login|invalid api key|authentication/i.test(
      message,
    )
  ) {
    return { kind: "not-logged-in", message, provider: "claude" };
  }
  if (/hit your .*limit|usage limit|rate.?limit/i.test(message)) {
    return { kind: "usage-limit", message, provider: "claude" };
  }
  return { kind: "other", message, provider: "claude" };
}

function parseRateLimit(
  info: Record<string, unknown> | undefined,
): RateLimit | undefined {
  const windows = info?.unifiedWindows as
    Record<string, { utilization: number; resetsAt: number }> | undefined;
  if (!windows) return undefined;
  return { fiveHour: windows.five_hour, sevenDay: windows.seven_day };
}

// On Windows Claude Code has a PowerShell tool next to Bash (Git Bash). It
// behaves the same in -p mode: read-only commands run, others are denied
// (verified with Claude Code 2.1.299, 2026-10-14).
const SHELL_TOOLS: Record<string, Shell> = IS_WINDOWS
  ? { Bash: "bash", PowerShell: "powershell" }
  : { Bash: "bash" };

// Web search ~20 s instead of ~2 s, file reading ~2.5 s (measured
// 2026-10-14). The shell is offered but never pre-approved: in -p mode a call
// to it is denied and comes back in permission_denials, so the extension can
// ask the user and run the exact command itself.
function toolArgs(opts: RunOptions): string[] {
  const allowed: string[] = [];
  if (opts.webSearch) allowed.push("WebSearch", "WebFetch");
  const dirs = opts.tools ? [homedir()] : (opts.readDirs ?? []);
  if (dirs.length) allowed.push("Read", "Glob", "Grep");
  const tools = opts.tools
    ? [...allowed, ...Object.keys(SHELL_TOOLS)]
    : allowed;
  const args = ["--tools", tools.join(",")];
  if (allowed.length) args.push("--allowedTools", allowed.join(","));
  for (const d of dirs) args.push("--add-dir", d);
  if (opts.effort) args.push("--effort", opts.effort);
  return args;
}

// Without it, a blocked command came with a paragraph of alternatives.
const APPROVE_PROMPT = [
  "Shell commands are shown to the user, who can approve them; a blocked command is the normal first step, not a failure.",
  "When one is blocked, say in one short sentence what it will do. Do not suggest workarounds or other commands.",
  "After approval you get its output.",
].join(" ");

export function runClaude(opts: RunOptions): Promise<RunResult> {
  const bin = resolveClaudeBinary();
  if (!bin) {
    return Promise.resolve({
      text: "",
      isError: true,
      error: {
        kind: "not-installed",
        message: "Claude Code CLI not found.",
        provider: "claude",
      },
    });
  }

  const args = [
    "-p",
    "--model",
    opts.model ?? currentModel(),
    // A chat assistant, not a coding agent: tools (unless asked for), MCP,
    // settings files and slash commands are off. Time to answer drops from
    // ~9 s to ~3 s (measured 2026-10-11). --bare is faster but ignores OAuth
    // logins.
    ...toolArgs(opts),
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--system-prompt",
    opts.tools
      ? `${opts.systemPrompt ?? systemPrompt()}\n\n${APPROVE_PROMPT}`
      : (opts.systemPrompt ?? systemPrompt()),
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
  ];
  if (opts.sessionId) {
    args.push(
      sessionExists(opts.sessionId) ? "--resume" : "--session-id",
      opts.sessionId,
    );
  } else {
    args.push("--no-session-persistence");
  }

  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: workDir(),
      env: childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Prompt via stdin avoids argv length/escaping issues. -p never returns
    // while stdin is open, so end() right away.
    child.stdin.end(opts.prompt);

    let text = "";
    let resultText: string | undefined;
    let resultIsError = false;
    let durationMs: number | undefined;
    let rateLimit: RateLimit | undefined;
    let commands: string[] = [];
    let shells: Record<string, Shell> = {};
    const steps = new Map<string, string>();
    let stderr = "";
    let cancelled = false;

    const onAbort = () => {
      cancelled = true;
      // SIGINT ends the turn cleanly; SIGTERM leaves a partial session record.
      child.kill("SIGINT");
    };
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    createInterface({ input: child.stdout }).on("line", (line) => {
      let event: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "stream_event") {
        // With tools there are several assistant messages per turn.
        if (
          event.event?.type === "message_start" &&
          text &&
          !/\n\n$/.test(text)
        ) {
          text += "\n\n";
        }
        const delta = event.event?.delta;
        if (
          event.event?.type === "content_block_delta" &&
          delta?.type === "text_delta"
        ) {
          text += delta.text;
          opts.onText?.(text);
        }
      } else if (event.type === "assistant") {
        for (const block of event.message?.content ?? []) {
          if (block?.type !== "tool_use") continue;
          const step = claudeStep(block.name, block.input);
          if (step) steps.set(block.id, step);
        }
        if (steps.size) opts.onSteps?.([...steps.values()]);
      } else if (event.type === "rate_limit_event") {
        rateLimit = parseRateLimit(event.rate_limit_info) ?? rateLimit;
      } else if (event.type === "result") {
        resultText =
          typeof event.result === "string" ? event.result : undefined;
        resultIsError = Boolean(event.is_error) || event.subtype !== "success";
        durationMs = event.duration_ms;
        commands = deniedCommands(event.permission_denials);
        shells = deniedShells(event.permission_denials);
        // Denied commands didn't run; they come back as commands to approve.
        for (const d of event.permission_denials ?? [])
          steps.delete(d?.tool_use_id);
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("error", (err) => {
      resolve({
        text,
        isError: true,
        error: { kind: "other", message: err.message, provider: "claude" },
      });
    });

    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (cancelled) {
        resolve({
          text,
          isError: true,
          error: { kind: "cancelled", message: "Stopped.", provider: "claude" },
          rateLimit,
          steps: steps.size ? [...steps.values()] : undefined,
        });
        return;
      }
      // -p reports in-run errors in the result text, not on stderr.
      const finalText = text || resultText || "";
      if (resultIsError || (code !== 0 && !finalText)) {
        const message = (
          resultText ||
          stderr ||
          finalText ||
          `claude exited with code ${code}`
        ).trim();
        resolve({
          text: finalText,
          isError: true,
          error: classifyError(message),
          rateLimit,
          steps: steps.size ? [...steps.values()] : undefined,
          durationMs,
        });
        return;
      }
      resolve({
        text: finalText,
        isError: false,
        rateLimit,
        steps: steps.size ? [...steps.values()] : undefined,
        durationMs,
        commands: commands.length ? commands : undefined,
        shells: commands.length ? shells : undefined,
      });
    });
  });
}

function deniedCommands(denials: unknown): string[] {
  if (!Array.isArray(denials)) return [];
  const commands = denials
    .filter((d) => Object.hasOwn(SHELL_TOOLS, d?.tool_name))
    .map((d) => d?.tool_input?.command)
    .filter((c): c is string => typeof c === "string" && c.trim() !== "");
  return [...new Set(commands)];
}

// Which shell each denied command was written for.
function deniedShells(denials: unknown): Record<string, Shell> {
  if (!Array.isArray(denials)) return {};
  return Object.fromEntries(
    denials
      .filter((d) => Object.hasOwn(SHELL_TOOLS, d?.tool_name))
      .filter((d) => typeof d?.tool_input?.command === "string")
      .map((d) => [d.tool_input.command, SHELL_TOOLS[d.tool_name]]),
  );
}
