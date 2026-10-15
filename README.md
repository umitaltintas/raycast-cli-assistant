<p align="center"><img src="assets/extension-icon.png" width="128" alt="CLI Assistant"></p>

# CLI Assistant

**Raycast AI on the Claude or ChatGPT plan you already pay for.**

Claude and ChatGPT plans include a coding CLI: Claude Code and Codex. This Raycast extension runs your requests through whichever one is installed and signed in on your Mac or Windows PC ([Windows](#windows)), so you get the everyday Raycast AI features without a Raycast Pro subscription, an API key or per-token billing.

- **Ask AI** from root search, and **Chat** with follow-ups and history
- **Fix Spelling and Grammar**, **Improve Writing**, **Make Shorter**: rewrite the selection in place
- **Translate** as you type, or **Translate and Replace** the selection with one hotkey
- **Summarize** and **Explain** the selection
- **Ask About Selected Files**: questions about files and folders (PDFs, logs, code), read-only
- Optional **web search**, **reasoning effort** and **tools** (read files, run shell commands after your approval), switchable mid-chat
- Any model your plan offers (Haiku, Sonnet, Opus, GPT-5.6…), switchable mid-chat, even between Claude and Codex

How it stays fast and cheap: the CLIs are coding agents, so the extension turns off their tools, MCP servers, settings files and agent prompts. That brings Claude Code's first answer from ~9 s to ~3 s and Codex's prompt from ~17.6k to ~4.5k tokens. Details in [How it works](#how-it-works).

> Not affiliated with, built by, or endorsed by Anthropic, OpenAI or Raycast. It runs the official, unmodified CLIs; sign-in stays with them.

## Install

Paste into a terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/umitaltintas/raycast-cli-assistant/main/install.sh | bash
```

No Node, npm or git needed. The script downloads the prebuilt extension (~50 KB) from the [latest release](https://github.com/umitaltintas/raycast-cli-assistant/releases/latest), puts it into Raycast's extensions folder and registers it with Raycast. It also checks which of Claude Code and Codex are installed and signed in. **Run the same command again to update**; chats and settings are kept. To uninstall, press <kbd>⌘</kbd><kbd>K</kbd> on any of its commands in Raycast → *Uninstall Extension*.

Then open the extension preferences and set your **Primary Language**.

> Extensions installed outside the Store show up in Raycast as development extensions and may require being signed in to a Raycast account. The script sends the same registration notification as `ray develop` (`raycast://cli/…`). That is not a documented Raycast interface, so if it ever changes, installing from source below always works.

<details>
<summary>Install from source (for development)</summary>

```bash
git clone https://github.com/umitaltintas/raycast-cli-assistant.git
cd raycast-cli-assistant
npm install
npm run dev   # once the extension shows up in Raycast you can stop it with Ctrl+C
```

Requires Node 22.22.2 or newer.

</details>

### Spotlight (optional)

Add `--spotlight` to also get an **Ask AI** app that Spotlight finds:

```bash
curl -fsSL https://raw.githubusercontent.com/umitaltintas/raycast-cli-assistant/main/install.sh | bash -s -- --spotlight
```

Press <kbd>⌘</kbd><kbd>Space</kbd>, type "Ask AI", ask a question and the answer shows in a dialog with *Copy* and *Ask Another*. It uses the model last chosen in the extension and doesn't need Raycast to be open. Running the installer again keeps it up to date; to remove it, delete `~/Applications/Ask AI.app`. (A Shortcut would be nicer, but signing one needs an iCloud account.)

### Requirements

- Raycast v2 on macOS
- At least one of:
  - [Claude Code](https://code.claude.com/docs/en/quickstart), signed in with a paid Claude plan:

    ```bash
    curl -fsSL https://claude.ai/install.sh | bash
    claude   # then /login
    ```

  - [Codex](https://github.com/openai/codex), signed in with a ChatGPT plan: `brew install codex`, then `codex login`. The ChatGPT app also ships a copy of Codex, which is found automatically.

## Windows

In PowerShell, without a clone (downloads the latest release, no Node needed):

```powershell
irm https://raw.githubusercontent.com/umitaltintas/raycast-cli-assistant/main/install.ps1 | iex
```

Or from a clone, which builds from source (needs Node 22.22.2 or newer):

```powershell
git clone https://github.com/umitaltintas/raycast-cli-assistant.git
cd raycast-cli-assistant
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

`install.ps1` does what `install.sh` does: it checks Raycast, Claude Code, Codex and Git Bash, puts the extension into `%USERPROFILE%\.config\raycast\extensions\claude-cli` and registers it with Raycast the way `ray develop` does, but leaves no watcher running. A `ray develop` that is still running is stopped first, since it would overwrite the install on its next rebuild. **Run it again to update**; chats and settings are kept. `npm run dev` still works for development.

Requirements: Raycast for Windows, and Claude Code (`irm https://claude.ai/install.ps1 | iex`, then `claude` → `/login`) or Codex (`npm i -g @openai/codex`, then `codex login`).

What differs from macOS:

- <kbd>Ctrl</kbd> replaces <kbd>⌘</kbd> in every shortcut below (<kbd>Ctrl</kbd><kbd>⇧</kbd><kbd>T</kbd> for Tools, <kbd>Ctrl</kbd><kbd>.</kbd> to stop…).
- **Ask About Selected Files** reads the File Explorer selection.
- **Tools:** Claude Code gets both its Bash tool (Git Bash) and its PowerShell tool. An approved command runs in the shell it was written for: Bash commands in the Git Bash Claude Code uses (`CLAUDE_CODE_GIT_BASH_PATH`, else the one next to `git.exe`), PowerShell commands in PowerShell 7 if installed, else Windows PowerShell. Codex's own shell on Windows is PowerShell, so its `approve` commands run there.
- **Login:** *Open Terminal for Login* opens a console window with `claude /login` or `codex login`.
- The CLIs are found in `~\.local\bin\claude.exe`, the global npm package for `codex.exe`, then `PATH`. npm's `.cmd` shims are skipped: they can't be started without a shell, which would mangle the arguments.
- The Spotlight app is macOS only.

## Commands

| Command | What it does |
| --- | --- |
| **Ask AI** | Takes a question from root search and streams the answer. Can be used as a fallback command. |
| **Chat** | A chat with follow-up questions. |
| **Chat History** | Open or delete previous chats. |
| **Ask About Selection** | Ask a question about the selected text. |
| **Ask About Selected Files** | Ask about the files or folders selected in Finder (File Explorer on Windows). The model can read them and nothing else. |
| **Fix Spelling and Grammar** · **Improve Writing** · **Make Shorter** | Rewrite the selected text and paste the result over it. |
| **Translate** | Translates as you type; selected text is filled in. The target language is remembered. |
| **Translate and Replace** | Translates the selected text without opening a window and pastes it over the selection. |
| **Summarize** · **Explain** | Summarize or explain the selected text (or the clipboard if nothing is selected), in your primary language. |

**Choosing a model:** from the dropdown in the search bar in Chat and Translate, or with <kbd>⌘</kbd><kbd>⇧</kbd><kbd>R</kbd> on an answer. Models are grouped by CLI (Claude Code, Codex). The list is not hardcoded: it comes from the installed CLIs and matches your plans, so new models show up on their own. The chosen model is shared by all commands and remembered; switching mid-chat keeps the context, even across Claude and Codex.

On an answer: <kbd>↵</kbd> paste to the active app, <kbd>⌘</kbd><kbd>↵</kbd> continue in chat, <kbd>⌘</kbd><kbd>⇧</kbd><kbd>C</kbd> copy, <kbd>⌘</kbd><kbd>R</kbd> regenerate, <kbd>⌘</kbd><kbd>⇧</kbd><kbd>R</kbd> ask another model, <kbd>⌘</kbd><kbd>.</kbd> stop.

**Options**, in Chat and on answers, start from the preferences and are remembered per chat:

| Option | Shortcut | What it does |
| --- | --- | --- |
| Web Search | <kbd>⌘</kbd><kbd>⇧</kbd><kbd>W</kbd> | Lets the model search and open web pages. Slower: ~15–20 s with Claude, ~13 s with Codex. On an answer it asks again with search. |
| Tools (Files and Shell) | <kbd>⌘</kbd><kbd>⇧</kbd><kbd>T</kbd> | Ask AI and Chat. The model can read files in your home folder and propose shell commands. A command that changes something is shown first; <kbd>↵</kbd> runs it in your login shell and sends the output back, or *Dismiss Command*. On an Ask AI answer, approving continues in Chat. Read-only commands (`ls`, `df`, `lsof`…) may run without asking, as in Claude Code and Codex's read-only sandbox. |
| Reasoning Effort | <kbd>⌘</kbd><kbd>⇧</kbd><kbd>E</kbd> | Low to Max. Short questions rarely need more than the default. |

While the model works, each step (web searches, pages opened, files read, commands run) is shown live and kept above the answer. The navigation title shows what is on (e.g. *My chat · Web · Tools*). Translate and the rewrite commands always run without them, to stay fast.

Tips:

- Make **Ask AI** a fallback command in Raycast settings: anything you type in root search that matches no command becomes a question with <kbd>↵</kbd>.
- Give your most used commands (Translate and Replace, Fix Spelling and Grammar) a hotkey.

## Preferences

| Preference | Description |
| --- | --- |
| Default Model | Haiku, Sonnet, Opus or Fable (aliases that always resolve to the newest version), or Codex with its default model. A model you pick inside the extension overrides it. |
| Primary Language | Your main language. Summaries and explanations of selected text are written in it, and Translate's Auto mode translates into it. |
| Secondary Language | Translate's Auto mode translates text that is already in your primary language into this one. |
| Web Search | Default for Ask AI and new chats. |
| Tools | Default for Ask AI and new chats. |
| Reasoning Effort | Default effort; *CLI Default* leaves it to the CLI. |
| Extra Models | Comma-separated models missing from your plan's list (e.g. `claude-opus-5-5[1m]`). |
| Claude CLI Path | Leave empty to try `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. |
| Codex CLI Path | Leave empty to try Homebrew, `~/.local/bin`, npm and the copy bundled with the ChatGPT app. |
| Extra Instructions | Appended to every request (tone, how to address you, etc.). |

## How it works

Every request runs `claude -p` in streaming (`stream-json`) mode. Claude Code is a coding agent, so everything a chat assistant doesn't need is turned off:

- tools (`--tools ""`), MCP servers (`--strict-mcp-config`), settings files (`--setting-sources ""`) and slash commands;
- a short assistant system prompt (`--system-prompt`) instead of Claude Code's coding prompt.

In my measurements this brings the time to the first answer from ~9 s down to ~3 s. `--bare` would be faster but only works with API keys and ignores Claude account logins.

**Codex** runs as `codex exec --json` in a read-only sandbox; follow-ups use `codex exec resume`. Its coding-agent prompt is replaced with the assistant prompt (`model_instructions_file`), and the skills list, sandbox rules, apps, plugins, web search and other agent tools are turned off, which cuts a short request from ~17.6k to ~4.5k input tokens. Compared with Claude Code it is slower (~4.5 s for a short answer in my tests, almost all of it the round trip to OpenAI) and its answers arrive in one piece rather than streamed. When you switch between Claude and Codex mid-chat, the turns the other CLI answered are sent along as context, since each keeps its own history.

**Options** map to CLI flags. Claude: `--tools WebSearch,WebFetch`, `Read,Glob,Grep` with `--add-dir`, `Bash`, and `--effort`. Bash is never pre-approved: in `-p` mode a call that needs approval is denied and listed in `permission_denials`, so the extension shows that exact command and, once approved, runs it itself and sends the output as the next message. Codex: `web_search="live"`, `model_reasoning_effort`, and its shell in the read-only sandbox (turned off entirely when not needed, ~640 fewer tokens); commands the sandbox would block are asked for in an `approve` block and handled the same way.

More details:

- **Chats** are Claude Code sessions (`--session-id` / `--resume`). Their files are kept in the extension's own folder so they don't mix with your real projects.
- **Model list:** Claude models come from the CLI's control protocol (the `initialize` request also behind the Agent SDK's `supportedModels()`), Codex models from `codex debug models`; no model calls, ~1 s, both in parallel. The result is cached and refreshed daily in the background; if the CLI is unreachable a fallback list of aliases is used.
- **Translation direction:** Auto mode is not left to the translation itself, which was unreliable. For longer text the extension detects the language with [franc](https://github.com/wooorm/franc) and sends one source and one target language; if the result comes back (almost) unchanged, the direction is reversed once. Short text is too ambiguous for franc ("benim adim ne" and "hello" were both misdetected), so a separate call (Haiku, or the chosen Codex model) only answers "primary or secondary?" while both directions are translated in parallel; the classified one is shown. That takes ~3 s, the same as a single translation.
- **Wrong-language check:** if a translation from a Claude model comes back in the wrong language (Haiku sometimes does this, e.g. German → Turkish), it is retried once with Sonnet and the result is marked. Codex requests always stay on Codex.
- **Proxy:** `--setting-sources ""` skips user settings, so `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` from `~/.claude/settings.json` are read by the extension and passed to the CLI.
- **Raycast environment:** Raycast extension processes have no `USER` / `LOGNAME`; without them Claude Code can't find its Keychain login and says `Not logged in`. The extension sets them.
- If `ANTHROPIC_API_KEY` is set, the CLI would use it instead of your subscription, so it is removed from the child process.

## Terms

The extension does not collect, store or relay credentials. It only runs the unmodified Claude Code or Codex CLI that you installed, and sign-in happens through Anthropic's or OpenAI's own flow. Your usage is subject to their terms ([Anthropic](https://code.claude.com/docs/en/legal-and-compliance), [OpenAI](https://openai.com/policies/)) and your plan's limits.

## License

MIT
