#!/usr/bin/env node
// Stands in for the claude and codex CLIs in tests: logs its arguments and
// what it reads on stdin to $CLI_TEST_LOG, then plays the scenario named by
// a keyword in the prompt. The output follows what the real CLIs print
// (Claude Code 2.1.300 stream-json, codex 0.153 exec --json).
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const log = (record) =>
  appendFileSync(process.env.CLI_TEST_LOG, `${JSON.stringify(record)}\n`);
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const isCodex = args[0] === "exec";
log({ cli: isCodex ? "codex" : "claude", args });

if (isCodex) runCodex();
else runClaude();

async function runCodex() {
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  log({ stdin: prompt });
  if (prompt.includes("hang")) return hang();
  if (prompt.includes("crash")) {
    process.stderr.write("Error: not logged in\n");
    process.exit(1);
  }
  out({ type: "thread.started", thread_id: "thread-1" });
  out({ type: "turn.started" });
  if (prompt.includes("shell")) {
    const item = {
      id: "c1",
      type: "command_execution",
      command: `/bin/zsh -lc 'ls '\\''My Files'\\'''`,
    };
    out({ type: "item.started", item });
    out({ type: "item.completed", item: { ...item, exit_code: 0 } });
  }
  const text = prompt.includes("approve")
    ? "I need to create it.\n\n```approve\ntouch ~/notes.txt\n```"
    : "Hello from Codex";
  out({
    type: "item.completed",
    item: { id: "m1", type: "agent_message", text },
  });
  out({ type: "turn.completed", usage: {} });
}

function runClaude() {
  const input = createInterface({ input: process.stdin });
  const pending = new Map();
  let started = false;
  input.on("line", (line) => {
    const msg = JSON.parse(line);
    log({ stdin: msg });
    if (msg.type === "control_response") {
      pending.get(msg.response.request_id)?.(msg.response.response);
    } else if (msg.type === "user" && !started) {
      started = true;
      play(msg.message.content, pending).then(() => {});
    }
  });
}

const text = (s) => [
  { type: "stream_event", event: { type: "message_start" } },
  ...[...s].map((c) => ({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: c },
    },
  })),
];

function result(s, extra = {}) {
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: s,
    duration_ms: 1234,
    permission_denials: [],
    ...extra,
  });
}

function ask(pending, id, input) {
  return new Promise((resolve) => {
    pending.set(id, resolve);
    out({
      type: "control_request",
      request_id: id,
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        tool_use_id: `tool-${id}`,
        input,
      },
    });
  });
}

async function play(prompt, pending) {
  if (prompt.includes("hang")) return hang();
  if (prompt.includes("crash")) {
    process.stderr.write("boom\n");
    process.exit(3);
  }
  if (prompt.includes("expired")) {
    result("Not logged in · Please run /login", {
      is_error: true,
      subtype: "error_during_execution",
    });
    return process.exit(1);
  }
  if (prompt.includes("shell")) {
    const input = { command: "touch ~/notes.txt", description: "Create notes" };
    out({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "tool-r1", name: "Bash", input }],
      },
    });
    const answer = await ask(pending, "r1", input);
    out({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tool-r1" }],
      },
      tool_result_meta: [
        {
          id: "tool-r1",
          permission_decision: {
            decision: answer.behavior === "allow" ? "accept" : "reject",
          },
        },
      ],
    });
    const reply =
      answer.behavior === "allow"
        ? "Created it."
        : `Skipped: ${answer.message}`;
    text(reply).forEach(out);
    result(reply);
    return;
  }
  if (prompt.includes("refused")) {
    const input = { command: "rm -rf ~/old" };
    out({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-d1",
            name: "Read",
            input: { file_path: "/tmp/a.txt" },
          },
          { type: "tool_use", id: "tool-d2", name: "Bash", input },
        ],
      },
    });
    text("It would delete ~/old.").forEach(out);
    result("It would delete ~/old.", {
      permission_denials: [
        { tool_name: "Bash", tool_use_id: "tool-d2", tool_input: input },
      ],
    });
    return;
  }
  text("Hello").forEach(out);
  result("Hello");
}

function hang() {
  process.on("SIGINT", () => {
    log({ signal: "SIGINT" });
    process.exit(130);
  });
  setInterval(() => {}, 1000);
}
