import { discardSpareClaude, prewarmClaude, runClaude } from "./claude";
import { runCodex } from "./codex";
import { currentModel } from "./models";
import { providerOf } from "./provider";
import { RunOptions, RunResult } from "./types";

// Sends the request to the CLI that owns the model.
export function runModel(opts: RunOptions): Promise<RunResult> {
  const model = opts.model ?? currentModel();
  return providerOf(model) === "codex"
    ? runCodex({ ...opts, model })
    : runClaude({ ...opts, model });
}

// Starts the CLI for the next request ahead of time, with the same options
// it will be sent with (Claude only for now; see prewarmClaude).
export function prewarmModel(opts: Omit<RunOptions, "prompt">) {
  const model = opts.model ?? currentModel();
  if (providerOf(model) === "codex") discardSpareClaude();
  else prewarmClaude({ ...opts, model });
}

export const discardPrewarmed = discardSpareClaude;
