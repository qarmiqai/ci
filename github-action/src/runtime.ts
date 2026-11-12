import { appendFileSync, readFileSync } from "node:fs";
import { EOL } from "node:os";
import { randomUUID } from "node:crypto";

// The parts of the GitHub Actions runtime this action uses, by the runner's documented conventions (inputs as INPUT_* variables,
// outputs and the job summary as files the runner names, annotations as workflow commands), so it needs no toolkit dependency.

export type Env = Record<string, string | undefined>;

export function input(env: Env, name: string, options: { required?: boolean } = {}): string {
  const value = (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
  if (options.required && !value) throw new Error(`Input required and not supplied: ${name}`);
  return value;
}

export function booleanInput(env: Env, name: string): boolean {
  const value = input(env, name).toLowerCase();
  if (value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`Input ${name} is true or false, not "${value}"`);
}

// A multi-line value is written with a random delimiter, so text in the value can never end it early.
function appendKeyValue(file: string, key: string, value: string): void {
  const delimiter = `qarmiq_${randomUUID()}`;
  appendFileSync(file, `${key}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`);
}

export function setOutput(env: Env, name: string, value: string): void {
  if (env.GITHUB_OUTPUT) appendKeyValue(env.GITHUB_OUTPUT, name, value);
}

export function appendSummary(env: Env, markdown: string): void {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}${EOL}`);
}

// A workflow command's message is escaped as the runner requires, so a newline or "%" in it cannot start another command.
function escapeData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function annotate(level: "warning" | "error" | "notice", message: string, write: (line: string) => void = (l) => process.stdout.write(l + EOL)): void {
  write(`::${level}::${escapeData(message)}`);
}

// Keeps a value out of the job's log from here on, should anything echo it.
export function maskValue(value: string, write: (line: string) => void = (l) => process.stdout.write(l + EOL)): void {
  if (value) write(`::add-mask::${escapeData(value)}`);
}

export interface PullRequestEvent {
  number: number;
  headSha: string;
  headRef: string;
}

// The pull request this run is for, from the event the workflow was triggered by. GITHUB_SHA on a pull request is the merge commit
// GitHub made, not the commit the author pushed, so the head's own sha is what is tested and what the check is reported on.
export function pullRequestOf(env: Env, readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): PullRequestEvent | null {
  if (!env.GITHUB_EVENT_PATH) return null;
  try {
    const event = JSON.parse(readFile(env.GITHUB_EVENT_PATH)) as { pull_request?: { number?: unknown; head?: { sha?: unknown; ref?: unknown } } };
    const pr = event.pull_request;
    if (!pr || typeof pr.number !== "number" || typeof pr.head?.sha !== "string" || typeof pr.head.ref !== "string") return null;
    return { number: pr.number, headSha: pr.head.sha, headRef: pr.head.ref };
  } catch {
    // An unreadable or malformed event file: treated as no pull request, so the run still happens with what the variables say.
    return null;
  }
}
