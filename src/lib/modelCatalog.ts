import { spawn } from "./spawn";
import { createInterface } from "node:readline";
import { showToast, Toast } from "@raycast/api";
import { useCallback, useEffect, useState } from "react";
import { childEnv, resolveClaudeBinary, workDir } from "./claude";
import { fetchCodexModels, resolveCodexBinary } from "./codex";
import { Provider, providerOf } from "./provider";
import {
  allModels,
  availableModels,
  hiddenModels,
  loadCatalog,
  ModelCatalog,
  ModelOption,
  saveCatalog,
  setModelHidden,
} from "./models";

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 15_000;

interface CliModel {
  value: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
}

// Claude Code's control protocol (also behind the Agent SDK's
// supportedModels()): an "initialize" request on stream-json input returns the
// models available on the account's plan. No model call, ~1-2 s.
export function fetchCliModels(): Promise<ModelOption[]> {
  const bin = resolveClaudeBinary();
  if (!bin) return Promise.reject(new Error("Claude Code CLI not found."));

  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--no-session-persistence",
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: workDir(),
      env: childEnv(),
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false;
    const finish = (err?: Error, models?: ModelOption[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGINT");
      if (err) reject(err);
      else resolve(models!);
    };
    const timer = setTimeout(
      () => finish(new Error("Timed out fetching the model list.")),
      TIMEOUT_MS,
    );

    createInterface({ input: child.stdout }).on("line", (line) => {
      let event: {
        type?: string;
        response?: { response?: { models?: CliModel[] } };
      };
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type !== "control_response") return;
      const models = event.response?.response?.models;
      if (!Array.isArray(models) || models.length === 0) {
        finish(new Error("The CLI returned no model list."));
        return;
      }
      finish(undefined, normalize(models));
    });
    child.on("error", (e) => finish(e));
    child.on("close", () =>
      finish(new Error("The CLI exited before returning a model list.")),
    );

    // Keep stdin open: closing it can make the CLI exit before replying.
    child.stdin.write(
      JSON.stringify({
        type: "control_request",
        request_id: "models",
        request: { subtype: "initialize" },
      }) + "\n",
    );
  });
}

// "default" is only an alias of another model; among entries resolving to the
// same model the first one (the alias) is kept.
function normalize(models: CliModel[]): ModelOption[] {
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  for (const m of models) {
    if (!m.value || m.value === "default") continue;
    const resolved = m.resolvedModel ?? m.value;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push({
      title: m.displayName || m.value,
      value: m.value,
      description: m.description,
      resolvedModel: resolved,
    });
  }
  return out;
}

// A cache written before a CLI was installed (or before this extension
// supported it) would otherwise hide that CLI's models for up to a day.
function missesInstalledProvider(catalog: ModelCatalog): boolean {
  const has = (p: Provider) =>
    catalog.models.some((m) => providerOf(m.value) === p);
  return (
    (Boolean(resolveClaudeBinary()) && !has("claude")) ||
    (Boolean(resolveCodexBinary()) && !has("codex"))
  );
}

// Both CLIs are asked in parallel; a missing or failing one just contributes
// no models. Claude models come first.
export async function refreshCatalog(
  force = false,
): Promise<ModelCatalog | undefined> {
  const cached = loadCatalog();
  if (
    !force &&
    cached &&
    Date.now() - cached.fetchedAt < MAX_AGE_MS &&
    !missesInstalledProvider(cached)
  )
    return cached;
  const [claude, codex] = await Promise.allSettled([
    resolveClaudeBinary() ? fetchCliModels() : Promise.resolve([]),
    fetchCodexModels(),
  ]);
  if (claude.status === "rejected" && codex.status === "rejected")
    throw claude.reason;
  const models = [
    ...(claude.status === "fulfilled"
      ? claude.value
      : (cached?.models.filter((m) => providerOf(m.value) === "claude") ?? [])),
    ...(codex.status === "fulfilled"
      ? codex.value
      : (cached?.models.filter((m) => providerOf(m.value) === "codex") ?? [])),
  ];
  if (!models.length) throw new Error("No models found.");
  const catalog = { fetchedAt: Date.now(), models };
  saveCatalog(catalog);
  return catalog;
}

// The cached list shows immediately and is refreshed in the background when stale.
// A failed refresh keeps the cached/fallback list; the reason is kept in
// `error` (shown in an empty chat) and, when asked for, in a toast.
export function useModels() {
  const [models, setModels] = useState<ModelOption[]>(availableModels);
  const [isRefreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async (force = false) => {
    setRefreshing(true);
    try {
      await refreshCatalog(force);
      setModels(availableModels());
      setError(undefined);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(`Model list not updated: ${message}`);
      if (force) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Model list not updated",
          message,
        });
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  const setHidden = useCallback((model: string, hidden: boolean) => {
    setModelHidden(model, hidden);
    setModels(availableModels());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    models,
    // For Hide/Show: the full list and what is hidden.
    allModels,
    hidden: hiddenModels,
    isRefreshing,
    error,
    refresh,
    setHidden,
  };
}

export type ModelsState = ReturnType<typeof useModels>;
