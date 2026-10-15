// The runners against a fake claude/codex (tests/fixtures/fake-cli.mjs): the
// arguments each option turns into, streaming, mid-turn approval, refused
// commands, errors and Stop. No network, no real CLI.
import { build } from "esbuild";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "cli-assistant-test-"));
const fake = join(dir, "fake-cli");
copyFileSync("tests/fixtures/fake-cli.mjs", fake);
chmodSync(fake, 0o755);
const logFile = join(dir, "log.jsonl");
const basePrefs = { claudePath: fake, codexPath: fake, model: "haiku" };
const setPrefs = (prefs = {}) =>
  (process.env.CLI_TEST_PREFERENCES = JSON.stringify({
    ...basePrefs,
    ...prefs,
  }));
Object.assign(process.env, {
  CLI_TEST_SUPPORT: join(dir, "support"),
  CLI_TEST_LOG: logFile,
});
setPrefs();

const outfile = join(dir, "runner.cjs");
await build({
  entryPoints: ["tests/fixtures/entry.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "error",
  alias: { "@raycast/api": resolve("tests/fixtures/raycast.mjs") },
});
const lib = (await import(pathToFileURL(outfile))).default;
after(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  writeFileSync(logFile, "");
  setPrefs();
});

const records = () =>
  readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
const argsOf = () => records().find((r) => r.args).args;
const flag = (args, name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const claude = (opts) => lib.runModel({ model: "haiku", ...opts });
const codex = (opts) => lib.runModel({ model: "codex:", ...opts });

test("Claude: plain request has no tools and streams text", async () => {
  const seen = [];
  const r = await claude({ prompt: "hi", onText: (t) => seen.push(t) });
  assert.equal(r.isError, false);
  assert.equal(r.text, "Hello");
  assert.deepEqual(seen.slice(-1), ["Hello"]);
  const args = argsOf();
  assert.equal(flag(args, "--tools"), "");
  assert.ok(!args.includes("--allowedTools"));
  assert.ok(!args.includes("--permission-prompt-tool"));
  assert.ok(args.includes("--no-session-persistence"));
});

test("Claude: options map to flags", async () => {
  await claude({ prompt: "hi", webSearch: true, effort: "high" });
  const args = argsOf();
  assert.equal(flag(args, "--tools"), "WebSearch,WebFetch");
  assert.equal(flag(args, "--allowedTools"), "WebSearch,WebFetch");
  assert.equal(flag(args, "--effort"), "high");
});

test("Claude: Tools asks mid-turn, no auto mode by default", async () => {
  await claude({ prompt: "hi", tools: true });
  const args = argsOf();
  assert.equal(flag(args, "--tools"), "Read,Bash");
  assert.equal(flag(args, "--allowedTools"), "Read");
  assert.equal(flag(args, "--permission-prompt-tool"), "stdio");
  assert.ok(!args.includes("--permission-mode"));
});

test("Claude: auto mode only with the preference", async () => {
  setPrefs({ claudeAutoMode: true });
  await claude({ prompt: "hi", tools: true });
  assert.equal(flag(argsOf(), "--permission-mode"), "auto");
});

test("Claude: a Finder selection is read-only in its folders", async () => {
  await claude({ prompt: "hi", readDirs: ["/tmp/a", "/tmp/b"] });
  const args = argsOf();
  assert.equal(flag(args, "--tools"), "Read,Glob,Grep");
  assert.equal(flag(args, "--allowedTools"), "Read,Glob,Grep");
  const i = args.indexOf("--add-dir");
  assert.deepEqual(args.slice(i + 1, i + 3), ["/tmp/a", "/tmp/b"]);
  // The next flag ends --add-dir's list; the prompt goes in on stdin.
  assert.match(args[i + 3], /^--/);
  assert.ok(!args.includes("Bash"));
});

test("Claude: an approved command runs and the turn goes on", async () => {
  const asked = [];
  const r = await claude({
    prompt: "shell",
    tools: true,
    onPermission: async (req) => {
      asked.push(req);
      return { allow: true };
    },
  });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].command, "touch ~/notes.txt");
  assert.equal(asked[0].shell, "bash");
  assert.equal(asked[0].description, "Create notes");
  assert.equal(r.text, "Created it.");
  assert.deepEqual(r.steps, ["💻 Ran `touch ~/notes.txt`"]);
  const reply = records().find((x) => x.stdin?.type === "control_response");
  assert.equal(reply.stdin.response.response.behavior, "allow");
});

test("Claude: a declined command is not shown as run", async () => {
  const r = await claude({
    prompt: "shell",
    tools: true,
    onPermission: async () => ({ allow: false, note: "use the trash" }),
  });
  assert.match(r.text, /^Skipped: .*use the trash/);
  assert.equal(r.steps, undefined);
  assert.ok(!r.denied?.length);
});

test("Claude: a command refused without asking is only listed", async () => {
  const r = await claude({ prompt: "refused", tools: true });
  assert.deepEqual(r.steps, ["📄 Read /tmp/a.txt"]);
  assert.deepEqual(
    r.denied?.map((d) => d.command),
    ["rm -rf ~/old"],
  );
});

test("Claude: errors are classified", async () => {
  const expired = await claude({ prompt: "expired" });
  assert.equal(expired.isError, true);
  assert.equal(expired.error.kind, "not-logged-in");
  const crash = await claude({ prompt: "crash" });
  assert.equal(crash.isError, true);
  assert.equal(crash.error.message, "boom");
});

test("Claude: Stop ends the turn with SIGINT", async () => {
  const ac = new AbortController();
  const run = claude({ prompt: "hang", signal: ac.signal });
  setTimeout(() => ac.abort(), 300);
  const r = await run;
  assert.equal(r.error.kind, "cancelled");
  assert.ok(records().some((x) => x.signal === "SIGINT"));
});

test("Codex: options map to config overrides", async () => {
  const r = await codex({ prompt: "hi", webSearch: true, effort: "low" });
  assert.equal(r.text, "Hello from Codex");
  const args = argsOf();
  assert.ok(args.includes('web_search="live"'));
  assert.ok(args.includes('model_reasoning_effort="low"'));
  assert.ok(args.includes("features.shell_tool=false"));
  assert.equal(flag(args, "-s"), "read-only");
  assert.equal(args.at(-1), "-");
});

test("Codex: a Finder selection keeps the shell and runs in the folder", async () => {
  await codex({ prompt: "hi", readDirs: ["/tmp/sel"] });
  const args = argsOf();
  assert.ok(!args.includes("features.shell_tool=false"));
  assert.equal(flag(args, "-C"), "/tmp/sel");
});

test("Codex: commands become steps, approve blocks become commands", async () => {
  const shown = [];
  const r = await codex({
    prompt: "shell approve",
    tools: true,
    onText: (t) => shown.push(t),
  });
  assert.deepEqual(r.steps, ["💻 Ran `ls 'My Files'`"]);
  assert.equal(r.text, "I need to create it.");
  assert.deepEqual(r.commands, ["touch ~/notes.txt"]);
  assert.ok(shown.every((t) => !t.includes("```approve")));
});

test("Codex: sessions resume their thread", async () => {
  await codex({ prompt: "hi", sessionId: "s1" });
  assert.ok(!argsOf().includes("resume"));
  writeFileSync(logFile, "");
  await codex({ prompt: "hi", sessionId: "s1" });
  const args = argsOf();
  assert.deepEqual(args.slice(0, 3), ["exec", "resume", "thread-1"]);
});

test("Codex: errors and Stop", async () => {
  const crash = await codex({ prompt: "crash" });
  assert.equal(crash.error.kind, "not-logged-in");
  const ac = new AbortController();
  const run = codex({ prompt: "hang", signal: ac.signal });
  setTimeout(() => ac.abort(), 300);
  assert.equal((await run).error.kind, "cancelled");
});

test("steps and shell helpers", () => {
  assert.equal(
    lib.codexCommandStep(`/bin/zsh -lc "echo \\"hi\\" \\$HOME"`),
    '💻 Ran `echo "hi" $HOME`',
  );
  assert.equal(lib.stepsMarkdown(["a", "b"]), "> a  \n> b\n\n");
  assert.equal(lib.stepsMarkdown([]), "");
  const prompt = lib.commandResultPrompt("ls", {
    output: "x".repeat(20_010),
    exitCode: 0,
    timedOut: false,
  });
  assert.match(prompt, /exited with code 0/);
  assert.match(prompt, /10 more characters cut/);
  assert.deepEqual(lib.splitCommands("a\n```approve\nrm x\n```"), {
    text: "a",
    commands: ["rm x"],
  });
});

test("hidden models leave the menus, except the current one", () => {
  const values = () => lib.availableModels().map((m) => m.value);
  assert.ok(values().includes("sonnet"));
  lib.setModelHidden("sonnet", true);
  lib.setModelHidden("haiku", true);
  assert.ok(!values().includes("sonnet"));
  // haiku is the current model (preference), so it stays selectable.
  assert.ok(values().includes("haiku"));
  assert.ok(lib.allModels().some((m) => m.value === "sonnet"));
  lib.setModelHidden("sonnet", false);
  lib.setModelHidden("haiku", false);
  assert.deepEqual(lib.hiddenModels(), []);
  assert.ok(values().includes("sonnet"));
});
