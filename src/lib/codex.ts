import { environment, getPreferenceValues } from "@raycast/api";
import { spawn } from "./spawn";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { findBinary, IS_WINDOWS } from "./platform";
import { CODEX_PREFIX, codexModelId } from "./provider";
import { codexCommandStep, codexWebStep } from "./steps";
import { ModelError, RunOptions, RunResult, systemPrompt } from "./types";

// npm on Windows installs a codex.cmd shim; the native codex.exe it starts
// lives in a per-platform package (0.162: @openai/codex-win32-x64, nested
// under @openai/codex for global installs).
function windowsCandidates(): string[] {
  const [pkg, triple] =
    process.arch === "arm64"
      ? ["win32-arm64", "aarch64-pc-windows-msvc"]
      : ["win32-x64", "x86_64-pc-windows-msvc"];
  const npm = join(
    process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
    "npm",
    "node_modules",
    "@openai",
  );
  const exe = join("vendor", triple, "bin", "codex.exe");
  return [
    join(homedir(), ".local", "bin", "codex.exe"),
    join(npm, "codex", "node_modules", "@openai", `codex-${pkg}`, exe),
    join(npm, `codex-${pkg}`, exe),
    join(npm, "codex", "vendor", triple, "codex", "codex.exe"),
  ];
}

// Codex ships inside the ChatGPT app, so that is checked too.
export function resolveCodexBinary(): string | undefined {
  return findBinary(
    getPreferenceValues<Preferences>().codexPath,
    IS_WINDOWS
      ? windowsCandidates()
      : [
          "/opt/homebrew/bin/codex",
          "/usr/local/bin/codex",
          join(homedir(), ".local/bin/codex"),
          join(homedir(), ".npm-global/bin/codex"),
          join(homedir(), ".bun/bin/codex"),
          "/Applications/ChatGPT.app/Contents/Resources/codex",
          "/Applications/Codex.app/Contents/Resources/codex",
        ],
    "codex",
  );
}

function codexEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const { username } = userInfo();
  env.USER ??= username;
  env.LOGNAME ??= username;
  // An API key in the environment would take precedence over the ChatGPT login.
  delete env.OPENAI_API_KEY;
  return env;
}

function workDir(): string {
  const dir = join(environment.supportPath, "codex");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Codex assigns its own thread ids, so our session ids are mapped to them.
function threadsFile(): string {
  return join(workDir(), "threads.json");
}

function loadThreads(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(threadsFile(), "utf8"));
  } catch {
    return {};
  }
}

function saveThread(sessionId: string, threadId: string) {
  writeFileSync(
    threadsFile(),
    JSON.stringify({ ...loadThreads(), [sessionId]: threadId }),
  );
}

export function hasCodexThread(sessionId: string): boolean {
  return Boolean(loadThreads()[sessionId]);
}

// Error messages can be a JSON document from the API wrapped in a string.
function readableMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error?.message ?? parsed?.message ?? raw;
  } catch {
    return raw;
  }
}

function classify(message: string): ModelError {
  if (/401|unauthori[sz]ed|not logged in|login|auth/i.test(message)) {
    return { kind: "not-logged-in", message, provider: "codex" };
  }
  if (/usage limit|rate.?limit|429|quota/i.test(message)) {
    return { kind: "usage-limit", message, provider: "codex" };
  }
  return { kind: "other", message, provider: "codex" };
}

// Codex adds ~13k tokens of coding-agent context to every request (skills
// list, sandbox rules, tool descriptions). None of it is needed here; turning
// it off brought a "Say hi" from ~17.6k to ~4.5k input tokens (2026-10-11).
// Written as -c keys rather than --disable: an unknown --disable feature
// aborts the run, an unknown -c key is ignored, so older/newer versions work.
// view_image goes with Tools (see optionArgs).
const TRIMMED_FEATURES = [
  "apps",
  "plugins",
  "multi_agent",
  "image_generation",
  "goals",
  "tool_suggest",
  "skill_search",
  "sleep_tool",
  "browser_use",
  "computer_use",
];
const TRIM_ARGS = [
  "skills.include_instructions=false",
  "include_permissions_instructions=false",
  "include_apps_instructions=false",
  "include_collaboration_mode_instructions=false",
  "include_environment_context=false",
  "tools.update_plan.enabled=false",
  ...TRIMMED_FEATURES.map((f) => `features.${f}=false`),
].flatMap((kv) => ["-c", kv]);

// Tools: the shell, which Codex also reads files through (the read-only
// sandbox blocks writes), and view_image for images, as Claude has Read.
// Without the shell, ~640 fewer input tokens.
function optionArgs(opts: RunOptions): string[] {
  return [
    `web_search=${opts.webSearch ? '"live"' : '"disabled"'}`,
    ...(opts.tools
      ? []
      : [
          "features.shell_tool=false",
          "features.unified_exec=false",
          "features.view_image=false",
        ]),
    ...(opts.effort ? [`model_reasoning_effort="${opts.effort}"`] : []),
  ].flatMap((kv) => ["-c", kv]);
}

// Commands the sandbox would block come back in this block (see below), so
// they can be approved like Claude's denied Bash calls.
const APPROVE_PROMPT = [
  "Shell commands you run are in a read-only sandbox.",
  "If the task needs a command that changes something (writes or deletes files, installs, stops processes), do not try it.",
  "Instead end your reply with a fenced code block tagged `approve` that holds only that one command.",
  ...(IS_WINDOWS ? ["Write it for PowerShell; that is where it runs."] : []),
  "The user can approve it; you then get its output.",
].join(" ");

const APPROVE_BLOCK = /\n*```approve\n([\s\S]*?)\n?```\s*/g;

function splitCommands(text: string): { text: string; commands: string[] } {
  const commands = [...text.matchAll(APPROVE_BLOCK)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  return { text: text.replace(APPROVE_BLOCK, "\n").trim(), commands };
}

const COMMON_ARGS = [
  "--json",
  "--skip-git-repo-check",
  "--ignore-user-config",
  "--ignore-rules",
  ...TRIM_ARGS,
];

// The system prompt replaces Codex's base instructions; the setting takes a
// file, one per distinct prompt.
function instructionsArgs(prompt: string): string[] {
  const hash = createHash("sha1").update(prompt).digest("hex").slice(0, 12);
  const file = join(workDir(), `instructions-${hash}.md`);
  if (!existsSync(file)) writeFileSync(file, prompt);
  return ["-c", `model_instructions_file=${JSON.stringify(file)}`];
}

// `codex exec --json` reports a finished message, not text deltas, so the
// answer arrives in one piece (measured 2026-10-11: ~4.5 s with GPT-5.6-Luna).
export function runCodex(opts: RunOptions): Promise<RunResult> {
  const bin = resolveCodexBinary();
  if (!bin) {
    return Promise.resolve({
      text: "",
      isError: true,
      error: {
        kind: "not-installed",
        message: "Codex CLI not found.",
        provider: "codex",
      },
    });
  }

  const model = codexModelId(opts.model ?? CODEX_PREFIX);
  const thread = opts.sessionId ? loadThreads()[opts.sessionId] : undefined;
  const prompt = opts.systemPrompt ?? systemPrompt();
  const instructions = [
    ...instructionsArgs(opts.tools ? `${prompt}\n\n${APPROVE_PROMPT}` : prompt),
    ...optionArgs(opts),
  ];
  const args = thread
    ? ["exec", "resume", thread, ...COMMON_ARGS, ...instructions]
    : [
        "exec",
        ...COMMON_ARGS,
        "-s",
        "read-only",
        ...instructions,
        ...(opts.sessionId ? [] : ["--ephemeral"]),
      ];
  if (model) args.push("-m", model);
  // Relative paths and "this folder" then mean the Finder/Explorer selection.
  if (opts.readDirs?.length) args.push("-C", opts.readDirs[0]);
  args.push("-"); // prompt from stdin

  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(bin, args, {
      cwd: workDir(),
      env: codexEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(opts.prompt);

    let text = "";
    let failure: string | undefined;
    let stderr = "";
    let cancelled = false;
    const steps = new Map<string, string>();
    const setStep = (id: string, step: string) => {
      steps.set(id, step);
      opts.onSteps?.([...steps.values()]);
    };

    const onAbort = () => {
      cancelled = true;
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
      const item = event.item;
      if (
        event.type === "item.started" &&
        item?.type === "command_execution" &&
        item.command
      ) {
        setStep(item.id, codexCommandStep(item.command));
      } else if (
        (event.type === "item.started" || event.type === "item.completed") &&
        item?.type === "web_search"
      ) {
        setStep(item.id, codexWebStep(item));
      }
      if (event.type === "thread.started" && opts.sessionId && !thread) {
        saveThread(opts.sessionId, event.thread_id);
      } else if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message"
      ) {
        text = text ? `${text}\n\n${event.item.text}` : event.item.text;
        opts.onText?.(opts.tools ? splitCommands(text).text : text);
      } else if (event.type === "turn.failed") {
        failure = readableMessage(
          event.error?.message ?? "Codex request failed.",
        );
      } else if (event.type === "error" && !failure) {
        failure = readableMessage(event.message ?? "Codex request failed.");
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("error", (err) => {
      resolve({
        text,
        isError: true,
        error: { kind: "other", message: err.message, provider: "codex" },
      });
    });

    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      const durationMs = Date.now() - started;
      if (cancelled) {
        resolve({
          text,
          isError: true,
          error: { kind: "cancelled", message: "Stopped.", provider: "codex" },
        });
        return;
      }
      if (failure || (code !== 0 && !text)) {
        const message = (
          failure ||
          stderr.split("\n").filter(Boolean).pop() ||
          `codex exited with code ${code}`
        ).trim();
        resolve({
          text,
          isError: true,
          error: classify(message),
          durationMs,
          steps: steps.size ? [...steps.values()] : undefined,
        });
        return;
      }
      if (!opts.tools) {
        resolve({
          text,
          isError: false,
          durationMs,
          steps: steps.size ? [...steps.values()] : undefined,
        });
        return;
      }
      const split = splitCommands(text);
      resolve({
        text: split.text,
        isError: false,
        durationMs,
        steps: steps.size ? [...steps.values()] : undefined,
        commands: split.commands.length ? split.commands : undefined,
      });
    });
  });
}

export interface CodexModel {
  value: string;
  title: string;
  description?: string;
}

// `codex debug models` prints the model catalog for the signed-in account.
export function fetchCodexModels(): Promise<CodexModel[]> {
  const bin = resolveCodexBinary();
  if (!bin) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["debug", "models"], {
      cwd: workDir(),
      env: codexEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.on("data", (c) => (out += c.toString()));
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const models: {
          slug?: string;
          display_name?: string;
          description?: string;
          visibility?: string;
        }[] = JSON.parse(out).models ?? [];
        resolve(
          models
            .filter((m) => m.slug && m.visibility === "list")
            .map((m) => ({
              value: `${CODEX_PREFIX}${m.slug}`,
              title: m.display_name || m.slug!,
              description: m.description,
            })),
        );
      } catch {
        reject(new Error("Could not read the Codex model list."));
      }
    });
  });
}
