import { compact, detectBuild } from "../../src/ci-environment.js";
import { QarmiqCiClient } from "../../src/client.js";
import { runTrigger } from "../../src/run.js";
import { QarmiqRefusal, type RunStatus } from "../../src/types.js";
import { GitHubApi } from "./github-api.js";
import { commentMarker, conclusionFor, renderReport, title } from "./report.js";
import { annotate, appendSummary, booleanInput, input, maskValue, pullRequestOf, setOutput, type Env } from "./runtime.js";

export interface Deps {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  readFile?: (path: string) => string;
}

// The action: the package's start-and-wait, plus what only GitHub has: a check run on the commit (neutral for review), one comment on the
// pull request edited in place, the job summary and the step's outputs. A permission the job's token lacks is said once as a warning and
// that part is skipped; the verdict still decides the step.
export async function run(env: Env, deps: Deps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  let token: string, triggerId: string, onReview: "neutral" | "fail", rerun: boolean, comment: boolean;
  try {
    token = input(env, "token", { required: true });
    maskValue(token, log);
    triggerId = input(env, "trigger", { required: true });
    const review = input(env, "on-review") || "neutral";
    if (review !== "neutral" && review !== "fail") throw new Error(`Input on-review is neutral or fail, not "${review}"`);
    onReview = review;
    rerun = booleanInput(env, "rerun");
    comment = env.INPUT_COMMENT === undefined ? true : booleanInput(env, "comment");
  } catch (error) {
    annotate("error", (error as Error).message, log);
    return 1;
  }
  const checkName = input(env, "check-name") || "Qarmiq";
  const githubToken = input(env, "github-token");

  const pr = pullRequestOf(env, deps.readFile);
  const detected = detectBuild(env);
  const request = compact({
    environment: input(env, "environment") || undefined,
    // On a pull request, the commit the author pushed, not the merge commit GitHub made.
    sha: pr?.headSha ?? detected.sha,
    ref: pr?.headRef ?? detected.ref,
    rerun: rerun || undefined,
    source: compact({ ...detected.source, pr: pr ? String(pr.number) : detected.source.pr }),
  });

  const github = githubToken && env.GITHUB_REPOSITORY ? new GitHubApi(env.GITHUB_API_URL || "https://api.github.com", env.GITHUB_REPOSITORY, githubToken, deps.fetch) : null;
  let checkId: number | null = null;
  let checkWarned = false;
  const warnCheck = (message: string) => {
    if (checkWarned) return;
    checkWarned = true;
    annotate("warning", `Could not report the "${checkName}" check (${message}). Give the job \`permissions: checks: write\` to see it on the commit; the verdict still decides this step.`, log);
  };

  const client = new QarmiqCiClient({ baseUrl: input(env, "qarmiq-url") || "https://app.qarmiq.ai", token, fetch: deps.fetch });
  let final: RunStatus;
  try {
    ({ status: final } = await runTrigger(client, {
      triggerId,
      request,
      signal: deps.signal,
      sleep: deps.sleep,
      onStart: (started) => {
        log(`${started.deduplicated ? "Already started for this commit" : "Started"} ${started.run.key}: ${started.run.url}`);
      },
      onStatus: async (status) => {
        if (!github || !request.sha || checkWarned) return;
        const body = { title: title(status), summary: renderReport(status), detailsUrl: status.run.url };
        const result = checkId === null ? await github.createCheckRun({ name: checkName, headSha: request.sha, ...body }) : await github.updateCheckRun(checkId, body);
        if (result.ok) checkId = result.value.id;
        else warnCheck(result.message);
      },
    }));
  } catch (error) {
    const message = error instanceof QarmiqRefusal ? `Qarmiq refused (${error.code}): ${error.message}${error.retryAfterSeconds ? ` Try again in ${error.retryAfterSeconds} s.` : ""}` : `Could not reach Qarmiq: ${error instanceof Error ? error.message : String(error)}`;
    annotate("error", message, log);
    if (github && checkId !== null) await github.updateCheckRun(checkId, { title: "Could not finish", summary: message, conclusion: "failure" });
    return 1;
  }

  const report = renderReport(final);
  log(report);
  appendSummary(env, report);
  setOutput(env, "verdict", final.verdict ?? "");
  setOutput(env, "run-url", final.run.url);
  setOutput(env, "run-key", final.run.key);

  const conclusion = conclusionFor(final, onReview);
  if (github && request.sha && !checkWarned) {
    const body = { title: title(final), summary: report, detailsUrl: final.run.url, conclusion };
    const result = checkId === null ? await github.createCheckRun({ name: checkName, headSha: request.sha, ...body }) : await github.updateCheckRun(checkId, body);
    // A check is created in progress; a finished run seen on the first read still has to be completed.
    if (result.ok && checkId === null) await github.updateCheckRun(result.value.id, body);
    if (!result.ok) warnCheck(result.message);
  }
  if (github && pr && comment) {
    const posted = await github.upsertComment(pr.number, commentMarker(triggerId), report);
    if (!posted.ok) annotate("warning", `Could not comment on pull request #${pr.number} (${posted.message}). Give the job \`permissions: pull-requests: write\`, or set comment: false.`, log);
  }

  if (final.verdict === "stop") annotate("error", `Qarmiq: ${final.reason ?? "a scenario failed"}. ${final.run.url}`, log);
  else if (final.verdict === "review") annotate("warning", `Qarmiq could not decide every scenario: ${final.reason ?? ""}. A person should look: ${final.run.url}`, log);
  else if (!final.verdict) annotate("error", `Qarmiq's run ended without a verdict (${final.state}). ${final.run.url}`, log);
  return conclusion === "success" || conclusion === "neutral" ? 0 : 1;
}
