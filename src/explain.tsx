import { SelectionAnswer } from "./components/SelectionAnswer";
import { explainPrompt } from "./lib/prompts";

export default function Command() {
  return (
    <SelectionAnswer
      navigationTitle="Explanation"
      buildPrompt={explainPrompt}
      question={(s) => `Explain: ${s.text}`}
      // Terms, names and errors are often newer than the model.
      options={{ webSearch: true }}
    />
  );
}
