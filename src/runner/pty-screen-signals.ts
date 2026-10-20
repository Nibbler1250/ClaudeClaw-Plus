/**
 * What a CI log may say about a PTY screen: flags, fixed reason names and counts, never a
 * character of the text. The repo is public, so its CI logs are public, and no redaction of
 * arbitrary terminal text can be complete (#570 r14d, M1). The integration harness prints only
 * the object this returns.
 */

import { BLOCKED_BOOT_SCREENS, REPL_FOOTER } from "./pty-process.js";

export interface ScreenSignals {
  /** Non-blank lines in the captured text. */
  lines: number;
  permissionPrompt: boolean;
  errorBanner: boolean;
  spinner: boolean;
  /** Name of the first blocked boot screen the text matches, else "none". */
  blocked: string;
  /** The idle REPL footer is on screen. */
  ready: boolean;
}

/** Flags are computed on the whole text, so one sensitive word cannot hide a line. */
export function screenSignals(raw: string): ScreenSignals {
  const text = raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .slice(-40)
    .join("\n");
  return {
    lines: text === "" ? 0 : text.split("\n").length,
    permissionPrompt: /do you want|allow (?:this|once)|approve|\(y\/n\)|1\. yes/i.test(text),
    errorBanner: /error|failed|unable to|rate limit|overloaded|invalid/i.test(text),
    spinner: /esc to interrupt|thinking|[✻✽✶✳✢]/i.test(text),
    blocked: BLOCKED_BOOT_SCREENS.find(([, pattern]) => pattern.test(text))?.[0] ?? "none",
    ready: REPL_FOOTER.test(text),
  };
}

/** The one CI line for a captured screen. Built only from `ScreenSignals` and fixed words. */
export function screenLogLine(label: string, source: string, signals: ScreenSignals): string {
  return `[isolation-spike] screen-signals ${label}: ${JSON.stringify(signals)}; source=${source}`;
}

/** Words a CI line may carry from the child's side: short, plain, or the fixed word "other". */
const PLAIN_WORD = /^[A-Za-z0-9_.<>-]{1,32}$/;

/** A record type, stop reason, path segment or the like, kept only when it is a short plain word. */
export function plainWord(value: unknown): string {
  const text = String(value);
  return PLAIN_WORD.test(text) ? text : "other";
}

/** The classifier action, as one of the words the harness knows: `hire`, any other (`other`), or `none`. */
export function actionWord(action: string | undefined): string {
  if (action === undefined) return "none";
  return action === "hire" ? "hire" : "other";
}

/** An error as an errno code or class name, stripped to plain characters. Never its message. */
export function errorWord(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code ?? (error as Error)?.name ?? "error";
  return (
    String(code)
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 32) || "error"
  );
}

/** argv for a CI line: prompt text (`--system-prompt`, `--append-system-prompt`) becomes its length. */
export function argvShape(args: readonly string[]): string[] {
  return args.map((arg, i) =>
    /^--(append-)?system-prompt$/.test(args[i - 1] ?? "") ? `<${arg.length} chars>` : arg,
  );
}

/** A production warning line with the names of throwaway directories removed. */
export function withoutDirNames(line: string): string {
  return line.replace(/\bclaudeclaw-oneshot-[A-Za-z0-9-]+/g, "<dir>");
}
