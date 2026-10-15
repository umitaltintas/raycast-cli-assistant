import {
  Action,
  ActionPanel,
  Icon,
  Keyboard,
  List,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { errorMarkdown, footerMarkdown } from "../lib/format";
import { stepsMarkdown } from "../lib/steps";
import {
  currentModel,
  groupByProvider,
  matchingValue,
  modelLabel,
  setCurrentModel,
} from "../lib/models";
import { withMissingContext } from "../lib/chatContext";
import { ModelsState, useModels } from "../lib/modelCatalog";
import { defaultOptions, optionBadges, RequestOptions } from "../lib/options";
import { MOD_KEY, shellLang } from "../lib/platform";
import { PROVIDER_NAMES } from "../lib/provider";
import { discardPrewarmed, prewarmModel } from "../lib/run";
import { commandResultPrompt, runApprovedCommand } from "../lib/shell";
import {
  Conversation,
  Message,
  newConversation,
  saveConversation,
  titleFrom,
} from "../lib/storage";
import { DeniedCommand, PermissionRequest } from "../lib/types";
import { useModelStream } from "../lib/useModelStream";
import { HistoryView } from "./HistoryView";
import {
  ApprovalActions,
  ErrorActions,
  ModelListActions,
  OptionActions,
  PreferencesAction,
  STOP_SHORTCUT,
} from "./shared";

export function ChatView({
  initial,
  firstQuestion,
  autoRun,
}: {
  initial?: Conversation;
  firstQuestion?: string;
  // A command approved before the chat opened (on an Ask AI answer); it is
  // run against the last message right away.
  autoRun?: string;
}) {
  const { push } = useNavigation();
  const [conversation, setConversation] = useState<Conversation>(
    () => initial ?? newConversation(currentModel(), defaultOptions()),
  );
  const [input, setInput] = useState("");
  const [selectedId, setSelectedId] = useState<string | undefined>(
    conversation.messages.at(-1)?.id,
  );
  const [pendingId, setPendingId] = useState<string | undefined>();
  const stream = useModelStream();
  const catalog = useModels();
  const sentFirst = useRef(false);
  // If "New Chat" is opened mid-request, the late answer must not land in the new chat.
  const activeId = useRef(conversation.id);
  // isLoading only changes on the next render; a second Enter before it
  // would start another run, which aborts the first ("Stopped.").
  const sending = useRef(false);

  // `prompt` replaces the question for the model (approved command results);
  // `from` is the conversation to continue when state isn't updated yet.
  const send = async (
    question: string,
    prompt?: string,
    from: Conversation = conversation,
  ) => {
    const q = question.trim();
    if (!q || stream.isLoading || sending.current) return;
    sending.current = true;
    const msg: Message = {
      id: crypto.randomUUID(),
      question: q,
      answer: "",
      createdAt: Date.now(),
      model: conversation.model,
    };
    const base: Conversation = {
      ...from,
      title: from.title || titleFrom(q),
      messages: [...from.messages, msg],
    };
    setConversation(base);
    setInput("");
    setSelectedId(msg.id);
    setPendingId(msg.id);

    const result = await stream
      .run({
        prompt: withMissingContext(from.messages, from.model, prompt ?? q),
        model: from.model,
        sessionId: from.sessionId,
        ...from.options,
      })
      .finally(() => (sending.current = false));
    const finished: Message = {
      ...msg,
      answer: result.text,
      error:
        result.isError && !result.text
          ? errorMarkdown(result.error!)
          : undefined,
      commands: result.commands,
      denied: result.denied,
      steps: result.steps,
      durationMs: result.durationMs,
    };
    const updated = {
      ...base,
      updatedAt: Date.now(),
      messages: base.messages.map((m) => (m.id === msg.id ? finished : m)),
    };
    await saveConversation(updated);
    if (activeId.current !== updated.id) return;
    setConversation(updated);
    setPendingId(undefined);
  };

  // The CLI for the next question starts while the user types (on opening,
  // after each answer, after a model or option change); leaving ends it.
  useEffect(() => {
    if (stream.isLoading) return;
    const timer = setTimeout(
      () =>
        prewarmModel({
          model: conversation.model,
          sessionId: conversation.sessionId,
          ...conversation.options,
        }),
      0,
    );
    return () => clearTimeout(timer);
  }, [
    stream.isLoading,
    conversation.model,
    conversation.sessionId,
    conversation.options,
  ]);
  useEffect(() => discardPrewarmed, []);

  useEffect(() => {
    // Deferred for the same StrictMode reason as in AnswerView.
    if (!firstQuestion || sentFirst.current) return;
    const timer = setTimeout(() => {
      sentFirst.current = true;
      send(firstQuestion);
    }, 0);
    return () => clearTimeout(timer);
  }, [firstQuestion]);

  useEffect(() => {
    const last = conversation.messages.at(-1);
    if (!autoRun || !last || sentFirst.current) return;
    const timer = setTimeout(() => {
      sentFirst.current = true;
      runCommand(last, autoRun);
    }, 0);
    return () => clearTimeout(timer);
  }, [autoRun]);

  const startNew = () => {
    stream.stop();
    const fresh = newConversation(conversation.model, conversation.options);
    activeId.current = fresh.id;
    setPendingId(undefined);
    setConversation(fresh);
    setSelectedId(undefined);
    setInput("");
  };

  const changeModel = (model: string) => {
    setCurrentModel(model);
    setConversation((c) => ({ ...c, model }));
  };

  const changeOptions = (options: RequestOptions) => {
    const updated = { ...conversation, options };
    setConversation(updated);
    if (updated.messages.length) saveConversation(updated);
  };

  // A Codex command the user approved runs here, not in the CLI; its output
  // goes back as the next message. Claude's commands never run here.
  const runCommand = async (m: Message, command: string) => {
    const cleared = withoutCommands(conversation, m.id);
    setConversation(cleared);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Running command…",
      message: command,
    });
    const result = await runApprovedCommand(command);
    toast.hide();
    await send(`$ ${command}`, commandResultPrompt(command, result), cleared);
  };

  const dismissCommands = (m: Message) => {
    const cleared = withoutCommands(conversation, m.id);
    setConversation(cleared);
    saveConversation(cleared);
  };

  // Pending: what the model is doing so far, then the text as it arrives.
  const detailOf = (m: Message) => {
    const question = `**${m.question.replace(/\n+/g, " ")}**\n\n---\n\n`;
    if (m.id === pendingId) {
      const thinking = stream.approvals?.length
        ? ""
        : `_${modelLabel(m.model ?? conversation.model)} is thinking…_`;
      return `${question}${stepsMarkdown(stream.steps)}${stream.text || thinking}${approvalsMarkdown(stream.approvals, true)}`;
    }
    return `${question}${stepsMarkdown(m.steps)}${m.error ?? m.answer}${commandsMarkdown(m.commands)}${deniedMarkdown(m.denied)}${footerMarkdown(m.model, modelLabel, m.durationMs)}`;
  };

  const messages = [...conversation.messages].reverse();
  const sendAction = input.trim() ? (
    <Action
      title="Send Message"
      icon={Icon.ArrowUp}
      onAction={() => send(input)}
    />
  ) : null;

  return (
    <List
      navigationTitle={[
        conversation.title || "New Chat",
        ...optionBadges(conversation.options),
      ].join(" · ")}
      isLoading={stream.isLoading}
      isShowingDetail={messages.length > 0}
      searchBarPlaceholder={
        conversation.messages.length
          ? "Ask a follow-up, press ↵ to send"
          : "Ask anything, press ↵ to send"
      }
      searchText={input}
      onSearchTextChange={setInput}
      // The search bar is the message input here; it must not filter the list.
      filtering={false}
      selectedItemId={selectedId}
      onSelectionChange={(id) => id && setSelectedId(id)}
      searchBarAccessory={
        <List.Dropdown
          tooltip="Model"
          isLoading={catalog.isRefreshing}
          value={matchingValue(conversation.model, catalog.models)}
          onChange={changeModel}
        >
          {groupByProvider(catalog.models).map((g) => (
            <List.Dropdown.Section
              key={g.provider}
              title={PROVIDER_NAMES[g.provider]}
            >
              {g.models.map((m) => (
                <List.Dropdown.Item
                  key={m.value}
                  title={m.title}
                  value={m.value}
                />
              ))}
            </List.Dropdown.Section>
          ))}
        </List.Dropdown>
      }
      actions={
        <ActionPanel>
          {sendAction}
          <ChatActions
            onNew={startNew}
            onHistory={() => push(<HistoryView />)}
            catalog={catalog}
          />
          <OptionActions
            options={conversation.options ?? {}}
            onChange={changeOptions}
            showTools
          />
        </ActionPanel>
      }
    >
      {messages.length === 0 ? (
        <List.EmptyView
          icon={Icon.Bubble}
          title="New Chat"
          description={[
            modelLabel(conversation.model),
            ...optionBadges(conversation.options),
            "Type a question and press ↵",
          ]
            .join(" · ")
            // Why the model menu may be out of date.
            .concat(catalog.error ? `\n\n${catalog.error}` : "")}
        />
      ) : (
        messages.map((m) => {
          const approval =
            m.id === pendingId ? stream.approvals?.[0] : undefined;
          return (
            <List.Item
              key={m.id}
              id={m.id}
              title={m.question}
              icon={
                m.error
                  ? Icon.ExclamationMark
                  : approval
                    ? Icon.Terminal
                    : m.id === pendingId
                      ? Icon.CircleProgress
                      : m.commands?.length
                        ? Icon.Terminal
                        : Icon.Message
              }
              detail={<List.Item.Detail markdown={detailOf(m)} />}
              actions={
                <ActionPanel>
                  {approval ? (
                    <ApprovalActions
                      approval={approval}
                      note={input}
                      onAllow={stream.allow}
                      onDeny={(id, note) => {
                        stream.deny(id, note);
                        if (note) setInput("");
                      }}
                    />
                  ) : null}
                  {sendAction}
                  {m.commands?.length && !stream.isLoading ? (
                    <ActionPanel.Section>
                      {m.commands.map((c) => (
                        <Action
                          key={c}
                          title={
                            m.commands!.length === 1
                              ? "Run Command"
                              : `Run ${c.length > 40 ? `${c.slice(0, 39)}…` : c}`
                          }
                          icon={Icon.Terminal}
                          onAction={() => runCommand(m, c)}
                        />
                      ))}
                      <Action
                        title="Dismiss Command"
                        icon={Icon.XMarkCircle}
                        onAction={() => dismissCommands(m)}
                      />
                    </ActionPanel.Section>
                  ) : null}
                  {m.answer ? (
                    <>
                      <Action.Paste
                        title="Paste to Active App"
                        content={m.answer}
                      />
                      <Action.CopyToClipboard
                        title="Copy Answer"
                        content={m.answer}
                        shortcut={Keyboard.Shortcut.Common.Copy}
                      />
                    </>
                  ) : null}
                  {stream.isLoading ? (
                    <Action
                      title="Stop"
                      icon={Icon.Stop}
                      shortcut={STOP_SHORTCUT}
                      onAction={stream.stop}
                    />
                  ) : null}
                  {m.id === pendingId && stream.error ? (
                    <ErrorActions error={stream.error} />
                  ) : null}
                  <ChatActions
                    onNew={startNew}
                    onHistory={() => push(<HistoryView />)}
                    catalog={catalog}
                  />
                  <OptionActions
                    options={conversation.options ?? {}}
                    onChange={changeOptions}
                    showTools
                  />
                </ActionPanel>
              }
            />
          );
        })
      )}
    </List>
  );
}

function ChatActions({
  onNew,
  onHistory,
  catalog,
}: {
  onNew: () => void;
  onHistory: () => void;
  catalog: ModelsState;
}) {
  return (
    <ActionPanel.Section>
      <Action
        title="New Chat"
        icon={Icon.PlusCircle}
        shortcut={Keyboard.Shortcut.Common.New}
        onAction={onNew}
      />
      <Action
        title="Chat History"
        icon={Icon.Clock}
        shortcut={Keyboard.Shortcut.Common.ToggleQuickLook}
        onAction={onHistory}
      />
      <ModelListActions catalog={catalog} />
      <PreferencesAction />
    </ActionPanel.Section>
  );
}

function withoutCommands(c: Conversation, messageId: string): Conversation {
  return {
    ...c,
    messages: c.messages.map((m) =>
      m.id === messageId ? { ...m, commands: undefined } : m,
    ),
  };
}

// Commands waiting mid-turn, as a punchlist: ↵ answers the first one. In
// Chat a note typed before ↵ tells Claude what to do instead.
export function approvalsMarkdown(
  approvals: PermissionRequest[] | undefined,
  withNote = false,
): string {
  if (!approvals?.length) return "";
  const block = (a: PermissionRequest) =>
    `\`\`\`${shellLang(a.shell)}\n${a.command}\n\`\`\``;
  const [next, ...rest] = approvals;
  const title = next.description ? `: ${next.description}` : "";
  return [
    `\n\n---\n\n**Wants to run${title}** (↵ runs it, ${MOD_KEY}↵ doesn't${withNote ? `; to tell Claude what to do instead, type it, then ↵` : ""})`,
    block(next),
    ...(rest.length ? [`_Then ${rest.length} more:_`, ...rest.map(block)] : []),
  ].join("\n\n");
}

// Codex's commands, waiting for approval after the answer.
export function commandsMarkdown(commands: string[] | undefined): string {
  if (!commands?.length) return "";
  const blocks = commands
    .map((c) => `\`\`\`${shellLang(undefined)}\n${c}\n\`\`\``)
    .join("\n\n");
  const verb = commands.length === 1 ? "this command" : "these commands";
  return `\n\n---\n\n**Wants to run ${verb}** (runs only if you approve it; ↵ or ${MOD_KEY}K):\n\n${blocks}`;
}

// Claude's commands that Claude Code refused without asking: only listed.
export function deniedMarkdown(denied: DeniedCommand[] | undefined): string {
  if (!denied?.length) return "";
  const blocks = denied
    .map((d) => `\`\`\`${shellLang(d.shell)}\n${d.command}\n\`\`\``)
    .join("\n\n");
  const [what, it] =
    denied.length === 1 ? ["this command", "it"] : ["these commands", "them"];
  return `\n\n---\n\n**Not run:** Claude Code's permission check refused ${what}. To run ${it} anyway, tell Claude to go ahead.\n\n${blocks}`;
}
