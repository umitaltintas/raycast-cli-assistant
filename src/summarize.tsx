import { SelectionAnswer } from "./components/SelectionAnswer";
import { summarizePrompt } from "./lib/prompts";

// A selection of nothing but links means "summarize the page": without web
// search, Claude summarized what a GitHub URL pointed to from memory
// (2026-10-15).
function onlyLinks(text: string): boolean {
  return text
    .trim()
    .split(/\s+/)
    .every((word) => /^https?:\/\/\S+$/i.test(word));
}

export default function Command() {
  return (
    <SelectionAnswer
      navigationTitle="Summary"
      buildPrompt={summarizePrompt}
      question={(s) => `Summarize: ${s.text}`}
      options={(s) => (onlyLinks(s.text) ? { webSearch: true } : undefined)}
    />
  );
}
