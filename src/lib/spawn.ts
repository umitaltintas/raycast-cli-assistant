import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { Worker } from "node:worker_threads";
import { IS_WINDOWS } from "./platform";

// On Windows, creating a process blocks the calling thread until the
// security software has looked at it: ~2 s for claude.exe on a managed laptop
// (measured 2026-10-14), ~9 s seen inside Raycast. Node's spawn() is
// synchronous there, so the extension froze; Raycast queued the keystrokes,
// a queued Enter aborted the request ("Stopped.") and Raycast finally
// unloaded the frozen command. So on Windows the process is started from a
// worker thread and its pipes are relayed. kill() ends the whole process
// tree: TerminateProcess alone would leave the CLI's own children running.

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { spawn, execFile } = require("node:child_process");
(() => {
  const { bin, args, options } = workerData;
  const post = (m) => parentPort.postMessage(m);
  let child;
  try {
    child = spawn(bin, args, options);
  } catch (e) {
    post({ type: "error", message: String((e && e.message) || e), code: e && e.code });
    return;
  }
  post({ type: "spawn", pid: child.pid });
  child.on("error", (e) => post({ type: "error", message: e.message, code: e.code }));
  if (child.stdout) child.stdout.on("data", (d) => post({ type: "stdout", data: d }));
  if (child.stderr) child.stderr.on("data", (d) => post({ type: "stderr", data: d }));
  // The CLI may exit before reading all of its input.
  if (child.stdin) child.stdin.on("error", () => {});
  child.on("close", (code, signal) => post({ type: "close", code, signal }));
  parentPort.on("message", (m) => {
    if (m.type === "stdin" && child.stdin) child.stdin.write(Buffer.from(m.data));
    else if (m.type === "end" && child.stdin) child.stdin.end();
    else if (m.type === "kill") {
      if (child.pid) {
        execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      } else {
        child.kill();
      }
    }
  });
})();
`;

type Pipe = "pipe" | "ignore";

// Only what this extension uses: "pipe"/"ignore" stdio, cwd and env.
class ThreadedChild extends EventEmitter {
  pid?: number;
  readonly stdin: Writable | null;
  readonly stdout: PassThrough | null;
  readonly stderr: PassThrough | null;
  private readonly worker: Worker;
  private closed = false;

  constructor(
    bin: string,
    args: readonly string[],
    options: childProcess.SpawnOptions,
  ) {
    super();
    const stdio: Pipe[] = Array.isArray(options.stdio)
      ? options.stdio.map((s) => (s === "ignore" ? "ignore" : "pipe"))
      : options.stdio === "ignore"
        ? ["ignore", "ignore", "ignore"]
        : ["pipe", "pipe", "pipe"];
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        bin,
        args,
        options: {
          cwd: options.cwd,
          env: options.env,
          stdio,
          windowsHide: true,
        },
      },
    });
    this.stdout = stdio[1] === "pipe" ? new PassThrough() : null;
    this.stderr = stdio[2] === "pipe" ? new PassThrough() : null;
    this.stdin =
      stdio[0] === "pipe"
        ? new Writable({
            write: (chunk, _encoding, done) => {
              this.send({ type: "stdin", data: chunk });
              done();
            },
            final: (done) => {
              this.send({ type: "end" });
              done();
            },
          })
        : null;

    this.worker.on("message", (m) => {
      if (m.type === "spawn") this.pid = m.pid;
      else if (m.type === "stdout") this.stdout?.write(Buffer.from(m.data));
      else if (m.type === "stderr") this.stderr?.write(Buffer.from(m.data));
      else if (m.type === "error") {
        this.emit(
          "error",
          Object.assign(new Error(m.message), { code: m.code }),
        );
      } else if (m.type === "close") this.finish(m.code, m.signal);
    });
    this.worker.on("error", (e) => {
      this.emit("error", e);
      this.finish(null, null);
    });
    this.worker.on("exit", () => this.finish(null, null));
  }

  kill(): boolean {
    this.send({ type: "kill" });
    return true;
  }

  private send(message: { type: string; data?: unknown }) {
    if (!this.closed) this.worker.postMessage(message);
  }

  // Like a real child process: "close" comes after the output was read.
  private finish(code: number | null, signal: string | null) {
    if (this.closed) return;
    this.closed = true;
    const streams = [this.stdout, this.stderr].filter(
      (s): s is PassThrough => s !== null,
    );
    let pending = streams.length;
    const done = () => {
      if (--pending > 0) return;
      this.emit("close", code, signal);
      this.worker.terminate();
    };
    if (!pending) {
      pending = 1;
      done();
      return;
    }
    for (const s of streams) {
      s.once("end", done);
      // Nobody reading it: drain, or "end" never comes.
      if (!s.readableFlowing) s.resume();
      s.end();
    }
  }
}

function threadedSpawn(
  bin: string,
  args: readonly string[],
  options: childProcess.SpawnOptions = {},
): childProcess.ChildProcess {
  try {
    return new ThreadedChild(
      bin,
      args,
      options,
    ) as unknown as childProcess.ChildProcess;
  } catch {
    // Worker threads unavailable: block, but work.
    return childProcess.spawn(bin, args, options);
  }
}

export const spawn = (
  IS_WINDOWS ? threadedSpawn : childProcess.spawn
) as typeof childProcess.spawn;
