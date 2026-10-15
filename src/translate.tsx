import {
  Action,
  ActionPanel,
  Icon,
  Keyboard,
  List,
  LocalStorage,
} from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { ModelSubmenu, shortcut } from "./components/shared";
import { errorMarkdown } from "./lib/format";
import {
  AUTO,
  autoLabel,
  LANGUAGES,
  resolveTranslation,
  RETRY_MODEL,
} from "./lib/languages";
import { useModels } from "./lib/modelCatalog";
import { currentModel, modelLabel, setCurrentModel } from "./lib/models";
import { readSourceText } from "./lib/selection";
import { RetryReason, translateText } from "./lib/translation";
import { useModelStream } from "./lib/useModelStream";
import { RunResult } from "./lib/types";

// Like Raycast's Translate: the search bar is the input and translation starts
// when typing pauses. Each request takes ~3 s, so keystrokes are debounced
// into a single request.
const DEBOUNCE_MS = 600;
const LANG_KEY = "translate-language";

export default function Command() {
  const [text, setText] = useState("");
  const [language, setLanguage] = useState<string>();
  const [ready, setReady] = useState(false);
  const [model, setModel] = useState(currentModel);
  const stream = useModelStream();
  const catalog = useModels();
  const lastRequest = useRef("");
  const [retries, setRetries] = useState<RetryReason[]>([]);
  const [target, setTarget] = useState("");
  // Short Auto text is translated off the stream (in parallel), so the view
  // keeps its own loading flag and final result.
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<RunResult>();

  useEffect(() => {
    Promise.all([
      readSourceText({ allowClipboard: false }),
      LocalStorage.getItem<string>(LANG_KEY),
    ]).then(([source, lang]) => {
      if (source) setText(source.text);
      setLanguage(
        lang && (lang === AUTO || LANGUAGES.some((l) => l.name === lang))
          ? lang
          : AUTO,
      );
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (!ready || !language) return;
    const input = text.trim();
    if (!input) {
      stream.stop();
      return;
    }
    const key = `${model}:${language}:${input}`;
    if (key === lastRequest.current) return;
    const t = setTimeout(async () => {
      lastRequest.current = key;
      setRetries([]);
      setDone(undefined);
      setBusy(true);
      setTarget(resolveTranslation(input, language).target);
      const outcome = await translateText(
        input,
        language,
        model,
        // A newer request owns the stream; a stale chain must not start more runs.
        (request) =>
          lastRequest.current === key
            ? stream.run(request)
            : Promise.resolve({
                text: "",
                isError: true,
                error: { kind: "cancelled", message: "Stale." },
              }),
        (reason) => {
          if (lastRequest.current !== key) return;
          setRetries((r) => [...r, reason]);
        },
      );
      if (lastRequest.current !== key) return;
      setTarget(outcome.direction.target);
      setDone(outcome.result);
      setBusy(false);
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text, language, model, ready]);

  const changeModel = (value: string) => {
    setCurrentModel(value);
    setModel(value);
  };

  const changeLanguage = (value: string) => {
    setLanguage(value);
    LocalStorage.setItem(LANG_KEY, value);
  };

  const translation = (done ? done.text : stream.text).trim();
  const error = done ? done.error : stream.error;
  const hasInput = text.trim().length > 0;
  const markdown =
    error && !translation
      ? errorMarkdown(error)
      : translation || "_Translating…_";

  return (
    <List
      isLoading={!ready || busy || stream.isLoading}
      searchText={text}
      onSearchTextChange={setText}
      searchBarPlaceholder="Type or paste text to translate"
      filtering={false}
      isShowingDetail={hasInput}
      searchBarAccessory={
        language ? (
          <List.Dropdown
            tooltip="Target Language"
            value={language}
            onChange={changeLanguage}
          >
            <List.Dropdown.Item title={autoLabel()} value={AUTO} />
            <List.Dropdown.Section>
              {LANGUAGES.map((l) => (
                <List.Dropdown.Item
                  key={l.name}
                  title={l.name}
                  value={l.name}
                />
              ))}
            </List.Dropdown.Section>
          </List.Dropdown>
        ) : undefined
      }
    >
      {!hasInput ? (
        <List.EmptyView
          icon={Icon.Globe}
          title="Type Text to Translate"
          description="Selected text is filled in automatically"
        />
      ) : (
        <List.Item
          title={target ? `→ ${target}` : ""}
          subtitle={subtitle(model, retries)}
          icon={Icon.Globe}
          detail={<List.Item.Detail markdown={markdown} />}
          actions={
            <ActionPanel>
              {translation ? (
                <>
                  <Action.Paste
                    title="Paste to Active App"
                    content={translation}
                  />
                  <Action.CopyToClipboard
                    title="Copy Translation"
                    content={translation}
                    shortcut={Keyboard.Shortcut.Common.Copy}
                  />
                  {language === AUTO ? (
                    <Action
                      title="Translate Back"
                      icon={Icon.Switch}
                      shortcut={shortcut(["cmd"], "t")}
                      onAction={() => setText(translation)}
                    />
                  ) : null}
                </>
              ) : null}
              <ModelSubmenu
                title="Change Model"
                current={model}
                catalog={catalog}
                onSelect={changeModel}
              />
            </ActionPanel>
          }
        />
      )}
    </List>
  );
}

function subtitle(model: string, retries: RetryReason[]): string {
  const notes = retries.map((r) =>
    r === "reversed" ? "reversed direction" : "wrong language",
  );
  const used = retries.includes("wrong-language") ? RETRY_MODEL : model;
  return notes.length
    ? `${modelLabel(used)} (retried: ${notes.join(", ")})`
    : modelLabel(used);
}
