import {
  Clipboard,
  closeMainWindow,
  showHUD,
  showToast,
  Toast,
} from "@raycast/api";
import { defaultOptions } from "./options";
import { runModel } from "./run";
import { RunResult } from "./types";
import { errorMarkdown } from "./format";
import { REWRITE_SYSTEM_PROMPT } from "./prompts";
import { readSourceText } from "./selection";

// Transforms the selected text and pastes the result over the selection, like
// Raycast AI's "Fix Spelling". No clipboard fallback, so nothing is pasted in
// the wrong place.
export async function rewriteSelection(
  transform: (text: string, toast: Toast) => Promise<RunResult>,
  doneMessage: string,
) {
  const source = await readSourceText({ allowClipboard: false });
  if (!source) {
    await showHUD("Select some text first");
    return;
  }
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: "Writing…",
  });
  const result = await transform(source.text, toast);
  if (result.isError || !result.text.trim()) {
    toast.style = Toast.Style.Failure;
    toast.title = "Request failed";
    toast.message = result.error
      ? errorMarkdown(result.error).replace(/[#`]/g, "").trim()
      : "Empty response";
    return;
  }
  await closeMainWindow();
  await Clipboard.paste(result.text.trim());
  await showHUD(doneMessage);
}

export function rewriteWith(buildPrompt: (text: string) => string) {
  return (text: string) =>
    runModel({
      prompt: buildPrompt(text),
      systemPrompt: REWRITE_SYSTEM_PROMPT,
      effort: defaultOptions().effort,
    });
}
