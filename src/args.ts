import type { RunSource } from "./types.js";

export const USAGE = `usage: qarmiq-ci run --trigger <id> [options]

options:
  --environment <name>     test another of the project's saved environments than the trigger's own
  --sha <commit>           the commit being tested (read from the CI when it can be)
  --ref <branch>           the branch or tag (read from the CI when it can be)
  --rerun                  start a fresh run even if this commit was already started
  --on-review allow|fail   what "review" (undecided) does to the exit code; allow by default
  --wait <seconds>         how long each status read is held open; 25 by default
  --source-repo <repo>  --source-pr <n>  --source-url <url>  --source-provider <name>  --source-actor <who>

environment:
  QARMIQ_CI_TOKEN   the trigger's token (required)
  QARMIQ_URL        the Qarmiq origin (default https://app.qarmiq.ai)

exit: 0 go (and review, unless --on-review fail), 1 stop or no verdict, 2 could not run`;

export interface CliArgs {
  trigger: string;
  environment?: string;
  sha?: string;
  ref?: string;
  rerun: boolean;
  onReview: "allow" | "fail";
  wait: number;
  source: RunSource;
}

const SOURCE_FLAGS: Record<string, keyof RunSource> = {
  "--source-provider": "provider",
  "--source-repo": "repo",
  "--source-pr": "pr",
  "--source-url": "url",
  "--source-actor": "actor",
};

export function parseArgs(argv: readonly string[]): CliArgs | { error: string } {
  const [command, ...rest] = argv;
  if (command !== "run") return { error: USAGE };
  let trigger: string | undefined;
  const parsed: Omit<CliArgs, "trigger"> = { rerun: false, onReview: "allow", wait: 25, source: {} };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag === "--rerun") {
      parsed.rerun = true;
      continue;
    }
    if (flag === "--help" || flag === "-h") return { error: USAGE };
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value\n\n${USAGE}` };
    i += 1;
    if (flag === "--trigger") trigger = value;
    else if (flag === "--environment") parsed.environment = value;
    else if (flag === "--sha") parsed.sha = value;
    else if (flag === "--ref") parsed.ref = value;
    else if (flag === "--on-review") {
      if (value !== "allow" && value !== "fail") return { error: `--on-review is allow or fail, not "${value}"` };
      parsed.onReview = value;
    } else if (flag === "--wait") {
      const seconds = Number(value);
      if (!Number.isInteger(seconds) || seconds < 0) return { error: `--wait is a whole number of seconds, not "${value}"` };
      parsed.wait = seconds;
    } else if (SOURCE_FLAGS[flag]) parsed.source[SOURCE_FLAGS[flag]] = value;
    else return { error: `unknown option ${flag}\n\n${USAGE}` };
  }
  if (!trigger) return { error: `--trigger is required\n\n${USAGE}` };
  return { trigger, ...parsed };
}
