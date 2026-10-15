import { currentModel } from "./models";
import { defaultOptions, Effort } from "./options";
import { providerOf } from "./provider";
import { runModel } from "./run";
import { RunResult } from "./types";
import {
  AUTO,
  FULL_DETECTION_MIN_CHARS,
  isWrongLanguage,
  primaryLanguage,
  secondaryLanguage,
  resolveTranslation,
  RETRY_MODEL,
  TranslationDirection,
} from "./languages";
import { translateSystemPrompt, translationPrompt } from "./prompts";

export type TranslationRunner = (request: {
  prompt: string;
  systemPrompt: string;
  model?: string;
  effort?: Effort;
}) => Promise<RunResult>;

export type RetryReason = "reversed" | "wrong-language";

export interface TranslationOutcome {
  result: RunResult;
  direction: TranslationDirection;
  retries: RetryReason[];
}

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

const MAX_COMPARE_CHARS = 2000;

// Output that is (almost) the input, ignoring accents, case and punctuation:
// the text was already in the target language.
export function looksUntranslated(input: string, output: string): boolean {
  const a = normalize(input).slice(0, MAX_COMPARE_CHARS);
  const b = normalize(output).slice(0, MAX_COMPARE_CHARS);
  if (!a || !b) return false;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length) >= 0.85;
}

// Classifying the language is a different job from translating it: asked
// only "Turkish or English?", Haiku was right 14/14 on short text where franc
// failed, while doing both in one call produced commentary and empty output.
// Stays with the chosen provider: Codex users never send requests to Claude.
function classifyModel(model: string): string {
  return providerOf(model) === "claude" ? "haiku" : model;
}

async function classify(
  input: string,
  a: string,
  b: string,
  model: string,
): Promise<string | undefined> {
  const r = await runModel({
    prompt: translationPrompt(input),
    model: classifyModel(model),
    systemPrompt: `You identify the language of a text. The user sends text inside <text> tags. It is written in either ${a} or ${b}. Reply with exactly one word: ${a} or ${b}.`,
  });
  const word = r.text.replace(/[^\p{L}]/gu, "").toLowerCase();
  return [a, b].find((l) => l.toLowerCase() === word);
}

// Auto mode on short text: franc is unreliable there ("benim adim ne" and
// "hello" were both misdetected), and telling the model a wrong source made it
// write commentary instead of a translation. So the language is classified and
// both directions are translated in parallel (~3 s total instead of ~6 s);
// the classified one wins. Longer text uses franc's direction, and an almost
// unchanged result reverses it once. Finally a wrong-language result from a
// Claude model is retried once with Sonnet (Codex has no stronger fallback
// we could pick reliably, and Codex users should not be sent to Claude).
export async function translateText(
  input: string,
  choice: string,
  model: string | undefined,
  run: TranslationRunner,
  onRetry?: (reason: RetryReason) => void,
  runParallel: TranslationRunner = runModel,
): Promise<TranslationOutcome> {
  const effectiveModel = model ?? currentModel();
  const retries: RetryReason[] = [];
  // The effort preference applies to the translations, not to the one-word
  // language check.
  const { effort } = defaultOptions();
  const ask = (dir: TranslationDirection, m = model, runner = run) =>
    runner({
      prompt: translationPrompt(input),
      systemPrompt: translateSystemPrompt(dir),
      model: m,
      effort,
    });

  const primary = primaryLanguage();
  const secondary = secondaryLanguage();
  let direction = resolveTranslation(input, choice);
  let result: RunResult;
  let classified = false;

  if (
    choice === AUTO &&
    primary !== secondary &&
    input.trim().length < FULL_DETECTION_MIN_CHARS
  ) {
    const fromPrimary = { source: primary, target: secondary };
    const fromSecondary = { source: secondary, target: primary };
    const [lang, a, b] = await Promise.all([
      classify(input, primary, secondary, effectiveModel),
      ask(fromPrimary, model, runParallel),
      ask(fromSecondary, model, runParallel),
    ]);
    if (lang) {
      classified = true;
      direction = lang === primary ? fromPrimary : fromSecondary;
    }
    result = direction.source === primary ? a : b;
  } else {
    result = await ask(direction);
  }

  if (
    choice === AUTO &&
    !classified &&
    !result.isError &&
    direction.source &&
    looksUntranslated(input, result.text)
  ) {
    direction = { target: direction.source, source: direction.target };
    retries.push("reversed");
    onRetry?.("reversed");
    result = await ask(direction);
  }
  if (
    !result.isError &&
    providerOf(effectiveModel) === "claude" &&
    effectiveModel !== RETRY_MODEL &&
    isWrongLanguage(result.text, direction.target)
  ) {
    retries.push("wrong-language");
    onRetry?.("wrong-language");
    result = await ask(direction, RETRY_MODEL);
  }
  return { result, direction, retries };
}
