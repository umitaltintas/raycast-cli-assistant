import { environment, getPreferenceValues } from "@raycast/api";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_DEFAULT, CODEX_PREFIX, Provider, providerOf } from "./provider";

export interface ModelOption {
  title: string;
  value: string;
  description?: string;
  // Full model id an alias (opus, haiku) currently resolves to.
  resolvedModel?: string;
}

export interface ModelCatalog {
  fetchedAt: number;
  models: ModelOption[];
}

// Used when no list could be fetched yet. Aliases on purpose: the CLI resolves
// them to the newest version automatically.
export const FALLBACK_MODELS: ModelOption[] = [
  { title: "Haiku", value: "haiku" },
  { title: "Sonnet", value: "sonnet" },
  { title: "Opus", value: "opus" },
  { title: "Fable", value: "fable" },
  { title: "Codex (default model)", value: CODEX_DEFAULT },
];

function supportFile(name: string): string {
  mkdirSync(environment.supportPath, { recursive: true });
  return join(environment.supportPath, name);
}

// The last chosen model is shared by all commands and persists. Stored in a
// small file because LocalStorage is async and this is read synchronously.
export function currentModel(): string {
  try {
    const saved = readFileSync(supportFile("current-model"), "utf8").trim();
    if (saved) return saved;
  } catch {
    // nothing chosen yet
  }
  return getPreferenceValues<Preferences>().model || "haiku";
}

export function setCurrentModel(model: string): void {
  writeFileSync(supportFile("current-model"), model);
}

export function loadCatalog(): ModelCatalog | undefined {
  try {
    return JSON.parse(readFileSync(supportFile("models.json"), "utf8"));
  } catch {
    return undefined;
  }
}

export function saveCatalog(catalog: ModelCatalog): void {
  writeFileSync(supportFile("models.json"), JSON.stringify(catalog));
}

// "opus" and "claude-opus-5-5" can be the same model; both count as selected.
export function sameModel(a: string, b: string): boolean {
  if (a === b) return true;
  const models = loadCatalog()?.models ?? [];
  const resolve = (v: string) =>
    models.find((m) => m.value === v)?.resolvedModel ?? v;
  return resolve(a) === resolve(b);
}

export function modelLabel(model: string): string {
  const known = loadCatalog()?.models.find((m) => m.value === model);
  if (known) return known.title;
  if (model === CODEX_DEFAULT) return "Codex (default model)";
  if (providerOf(model) === "codex") return model.slice(CODEX_PREFIX.length);
  const m = model.match(/^claude-([a-z]+)-(\d+)-(\d+)(\[1m\])?$/i);
  if (!m) return model;
  const name = `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
  return m[4] ? `${name} (1M)` : name;
}

// Models hidden from the menus (Hide Model), by value. A file for the same
// reason as current-model: menus are built synchronously.
export function hiddenModels(): string[] {
  try {
    const saved = JSON.parse(
      readFileSync(supportFile("hidden-models.json"), "utf8"),
    );
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

export function setModelHidden(model: string, hidden: boolean): void {
  const rest = hiddenModels().filter((m) => m !== model);
  writeFileSync(
    supportFile("hidden-models.json"),
    JSON.stringify(hidden ? [...rest, model] : rest),
  );
}

// What the menus offer: every model except hidden ones. The current model
// always stays, so the menu can show what is selected.
export function availableModels(): ModelOption[] {
  const hidden = hiddenModels();
  const current = currentModel();
  return allModels().filter(
    (m) => !hidden.includes(m.value) || sameModel(m.value, current),
  );
}

// CLI list (or fallback) + Extra Models preference + the current model if missing.
export function allModels(): ModelOption[] {
  const list = [...(loadCatalog()?.models ?? FALLBACK_MODELS)];
  const custom = (getPreferenceValues<Preferences>().customModels ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const value of [...custom, currentModel()]) {
    if (!list.some((m) => sameModel(m.value, value))) {
      list.push({ title: modelLabel(value), value });
    }
  }
  return list;
}

// The list entry matching the current model, so dropdowns show it as selected.
export function matchingValue(model: string, list: ModelOption[]): string {
  return list.find((m) => sameModel(m.value, model))?.value ?? model;
}

// Splits a model list into provider sections for menus, Claude first.
export function groupByProvider(
  models: ModelOption[],
): { provider: Provider; models: ModelOption[] }[] {
  return (["claude", "codex"] as Provider[])
    .map((provider) => ({
      provider,
      models: models.filter((m) => providerOf(m.value) === provider),
    }))
    .filter((g) => g.models.length > 0);
}
