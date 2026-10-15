import { environment, LocalStorage } from "@raycast/api";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RequestOptions } from "./options";
import { Shell } from "./platform";
import { RateLimit } from "./types";

export interface Message {
  id: string;
  question: string;
  answer: string;
  createdAt: number;
  error?: string;
  // The model can change mid-chat; --resume keeps the context.
  model?: string;
  // Shell commands the model asked to run, until approved or dismissed.
  commands?: string[];
  shells?: Record<string, Shell>;
  steps?: string[];
  durationMs?: number;
}

export interface Conversation {
  id: string;
  // Claude Code session; follow-ups attach to it with --resume.
  sessionId: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  // Web search, effort and tools; can change mid-chat.
  options?: RequestOptions;
}

// Chat contents live in files; LocalStorage only keeps a small index because
// Raycast extensions have a 100 MB memory limit.
const INDEX_KEY = "conversation-index";

function dir(): string {
  const d = join(environment.supportPath, "conversations");
  mkdirSync(d, { recursive: true });
  return d;
}

export type ConversationSummary = Pick<
  Conversation,
  "id" | "title" | "model" | "updatedAt"
>;

export async function listConversations(): Promise<ConversationSummary[]> {
  const raw = await LocalStorage.getItem<string>(INDEX_KEY);
  const index: ConversationSummary[] = raw ? JSON.parse(raw) : [];
  return index.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadConversation(id: string): Conversation | undefined {
  try {
    return JSON.parse(readFileSync(join(dir(), `${id}.json`), "utf8"));
  } catch {
    return undefined;
  }
}

export async function saveConversation(c: Conversation): Promise<void> {
  writeFileSync(join(dir(), `${c.id}.json`), JSON.stringify(c));
  const index = (await listConversations()).filter((s) => s.id !== c.id);
  index.push({
    id: c.id,
    title: c.title,
    model: c.model,
    updatedAt: c.updatedAt,
  });
  await LocalStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

export async function deleteConversation(id: string): Promise<void> {
  rmSync(join(dir(), `${id}.json`), { force: true });
  const index = (await listConversations()).filter((s) => s.id !== id);
  await LocalStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

export function newConversation(
  model: string,
  options?: RequestOptions,
): Conversation {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    title: "",
    model,
    createdAt: now,
    updatedAt: now,
    messages: [],
    options,
  };
}

export function titleFrom(question: string): string {
  const line = question.trim().split("\n")[0];
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

const RATE_KEY = "last-rate-limit";

export async function saveRateLimit(r: RateLimit | undefined): Promise<void> {
  if (r) await LocalStorage.setItem(RATE_KEY, JSON.stringify(r));
}

export async function loadRateLimit(): Promise<RateLimit | undefined> {
  const raw = await LocalStorage.getItem<string>(RATE_KEY);
  return raw ? JSON.parse(raw) : undefined;
}
