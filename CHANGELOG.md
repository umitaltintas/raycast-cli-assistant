# CLI Assistant Changelog

## [Windows] - 2026-10-15

- Runs on Raycast for Windows: finds `claude.exe` and `codex.exe` (known install locations, then `PATH`), opens a console window for login, and uses Ctrl where macOS uses ⌘
- Ask About Finder Selection is now Ask About Selected Files and reads the File Explorer selection on Windows
- Claude Code gets its PowerShell tool next to Bash (Git Bash). Codex's approved commands run in PowerShell 7 if installed, else Windows PowerShell
- The CLIs are started from a worker thread on Windows. Starting a process there can block for seconds while security software checks it, which froze Chat, let a queued Enter stop the request and made Raycast unload the command. Stopping a request also ends the CLI's child processes
- Chat ignores a second Enter while a question is being sent
- Raycast's BCP 47 locale (`LC_ALL=en-US-u-…`) is dropped for the CLIs, so Git Bash no longer warns `setlocale: LC_ALL: cannot change locale` on every command
- `install.ps1` installs or updates from a clone or the latest release, like `install.sh`

## [Show What the Model Does] - 2026-10-14

- While answering, Ask AI and Chat show each step live (web searches, pages opened, files read, commands run) instead of only "Thinking…"; the steps stay above the answer, so commands that ran without asking are visible too
- Answers in Chat end with one line: model and duration

## [Tools in Ask AI] - 2026-10-14

- The Tools option now works in Ask AI too (it showed "Tools" but had no tools); approving a command on an answer continues in Chat, which runs it

## [Web Search, Effort, Files and Shell] - 2026-10-14

- Web search for Claude and Codex: a preference, ⌘⇧W in Chat, and "Enable Web Search" on answers to ask again with it
- Reasoning effort (Low to Max): a preference and ⌘⇧E
- Tools in Chat (⌘⇧T): the model can read files in your home folder and propose shell commands; each command that changes something waits for your approval and its output goes back into the chat
- Ask About Finder Selection: ask about the selected files or folders; the model can only read them
- Chat options are saved per chat and shown in the title
- Codex's shell is turned off when no tools are needed (~640 fewer input tokens)

## [Ask AI from Spotlight] - 2026-10-12

- `install.sh --spotlight` creates an Ask AI app that Spotlight finds; it answers with the model chosen in the extension, through Claude Code or Codex

## [Leaner Codex Requests] - 2026-10-12

- Codex requests use about a quarter of the tokens: the assistant prompt replaces Codex's coding-agent prompt, and skills, sandbox rules, apps, plugins, web search and other agent tools are left out

## [Codex Models After Update] - 2026-10-11

- The model list is refreshed right away when an installed CLI has no models in the cached list, so Codex models show up after updating instead of a day later

## [Codex Support] - 2026-10-11

- Codex CLI as a second provider, signed in with your ChatGPT plan; also found inside the ChatGPT app
- Model menus group models by CLI; Codex models come from `codex debug models`
- Chats continue across providers: turns answered by the other CLI are sent as context
- Codex CLI Path preference; Default Model can be Codex's default model
- install.sh checks both CLIs

## [Reliable Auto Direction for Short Text] - 2026-10-11

- Short text in Auto mode: a separate Haiku call classifies the language while both directions are translated in parallel (~3 s); no more commentary when a short phrase was misdetected

## [Reverse Misdetected Translations] - 2026-10-11

- In Auto mode, a translation that comes back (almost) unchanged means the language was misdetected (common for short text without accents, e.g. "benim adim ne"); the direction is reversed and the text translated again
- Translate and Translate and Replace share the same translation logic

## [Fix Ask Showing "Stopped."] - 2026-10-11

- Ask AI (and Chat opened with a question) no longer stops right away. Raycast runs development extensions in React StrictMode, whose simulated unmount aborted the request before it could restart

## [English UI and Language Preferences] - 2026-10-11

- The whole extension, README and install script are in English
- New **Primary Language** and **Secondary Language** preferences (25 languages). Summaries, explanations and answers about selected text use the primary language; Translate's Auto mode translates between the two
- Language detection with franc instead of a Turkish-only word list; longer text is also checked for a third language
- Translations are sent with explicit source and target languages and the text in tags, which fixed untranslated and instruction-following outputs
- A translation in the wrong language is retried once with Sonnet

## [Icon Fix] - 2026-10-11

- Renamed the icon file so Raycast no longer shows a stale cached icon

## [One-Line Install] - 2026-10-11

- `install.sh` installs and updates the latest release without Node, npm or git
- GitHub Actions attaches a prebuilt package to every `v*` tag

## [Model List from the CLI] - 2026-10-11

- The model list comes from the Claude Code CLI for your plan, is cached and refreshed daily
- "Refresh Model List" in the model menus
- The Default Model preference uses aliases (haiku, sonnet, opus, fable), always the newest version

## [Model Selection] - 2026-10-11

- The chosen model is shared by all commands and remembered; change it from the menus in Chat and Translate or with ⌘⇧R on an answer
- The model can change mid-chat without losing context; every answer shows which model wrote it
- Extra Models preference for any name `claude --model` accepts

## [Initial Version] - 2026-10-11

- Ask, Chat and Chat History
- Selection commands: Ask About Selection, Fix Spelling and Grammar, Improve Writing, Make Shorter, Translate, Translate and Replace, Summarize, Explain
- Streamed answers, follow-up questions, 5-hour and weekly usage display
