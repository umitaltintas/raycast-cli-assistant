import {
  Action,
  ActionPanel,
  Detail,
  Icon,
  Keyboard,
  useNavigation,
} from "@raycast/api";
import { useEffect, useState } from "react";
import { errorMarkdown, rateLimitLines } from "../lib/format";
import { stepsMarkdown } from "../lib/steps";
import { currentModel, modelLabel, setCurrentModel } from "../lib/models";
import { useModels } from "../lib/modelCatalog";
import { defaultOptions, optionBadges, RequestOptions } from "../lib/options";
import { newConversation, saveConversation, titleFrom } from "../lib/storage";
import { useModelStream } from "../lib/useModelStream";
import {
  approvalsMarkdown,
  ChatView,
  commandsMarkdown,
  deniedMarkdown,
} from "./ChatView";
import {
  ApprovalActions,
  ErrorActions,
  ModelSubmenu,
  OptionActions,
  PreferencesAction,
  STOP_SHORTCUT,
} from "./shared";

export interface AnswerViewProps {
  // Full text sent to the model (may include the selection and instructions).
  prompt: string;
  // Short form shown on screen and in history.
  question: string;
  systemPrompt?: string;
  navigationTitle?: string;
  // Web search, effort, tools and the Finder selection's folders.
  options?: RequestOptions;
}

export function AnswerView(props: AnswerViewProps) {
  const { push } = useNavigation();
  const [model, setModel] = useState(currentModel);
  // Every answer starts with the effort preference; the command adds the rest.
  const [options, setOptions] = useState<RequestOptions>(() => ({
    effort: defaultOptions().effort,
    ...props.options,
  }));
  // Each run opens its own session; "Continue in Chat" resumes it with --resume.
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const stream = useModelStream();
  const catalog = useModels();

  // Raycast wraps development extensions in React StrictMode, which mounts,
  // unmounts and remounts effects. Starting the request right away meant the
  // simulated unmount aborted it and a "started" guard blocked the restart, so
  // Ask showed "Stopped." Deferring the start lets that cleanup cancel the
  // timer before any CLI process is spawned.
  useEffect(() => {
    const timer = setTimeout(() => {
      stream.run({
        prompt: props.prompt,
        model,
        sessionId,
        systemPrompt: props.systemPrompt,
        ...options,
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [sessionId, model]);

  const regenerate = (m = model) => {
    setCurrentModel(m);
    setModel(m);
    setSessionId(crypto.randomUUID());
  };

  const changeOptions = (o: RequestOptions) => {
    setOptions(o);
    setSessionId(crypto.randomUUID());
  };

  // An approved (Codex) command continues in Chat, which runs it and keeps
  // going.
  const continueInChat = async (command?: string) => {
    // The chat starts with the answer's options as they are and can switch
    // them one by one.
    const c = newConversation(model, options);
    c.sessionId = sessionId;
    c.title = titleFrom(props.question);
    c.messages.push({
      id: crypto.randomUUID(),
      question: props.question,
      answer: stream.text,
      createdAt: Date.now(),
      model,
      steps: stream.steps,
      durationMs: stream.durationMs,
      commands: command ? undefined : stream.commands,
      denied: stream.denied,
    });
    await saveConversation(c);
    push(<ChatView initial={c} autoRun={command} />);
  };

  const approval = stream.approvals?.[0];
  const body =
    stream.error && !stream.text
      ? errorMarkdown(stream.error)
      : stream.text || (approval ? "" : `_${modelLabel(model)} is thinking…_`);
  const commands = stream.isLoading ? undefined : stream.commands;
  const denied = stream.isLoading ? undefined : stream.denied;
  const markdown = `**${escape(props.question)}**\n\n---\n\n${stepsMarkdown(stream.steps)}${(commands?.length || denied?.length) && !stream.text ? "" : body}${approvalsMarkdown(stream.approvals)}${commandsMarkdown(commands)}${deniedMarkdown(denied)}`;
  const done = !stream.isLoading && !stream.error && stream.text.length > 0;

  return (
    <Detail
      navigationTitle={props.navigationTitle ?? "CLI Assistant"}
      isLoading={stream.isLoading}
      markdown={markdown}
      metadata={
        !stream.isLoading ? (
          <Detail.Metadata>
            <Detail.Metadata.Label title="Model" text={modelLabel(model)} />
            {optionBadges(options).length ? (
              <Detail.Metadata.Label
                title="Options"
                text={optionBadges(options).join(" · ")}
              />
            ) : null}
            {stream.durationMs ? (
              <Detail.Metadata.Label
                title="Duration"
                text={`${(stream.durationMs / 1000).toFixed(1)} s`}
              />
            ) : null}
            {rateLimitLines(stream.rateLimit).map((l) => (
              <Detail.Metadata.Label
                key={l.title}
                title={l.title}
                text={l.text}
              />
            ))}
          </Detail.Metadata>
        ) : undefined
      }
      actions={
        <ActionPanel>
          {approval ? (
            <ApprovalActions
              approval={approval}
              onAllow={stream.allow}
              onDeny={stream.deny}
            />
          ) : null}
          {stream.isLoading ? (
            <Action
              title="Stop"
              icon={Icon.Stop}
              shortcut={STOP_SHORTCUT}
              onAction={stream.stop}
            />
          ) : null}
          {commands?.length ? (
            <ActionPanel.Section>
              {commands.map((c) => (
                <Action
                  key={c}
                  title={
                    commands.length === 1
                      ? "Run Command"
                      : `Run ${c.length > 40 ? `${c.slice(0, 39)}…` : c}`
                  }
                  icon={Icon.Terminal}
                  onAction={() => continueInChat(c)}
                />
              ))}
            </ActionPanel.Section>
          ) : null}
          {done ? (
            <>
              <Action.Paste title="Paste to Active App" content={stream.text} />
              <Action
                title="Continue in Chat"
                icon={Icon.Bubble}
                onAction={() => continueInChat()}
              />
              <Action.CopyToClipboard
                title="Copy Answer"
                content={stream.text}
                shortcut={Keyboard.Shortcut.Common.Copy}
              />
            </>
          ) : null}
          {stream.error ? <ErrorActions error={stream.error} /> : null}
          {!stream.isLoading ? (
            <>
              <Action
                title="Regenerate"
                icon={Icon.ArrowClockwise}
                shortcut={Keyboard.Shortcut.Common.Refresh}
                onAction={() => regenerate()}
              />
              <ModelSubmenu
                title="Ask Another Model"
                current={model}
                catalog={catalog}
                onSelect={regenerate}
              />
              <OptionActions
                options={options}
                onChange={changeOptions}
                showTools
              />
              <ActionPanel.Section>
                <PreferencesAction />
              </ActionPanel.Section>
            </>
          ) : null}
        </ActionPanel>
      }
    />
  );
}

// Soru basliginda Markdown ozel karakterleri bicimi bozmasin.
function escape(s: string): string {
  const oneLine = s.length > 300 ? `${s.slice(0, 297)}…` : s;
  return oneLine.replace(/([\\`*_[\]#>])/g, "\\$1").replace(/\n+/g, " ");
}
