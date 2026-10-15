import {
  Action,
  ActionPanel,
  Icon,
  Keyboard,
  openExtensionPreferences,
} from "@raycast/api";
import { spawn } from "node:child_process";
import { ModelError, PermissionRequest } from "../lib/types";
import { groupByProvider, sameModel } from "../lib/models";
import { ModelsState } from "../lib/modelCatalog";
import { EFFORTS, RequestOptions } from "../lib/options";
import { IS_WINDOWS } from "../lib/platform";
import { resolveClaudeBinary } from "../lib/claude";
import { resolveCodexBinary } from "../lib/codex";
import { Provider, PROVIDER_NAMES } from "../lib/provider";

function loginCommand(provider: Provider | undefined): string {
  if (provider === "codex") {
    // Codex may only exist inside the ChatGPT app, so use the resolved path.
    return `'${resolveCodexBinary() ?? "codex"}' login`;
  }
  return "claude /login";
}

function openLoginInTerminal(provider: Provider | undefined) {
  if (IS_WINDOWS) {
    const bin =
      (provider === "codex" ? resolveCodexBinary() : resolveClaudeBinary()) ??
      (provider === "codex" ? "codex" : "claude");
    const command = `"${bin}" ${provider === "codex" ? "login" : "/login"}`;
    // start opens a new console window; /k keeps it open after the login.
    // /s with outer quotes stops cmd from stripping the quotes inside.
    spawn("cmd.exe", ["/d", "/s", "/c", `"start "" cmd.exe /k ${command}"`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: true,
    }).unref();
    return;
  }
  const script = `tell application "Terminal" to do script ${JSON.stringify(loginCommand(provider))}`;
  spawn(
    "osascript",
    ["-e", 'tell application "Terminal" to activate', "-e", script],
    {
      detached: true,
      stdio: "ignore",
    },
  ).unref();
}

export function ErrorActions({ error }: { error: ModelError }) {
  if (error.kind === "not-logged-in") {
    return (
      <Action
        title="Open Terminal for Login"
        icon={Icon.Terminal}
        onAction={() => openLoginInTerminal(error.provider)}
      />
    );
  }
  if (error.kind === "not-installed") {
    return (
      <Action
        title="Open Extension Preferences"
        icon={Icon.Gear}
        onAction={openExtensionPreferences}
      />
    );
  }
  return null;
}

// ⌘ on macOS is Ctrl on Windows.
export function shortcut(
  modifiers: Keyboard.KeyModifier[],
  key: Keyboard.KeyEquivalent,
): Keyboard.Shortcut {
  return {
    macOS: { modifiers, key },
    Windows: {
      modifiers: modifiers.map((m) => (m === "cmd" ? "ctrl" : m)),
      key,
    },
  };
}

export const STOP_SHORTCUT = shortcut(["cmd"], ".");
export const MODEL_SHORTCUT = shortcut(["cmd", "shift"], "r");

// The list comes from the CLI (useModels); the chosen model persists.
export function ModelSubmenu(props: {
  title: string;
  current: string;
  catalog: ModelsState;
  onSelect: (model: string) => void;
}) {
  const { catalog } = props;
  return (
    <ActionPanel.Submenu
      title={props.title}
      icon={Icon.Switch}
      shortcut={MODEL_SHORTCUT}
    >
      {groupByProvider(catalog.models).map((g) => (
        <ActionPanel.Section
          key={g.provider}
          title={PROVIDER_NAMES[g.provider]}
        >
          {g.models.map((m) => (
            <Action
              key={m.value}
              title={m.title}
              icon={
                sameModel(m.value, props.current) ? Icon.Checkmark : Icon.Circle
              }
              onAction={() => props.onSelect(m.value)}
            />
          ))}
        </ActionPanel.Section>
      ))}
      <ActionPanel.Section>
        <ModelListActions catalog={catalog} />
      </ActionPanel.Section>
    </ActionPanel.Submenu>
  );
}

// Refresh, hide or show models, add one: in the model menus and Chat.
export function ModelListActions({ catalog }: { catalog: ModelsState }) {
  const hidden = catalog.hidden();
  return (
    <>
      <Action
        title="Refresh Model List"
        icon={Icon.ArrowClockwise}
        onAction={() => catalog.refresh(true)}
      />
      <ActionPanel.Submenu title="Hide or Show Models" icon={Icon.EyeDisabled}>
        {groupByProvider(catalog.allModels()).map((g) => (
          <ActionPanel.Section
            key={g.provider}
            title={PROVIDER_NAMES[g.provider]}
          >
            {g.models.map((m) => {
              const isHidden = hidden.includes(m.value);
              return (
                <Action
                  key={m.value}
                  title={isHidden ? `Show ${m.title}` : `Hide ${m.title}`}
                  icon={isHidden ? Icon.EyeDisabled : Icon.Eye}
                  onAction={() => catalog.setHidden(m.value, !isHidden)}
                />
              );
            })}
          </ActionPanel.Section>
        ))}
      </ActionPanel.Submenu>
      <Action
        title="Add Extra Model…"
        icon={Icon.Plus}
        onAction={openExtensionPreferences}
      />
    </>
  );
}

export function PreferencesAction() {
  return (
    <Action
      title="Open Extension Preferences"
      icon={Icon.Gear}
      onAction={openExtensionPreferences}
    />
  );
}

export const WEB_SEARCH_SHORTCUT = shortcut(["cmd", "shift"], "w");
export const TOOLS_SHORTCUT = shortcut(["cmd", "shift"], "t");
export const EFFORT_SHORTCUT = shortcut(["cmd", "shift"], "e");

// A shell command waiting mid-turn: ↵ runs it (Claude Code runs it and goes
// on), the second action (⌘↵ / Ctrl+↵) declines it. In Chat, text typed in the
// message box goes with the decline as a note on what to do instead.
export function ApprovalActions(props: {
  approval: PermissionRequest;
  note?: string;
  onAllow: (id: string) => void;
  onDeny: (id: string, note?: string) => void;
}) {
  const { approval } = props;
  const note = props.note?.trim();
  const run = (
    <Action
      key="run"
      title="Run Command"
      icon={Icon.Terminal}
      onAction={() => props.onAllow(approval.id)}
    />
  );
  const deny = (
    <Action
      key="deny"
      title={note ? "Don't Run, Tell Claude" : "Don't Run"}
      icon={note ? Icon.Bubble : Icon.XMarkCircle}
      onAction={() => props.onDeny(approval.id, note)}
    />
  );
  // With a note typed, ↵ sends it instead of running the command.
  return (
    <ActionPanel.Section>
      {note ? [deny, run] : [run, deny]}
    </ActionPanel.Section>
  );
}

// Web search, tools and effort for the current chat or answer.
export function OptionActions(props: {
  options: RequestOptions;
  onChange: (options: RequestOptions) => void;
  showTools?: boolean;
}) {
  const { options, onChange } = props;
  return (
    <ActionPanel.Section title="Options">
      <Action
        title={options.webSearch ? "Disable Web Search" : "Enable Web Search"}
        icon={Icon.Globe}
        shortcut={WEB_SEARCH_SHORTCUT}
        onAction={() =>
          onChange({ ...options, webSearch: !options.webSearch || undefined })
        }
      />
      {props.showTools ? (
        <Action
          title={
            options.tools ? "Disable Tools" : "Enable Tools (Files and Shell)"
          }
          icon={Icon.Hammer}
          shortcut={TOOLS_SHORTCUT}
          onAction={() =>
            onChange({ ...options, tools: !options.tools || undefined })
          }
        />
      ) : null}
      <ActionPanel.Submenu
        title="Reasoning Effort"
        icon={Icon.LightBulb}
        shortcut={EFFORT_SHORTCUT}
      >
        <Action
          title="CLI Default"
          icon={options.effort ? Icon.Circle : Icon.Checkmark}
          onAction={() => onChange({ ...options, effort: undefined })}
        />
        {EFFORTS.map((e) => (
          <Action
            key={e.value}
            title={e.title}
            icon={options.effort === e.value ? Icon.Checkmark : Icon.Circle}
            onAction={() => onChange({ ...options, effort: e.value })}
          />
        ))}
      </ActionPanel.Submenu>
    </ActionPanel.Section>
  );
}
