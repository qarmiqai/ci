#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./args.js";
import { compact, detectBuild } from "./ci-environment.js";
import { QarmiqCiClient } from "./client.js";
import { describeStatus, exitCodeFor, runTrigger } from "./run.js";
import { QarmiqRefusal } from "./types.js";

const DEFAULT_URL = "https://app.qarmiq.ai";

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

// `qarmiq-ci run --trigger <id>`: start the trigger's run, wait for it, print the verdict, exit by it. Everything the CI already knows
// (commit, branch, where the pipeline run lives) is read from its environment when not given, so the common call is the trigger alone.
export async function main(argv: readonly string[], env: Record<string, string | undefined>, io: CliIo): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    io.err(args.error);
    return 2;
  }
  const token = env.QARMIQ_CI_TOKEN;
  if (!token) {
    io.err("QARMIQ_CI_TOKEN is not set: add the trigger's token to your CI's secrets and expose it to this step.");
    return 2;
  }
  const detected = detectBuild(env);
  const request = compact({
    environment: args.environment,
    sha: args.sha ?? detected.sha,
    ref: args.ref ?? detected.ref,
    rerun: args.rerun || undefined,
    source: compact({ ...detected.source, ...args.source }),
  });
  const client = new QarmiqCiClient({ baseUrl: env.QARMIQ_URL || DEFAULT_URL, token, fetch: io.fetch });
  try {
    const { status } = await runTrigger(client, {
      triggerId: args.trigger,
      request,
      waitSeconds: args.wait,
      signal: io.signal,
      sleep: io.sleep,
      onStart: (started) => io.out(`${started.deduplicated ? "Already started for this commit" : "Started"} ${started.run.key}: ${started.run.url}`),
    });
    io.out(describeStatus(status));
    if (status.verdict === "review" && args.onReview === "allow") io.out("Qarmiq could not decide every scenario; a person should look.");
    return exitCodeFor(status, args.onReview);
  } catch (error) {
    if (error instanceof QarmiqRefusal) {
      const retry = error.retryAfterSeconds ? ` Try again in ${error.retryAfterSeconds} s.` : "";
      io.err(`Qarmiq refused (${error.code}): ${error.message}${retry}`);
      return 2;
    }
    io.err(`Could not reach Qarmiq: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

// Run as a program (the bin), not when imported by tests or the GitHub action.
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // The entry path cannot be resolved (it was deleted, or is not a file): this module is not the program.
    return false;
  }
}

if (invokedDirectly()) {
  const controller = new AbortController();
  // A cancelled CI job sends SIGTERM (or SIGINT locally): stop waiting and cancel the run on Qarmiq, then exit by what it answers.
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  main(process.argv.slice(2), process.env, { out: (l) => console.log(l), err: (l) => console.error(l), signal: controller.signal }).then((code) => process.exit(code));
}
