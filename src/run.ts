import type { QarmiqCiClient } from "./client.js";
import { ACTIVE_STATES, QarmiqRefusal, type RunStatus, type StartRequest, type StartResponse } from "./types.js";

export interface RunOptions {
  triggerId: string;
  request?: StartRequest;
  // How long each status read is held open on the server. Qarmiq caps it; 25 is safe.
  waitSeconds?: number;
  // Called after the start and after every status read, for a pipeline's log or a check's summary. Awaited, so a caller that reports
  // somewhere (a check run) finishes one report before the next read.
  onStart?: (started: StartResponse) => void | Promise<void>;
  onStatus?: (status: RunStatus) => void | Promise<void>;
  // Aborted when the pipeline stops waiting (its job was cancelled): the run is then cancelled on the server too.
  signal?: AbortSignal;
  // For tests: how to wait between reads.
  sleep?: (ms: number) => Promise<void>;
}

export interface RunOutcome {
  started: StartResponse;
  status: RunStatus;
}

// How many status reads in a row may fail before the wait is given up. A pipeline that lost one poll should not lose the verdict.
const MAX_READ_FAILURES = 5;

// Starts the trigger's run and waits until it is over: the one sequence every CI does. Nothing here decides pass or fail; the verdict is
// Qarmiq's, read back as the server wrote it.
export async function runTrigger(client: QarmiqCiClient, options: RunOptions): Promise<RunOutcome> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = await client.start(options.triggerId, options.request ?? {});
  await options.onStart?.(started);
  const waitSeconds = options.waitSeconds ?? 25;
  let failures = 0;
  for (;;) {
    if (options.signal?.aborted) {
      const status = await client.cancel(started.run.id);
      await options.onStatus?.(status);
      return { started, status };
    }
    let status: RunStatus;
    try {
      status = await client.status(started.run.id, waitSeconds);
      failures = 0;
    } catch (error) {
      // A refusal the server explained (a revoked token, a run it does not know) will not change by asking again.
      if (error instanceof QarmiqRefusal && error.status !== 429 && error.status < 500) throw error;
      failures += 1;
      if (failures >= MAX_READ_FAILURES) throw error;
      const retryAfter = error instanceof QarmiqRefusal && error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : 0;
      await sleep(Math.max(retryAfter, Math.min(30_000, 2_000 * 2 ** (failures - 1))));
      continue;
    }
    await options.onStatus?.(status);
    if (!ACTIVE_STATES.has(status.state)) return { started, status };
    // The server held the read open already; with no wait asked for, a short pause keeps this from becoming a tight loop.
    if (waitSeconds <= 0) await sleep(2_000);
  }
}

// What a pipeline does with the verdict. "review" is Qarmiq's "allowed, a person should look": a success with a warning, unless the
// pipeline asked for it to fail.
export function exitCodeFor(status: RunStatus, onReview: "allow" | "fail" = "allow"): 0 | 1 {
  if (status.verdict === "go") return 0;
  if (status.verdict === "review") return onReview === "fail" ? 1 : 0;
  // stop, or a run that ended with no verdict (cancelled, superseded): never a pass.
  return 1;
}

// The verdict and its scenarios in a few plain lines, for a pipeline's log.
export function describeStatus(status: RunStatus): string {
  const head = status.verdict ? `${status.verdict}: ${status.reason ?? ""}`.trim() : `${status.state}${status.reason ? `: ${status.reason}` : ""}`;
  // A scenario with no verdict is still pending while the run goes on; once the run is over, it ended without a result.
  const none = ACTIVE_STATES.has(status.state) ? "pending" : "no result";
  const lines = status.scenarios.map((s) => `  ${(s.verdict ?? none).padEnd(12)} ${s.ref}  ${s.statement}`);
  return [head, ...lines, `Run: ${status.run.url}`].join("\n");
}
