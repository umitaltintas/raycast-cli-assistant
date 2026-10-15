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
  DeniedCommand,
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
// 2026-10-14). The shell is offered but never pre-approved: auto mode decides,
// or the user mid-turn (see HOST_PROMPT_ARGS).
function toolArgs(opts: Omit<RunOptions, "prompt">): string[] {
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

// Auto mode (with Tools): Claude Code's classifier runs what it judges safe
// and in line with the request (including commands the user explicitly asks
// for) without asking; the rest needs approval as before. It adds no time to
// an answer that runs no command (measured 2026-10-15).
const PERMISSION_ARGS = ["--permission-mode", "auto"];

// The prompt goes in as a JSON message rather than plain text: a process
// started before the question is known can then wait for it (plain-text -p
// exits when no input comes), and with tools stdin also carries permission
// answers. It is closed on the result.
const INPUT_ARGS = ["--input-format", "stream-json"];

// With tools, permission questions come to the extension over stdio (the
// Agent SDK's can_use_tool protocol; the flag is not in `claude --help`).
// A shell command that needs approval waits mid-turn until the user answers;
// Claude Code then runs it itself and the turn goes on. Without this, -p mode
// refused such commands on its own and the model retried them in other forms
// (3-6 attempts seen on Windows), and approving meant running the command in
// the extension and resuming the session in a new process.
const HOST_PROMPT_ARGS = ["--permission-prompt-tool", "stdio"];

const DECLINED_MESSAGE =
  "The user chose not to run this command. Don't try it another way; say so briefly.";

// A note typed with Don't Run is the answer itself, so Claude goes on with it
// in the same turn instead of ending it (it asked for what the note said right
// away, 2026-10-14).
const declinedWithNote = (note: string) =>
  `The user chose not to run this command and said: ${note}`;

function controlResponse(requestId: string, response: object): string {
  return `${JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  })}\n`;
}

// A command refused without asking (e.g. by auto mode) is only listed after
// the answer, never run by the extension; the user can tell Claude to go
// ahead, which auto mode reads as approval. Without the first line, a blocked
// command came with a paragraph of alternatives. Claude Code runs commands in
// workDir(): without the last line, "create notes.txt" ran `touch notes.txt`
// there (verified 2026-10-14).
const APPROVE_PROMPT = [
  "When a shell command is refused without the user being asked, say in one short sentence what it would do; the user can tell you to go ahead. Do not suggest workarounds or other commands.",
  `Your shell starts in a private folder the user never sees. For the user's files and anything they should find later, use absolute paths; when no folder is named, use their home folder (${homedir()}).`,
].join(" ");

type ClaudeOptions = Omit<RunOptions, "prompt">;

function claudeArgs(opts: ClaudeOptions): string[] {
  const args = [
    "-p",
    "--model",
    opts.model ?? currentModel(),
    // A chat assistant, not a coding agent: tools (unless asked for), MCP,
    // settings files and slash commands are off. Time to answer drops from
    // ~9 s to ~3 s (measured 2026-10-11). --bare is faster but ignores OAuth
    // logins.
    ...toolArgs(opts),
    ...INPUT_ARGS,
    ...(opts.tools ? [...PERMISSION_ARGS, ...HOST_PROMPT_ARGS] : []),
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
  return args;
}

function spawnClaude(bin: string, args: string[]) {
  return spawn(bin, args, {
    cwd: workDir(),
    env: childEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// A process started ahead of the question (Chat opening, after each answer)
// does Claude Code's startup while the user types: the first text came 0.7 s
// after the prompt instead of ~8-9 s (Windows, measured 2026-10-14). One per
// command; it is used if the request's arguments match exactly, else
// replaced. It sits idle on stdin until then (no API calls).
let spare: { key: string; child: ReturnType<typeof spawnClaude> } | undefined;

export function prewarmClaude(opts: ClaudeOptions) {
  const bin = resolveClaudeBinary();
  if (!bin) return;
  const args = claudeArgs(opts);
  const key = JSON.stringify([bin, args]);
  if (spare?.key === key) return;
  discardSpareClaude();
  const entry = { key, child: spawnClaude(bin, args) };
  spare = entry;
  const forget = () => {
    if (spare === entry) spare = undefined;
  };
  entry.child.stdin.on("error", () => {});
  entry.child.on("error", forget);
  entry.child.on("close", forget);
}

export function discardSpareClaude() {
  const s = spare;
  spare = undefined;
  s?.child.kill();
}

function takeSpare(key: string) {
  if (spare?.key !== key) return undefined;
  const { child } = spare;
  spare = undefined;
  return child;
}

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
  const args = claudeArgs(opts);

  return new Promise((resolve) => {
    const child =
      takeSpare(JSON.stringify([bin, args])) ?? spawnClaude(bin, args);
    // Prompt via stdin avoids argv length/escaping issues.
    child.stdin.write(
      `${JSON.stringify({ type: "user", message: { role: "user", content: opts.prompt } })}\n`,
    );

    // Commands the user declined mid-turn; not listed again afterwards.
    const declined = new Set<string>();
    const declinedIds = new Set<string>();
    // Shell steps by tool call id, shown once they have run: until then they
    // may be waiting for approval.
    const shellSteps = new Map<string, string>();
    let closed = false;
    const answer = (line: string) => {
      if (!closed) child.stdin.write(line);
    };
    // The CLI may exit before reading an answer.
    child.stdin.on("error", () => {});
    let text = "";
    let resultText: string | undefined;
    let resultIsError = false;
    let durationMs: number | undefined;
    let rateLimit: RateLimit | undefined;
    let denied: DeniedCommand[] = [];
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

    // A shell command waits for the user (onPermission); anything else that
    // asks (e.g. reading outside the allowed folders) is refused.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onControlRequest = async (event: Record<string, any>) => {
      const request = event.request;
      if (request?.subtype !== "can_use_tool") {
        answer(
          `${JSON.stringify({
            type: "control_response",
            response: {
              subtype: "error",
              request_id: event.request_id,
              error: `Unsupported request: ${request?.subtype}`,
            },
          })}\n`,
        );
        return;
      }
      const command = request.input?.command;
      const isShell = Object.hasOwn(SHELL_TOOLS, request.tool_name);
      if (
        !isShell ||
        !opts.onPermission ||
        typeof command !== "string" ||
        !command.trim()
      ) {
        answer(
          controlResponse(event.request_id, {
            behavior: "deny",
            message: "Not allowed in this assistant.",
          }),
        );
        return;
      }
      const id: string = request.tool_use_id ?? event.request_id;
      const reply = await opts.onPermission({
        id,
        command,
        shell: SHELL_TOOLS[request.tool_name],
        description: request.input?.description,
      });
      if (reply.allow) {
        answer(
          controlResponse(event.request_id, {
            behavior: "allow",
            updatedInput: request.input,
          }),
        );
      } else {
        declined.add(command);
        declinedIds.add(id);
        answer(
          controlResponse(event.request_id, {
            behavior: "deny",
            message: reply.note
              ? declinedWithNote(reply.note)
              : DECLINED_MESSAGE,
          }),
        );
      }
    };

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
          if (!step) continue;
          if (Object.hasOwn(SHELL_TOOLS, block.name)) {
            shellSteps.set(block.id, step);
          } else {
            steps.set(block.id, step);
          }
        }
        if (steps.size) opts.onSteps?.([...steps.values()]);
      } else if (event.type === "user") {
        // Tool results: a shell command has now run, or was refused. A refusal
        // (the user's or auto mode's) carries decision "reject" in
        // tool_result_meta; a command that ran and failed carries "accept"
        // (Claude Code 2.1.299).
        const rejected = new Set(
          (Array.isArray(event.tool_result_meta) ? event.tool_result_meta : [])
            .filter((m) => m?.permission_decision?.decision === "reject")
            .map((m) => m.id),
        );
        for (const block of event.message?.content ?? []) {
          const step = shellSteps.get(block?.tool_use_id);
          if (block?.type !== "tool_result" || !step) continue;
          shellSteps.delete(block.tool_use_id);
          if (
            !declinedIds.has(block.tool_use_id) &&
            !rejected.has(block.tool_use_id)
          ) {
            steps.set(block.tool_use_id, step);
          }
        }
        if (steps.size) opts.onSteps?.([...steps.values()]);
      } else if (event.type === "control_request") {
        onControlRequest(event);
      } else if (event.type === "rate_limit_event") {
        rateLimit = parseRateLimit(event.rate_limit_info) ?? rateLimit;
      } else if (event.type === "result") {
        child.stdin.end();
        resultText =
          typeof event.result === "string" ? event.result : undefined;
        resultIsError = Boolean(event.is_error) || event.subtype !== "success";
        durationMs = event.duration_ms;
        // Refusals that never reached the user (e.g. auto mode's own) are
        // listed after the answer; ones the user declined are not.
        denied = deniedCommands(event.permission_denials).filter(
          (d) => !declined.has(d.command),
        );
        // Denied commands didn't run.
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
      closed = true;
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
        denied: denied.length ? denied : undefined,
      });
    });
  });
}

// Shell commands in permission_denials, once each, with the shell they were
// written for.
function deniedCommands(denials: unknown): DeniedCommand[] {
  if (!Array.isArray(denials)) return [];
  const byCommand = new Map<string, Shell>();
  for (const d of denials) {
    const command = d?.tool_input?.command;
    if (!Object.hasOwn(SHELL_TOOLS, d?.tool_name)) continue;
    if (typeof command !== "string" || !command.trim()) continue;
    if (!byCommand.has(command))
      byCommand.set(command, SHELL_TOOLS[d.tool_name]);
  }
  return [...byCommand].map(([command, shell]) => ({ command, shell }));
}
