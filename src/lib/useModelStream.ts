import { useCallback, useEffect, useRef, useState } from "react";
import { runModel } from "./run";
import {
  DeniedCommand,
  ModelError,
  PermissionAnswer,
  PermissionRequest,
  RateLimit,
  RunOptions,
  RunResult,
} from "./types";
import { saveRateLimit } from "./storage";

// A setState per delta makes Raycast visibly lag; buffer the text in a ref and
// flush it at this interval.
const FLUSH_MS = 80;

export interface StreamState {
  text: string;
  isLoading: boolean;
  error?: ModelError;
  rateLimit?: RateLimit;
  durationMs?: number;
  commands?: string[];
  denied?: DeniedCommand[];
  steps?: string[];
  // Shell commands waiting for the user's answer while the model works,
  // oldest first.
  approvals?: PermissionRequest[];
}

export function useModelStream() {
  const [state, setState] = useState<StreamState>({
    text: "",
    isLoading: false,
  });
  const controller = useRef<AbortController | undefined>(undefined);
  const buffer = useRef("");
  const stepsBuffer = useRef<string[] | undefined>(undefined);
  const timer = useRef<NodeJS.Timeout | undefined>(undefined);
  // Answers for the pending approvals, by tool call id.
  const answers = useRef(new Map<string, (answer: PermissionAnswer) => void>());

  const stop = useCallback(() => controller.current?.abort(), []);

  // Leaving the view (Esc) stops the running request.
  useEffect(() => stop, [stop]);

  const respond = useCallback((id: string, answer: PermissionAnswer) => {
    const resolve = answers.current.get(id);
    if (!resolve) return;
    answers.current.delete(id);
    setState((s) => ({
      ...s,
      approvals: s.approvals?.filter((a) => a.id !== id),
    }));
    resolve(answer);
  }, []);

  // Unanswered approvals of a finished or stopped run are declined; the
  // process is gone, so nothing is sent.
  const dropApprovals = () => {
    for (const resolve of answers.current.values()) resolve({ allow: false });
    answers.current.clear();
  };

  const run = useCallback(
    async (opts: Omit<RunOptions, "signal" | "onText">): Promise<RunResult> => {
      controller.current?.abort();
      dropApprovals();
      const ac = new AbortController();
      controller.current = ac;
      buffer.current = "";
      stepsBuffer.current = undefined;
      setState({ text: "", isLoading: true });

      timer.current = setInterval(() => {
        setState((s) =>
          s.text === buffer.current && s.steps === stepsBuffer.current
            ? s
            : { ...s, text: buffer.current, steps: stepsBuffer.current },
        );
      }, FLUSH_MS);

      const result = await runModel({
        ...opts,
        signal: ac.signal,
        onText: (t) => (buffer.current = t),
        onSteps: (s) => (stepsBuffer.current = s),
        onPermission: (request) =>
          new Promise<PermissionAnswer>((resolve) => {
            if (ac.signal.aborted) return resolve({ allow: false });
            answers.current.set(request.id, resolve);
            setState((s) => ({
              ...s,
              // The text so far, so the question shows with its context.
              text: buffer.current,
              steps: stepsBuffer.current,
              approvals: [...(s.approvals ?? []), request],
            }));
          }),
      });
      clearInterval(timer.current);
      if (controller.current === ac) dropApprovals();
      await saveRateLimit(result.rateLimit);

      if (controller.current === ac) {
        setState({
          text: result.text,
          isLoading: false,
          error: result.error,
          rateLimit: result.rateLimit,
          durationMs: result.durationMs,
          commands: result.commands,
          denied: result.denied,
          steps: result.steps,
        });
      }
      return result;
    },
    [],
  );

  const allow = useCallback(
    (id: string) => respond(id, { allow: true }),
    [respond],
  );
  // A note tells Claude what to do instead; it goes on in the same turn.
  const deny = useCallback(
    (id: string, note?: string) =>
      respond(id, { allow: false, note: note?.trim() || undefined }),
    [respond],
  );

  return { ...state, run, stop, allow, deny };
}
