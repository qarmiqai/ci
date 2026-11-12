// src/ci-environment.ts
function detectBuild(env) {
  if (env.GITHUB_ACTIONS === "true") {
    const pr = env.GITHUB_REF?.match(/^refs\/pull\/(\d+)\//)?.[1];
    const url = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : void 0;
    return {
      sha: env.GITHUB_SHA,
      // On a pull request GITHUB_REF_NAME is "<n>/merge"; the branch the change lives on is GITHUB_HEAD_REF.
      ref: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME,
      source: compact({ provider: "github", repo: env.GITHUB_REPOSITORY, pr, url, actor: env.GITHUB_ACTOR })
    };
  }
  if (env.GITLAB_CI === "true") {
    return {
      sha: env.CI_COMMIT_SHA,
      ref: env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME || env.CI_COMMIT_REF_NAME,
      source: compact({ provider: "gitlab", repo: env.CI_PROJECT_PATH, pr: env.CI_MERGE_REQUEST_IID, url: env.CI_JOB_URL, actor: env.GITLAB_USER_LOGIN })
    };
  }
  if (env.BITBUCKET_BUILD_NUMBER) {
    const url = env.BITBUCKET_GIT_HTTP_ORIGIN && env.BITBUCKET_BUILD_NUMBER ? `${env.BITBUCKET_GIT_HTTP_ORIGIN}/pipelines/results/${env.BITBUCKET_BUILD_NUMBER}` : void 0;
    return {
      sha: env.BITBUCKET_COMMIT,
      ref: env.BITBUCKET_BRANCH,
      source: compact({ provider: "bitbucket", repo: env.BITBUCKET_REPO_FULL_NAME, pr: env.BITBUCKET_PR_ID, url })
    };
  }
  return { source: {} };
}
function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== void 0 && v !== ""));
}

// src/types.ts
var QarmiqRefusal = class extends Error {
  constructor(status, code, message, retryAfterSeconds) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.name = "QarmiqRefusal";
  }
};
var ACTIVE_STATES = /* @__PURE__ */ new Set(["queued", "running"]);

// src/client.ts
var QarmiqCiClient = class {
  baseUrl;
  token;
  fetchImpl;
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }
  async start(triggerId, request = {}) {
    const url = `${this.baseUrl}/api/ci/triggers/${encodeURIComponent(triggerId)}/runs`;
    return await this.call(url, { method: "POST", body: JSON.stringify(request) });
  }
  // One read, held open on the server for up to `waitSeconds` while the run is still in flight.
  async status(runId, waitSeconds = 0) {
    const url = new URL(`${this.baseUrl}/api/ci/runs/${encodeURIComponent(runId)}`);
    if (waitSeconds > 0) url.searchParams.set("wait", String(Math.floor(waitSeconds)));
    return await this.call(url.toString(), { method: "GET" });
  }
  async cancel(runId) {
    const url = `${this.baseUrl}/api/ci/runs/${encodeURIComponent(runId)}`;
    return await this.call(url, { method: "DELETE" });
  }
  async call(url, init) {
    const headers = new Headers({ authorization: `Bearer ${this.token}`, accept: "application/json" });
    if (init.body !== void 0) headers.set("content-type", "application/json");
    const response = await this.fetchImpl(url, { ...init, headers });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
      }
    }
    if (response.ok) return body;
    const explained = body ?? {};
    const fallbackCode = response.status === 401 ? "unauthorized" : response.status === 404 ? "not_found" : `http_${response.status}`;
    const hasCode = typeof explained.message === "string";
    const code = hasCode && typeof explained.error === "string" ? explained.error : fallbackCode;
    const message = hasCode ? explained.message : typeof explained.error === "string" ? explained.error : `Qarmiq answered ${response.status}`;
    const header = Number(response.headers.get("retry-after"));
    const retryAfter = typeof explained.retry_after === "number" ? explained.retry_after : Number.isFinite(header) && header > 0 ? header : null;
    throw new QarmiqRefusal(response.status, code, message, retryAfter);
  }
};

// src/run.ts
var MAX_READ_FAILURES = 5;
async function runTrigger(client, options) {
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = await client.start(options.triggerId, options.request ?? {});
  await options.onStart?.(started);
  const waitSeconds = options.waitSeconds ?? 25;
  let failures = 0;
  for (; ; ) {
    if (options.signal?.aborted) {
      const status2 = await client.cancel(started.run.id);
      await options.onStatus?.(status2);
      return { started, status: status2 };
    }
    let status;
    try {
      status = await client.status(started.run.id, waitSeconds);
      failures = 0;
    } catch (error) {
      if (error instanceof QarmiqRefusal && error.status !== 429 && error.status < 500) throw error;
      failures += 1;
      if (failures >= MAX_READ_FAILURES) throw error;
      const retryAfter = error instanceof QarmiqRefusal && error.retryAfterSeconds ? error.retryAfterSeconds * 1e3 : 0;
      await sleep(Math.max(retryAfter, Math.min(3e4, 2e3 * 2 ** (failures - 1))));
      continue;
    }
    await options.onStatus?.(status);
    if (!ACTIVE_STATES.has(status.state)) return { started, status };
    if (waitSeconds <= 0) await sleep(2e3);
  }
}

// github-action/src/github-api.ts
var MAX_OUTPUT_CHARS = 6e4;
var MAX_COMMENT_PAGES = 10;
var GitHubApi = class {
  constructor(apiUrl, repository, token, fetchImpl = fetch) {
    this.apiUrl = apiUrl;
    this.repository = repository;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }
  createCheckRun(input2) {
    return this.call("POST", `/repos/${this.repository}/check-runs`, {
      name: input2.name,
      head_sha: input2.headSha,
      status: "in_progress",
      ...input2.detailsUrl ? { details_url: input2.detailsUrl } : {},
      output: output(input2.title, input2.summary)
    });
  }
  updateCheckRun(id, input2) {
    return this.call("PATCH", `/repos/${this.repository}/check-runs/${id}`, {
      ...input2.detailsUrl ? { details_url: input2.detailsUrl } : {},
      ...input2.conclusion ? { status: "completed", conclusion: input2.conclusion } : { status: "in_progress" },
      output: output(input2.title, input2.summary)
    });
  }
  // Edits the comment that carries `marker`, or adds one when there is none: one comment per trigger on a pull request, however many
  // pushes it sees.
  async upsertComment(issueNumber, marker, body) {
    const full = `${marker}
${body}`;
    for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
      const listed = await this.call("GET", `/repos/${this.repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`);
      if (!listed.ok) return listed;
      const mine = listed.value.find((c) => typeof c.body === "string" && c.body.startsWith(marker));
      if (mine) {
        const edited = await this.call("PATCH", `/repos/${this.repository}/issues/comments/${mine.id}`, { body: full });
        return edited.ok ? { ok: true, value: { id: edited.value.id, created: false } } : edited;
      }
      if (listed.value.length < 100) break;
    }
    const created = await this.call("POST", `/repos/${this.repository}/issues/${issueNumber}/comments`, { body: full });
    return created.ok ? { ok: true, value: { id: created.value.id, created: true } } : created;
  }
  async call(method, path, body) {
    let response;
    try {
      response = await this.fetchImpl(`${this.apiUrl.replace(/\/+$/, "")}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...body === void 0 ? {} : { "content-type": "application/json" }
        },
        body: body === void 0 ? void 0 : JSON.stringify(body)
      });
    } catch (error) {
      return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) };
    }
    const text = await response.text();
    if (!response.ok) {
      let message = `GitHub answered ${response.status}`;
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed.message === "string") message = parsed.message;
      } catch {
      }
      return { ok: false, status: response.status, message };
    }
    return { ok: true, value: text ? JSON.parse(text) : null };
  }
};
function output(title2, summary) {
  const cut = summary.length > MAX_OUTPUT_CHARS ? `${summary.slice(0, MAX_OUTPUT_CHARS)}

\u2026cut here; the full result is on the run's page in Qarmiq.` : summary;
  return { title: title2, summary: cut };
}

// github-action/src/report.ts
var VERDICT_TITLE = { go: "Go: every scenario passed", stop: "Stop: a scenario failed", review: "Review: a person should look" };
var SCENARIO_MARK = { passed: "\u2705 passed", failed: "\u274C failed", inconclusive: "\u26A0\uFE0F undecided", pending: "\u23F3 pending", none: "\u2796 no result" };
var commentMarker = (triggerId) => `<!-- qarmiq-ci trigger:${triggerId} -->`;
function cell(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
function title(status) {
  if (status.verdict) return VERDICT_TITLE[status.verdict];
  if (status.state === "queued" || status.state === "running") return "Testing\u2026";
  if (status.state === "superseded") return "Replaced by a newer run";
  if (status.state === "cancelled") return "Cancelled";
  return `Ended without a verdict (${status.state})`;
}
function renderReport(status, options = {}) {
  const { summary } = status;
  const running = ACTIVE_STATES.has(status.state);
  const counts = [
    summary.passed ? `${summary.passed} passed` : null,
    summary.failed ? `${summary.failed} failed` : null,
    summary.inconclusive ? `${summary.inconclusive} undecided` : null,
    summary.pending ? `${summary.pending} ${running ? "pending" : "with no result"}` : null
  ].filter(Boolean);
  const lines = [
    `### Qarmiq: ${title(status)}`,
    "",
    [status.reason ? cell(status.reason) : null, counts.length ? `${counts.join(", ")} of ${summary.scenarios}` : null].filter(Boolean).join(" \xB7 "),
    "",
    "| Result | Scenario | Promise |",
    "|---|---|---|",
    ...status.scenarios.map((s) => `| ${SCENARIO_MARK[s.verdict ?? (running ? "pending" : "none")]} | \`${cell(s.ref)}\` | ${cell(s.statement)} |`),
    "",
    `[Open ${cell(status.run.key)} in Qarmiq](${status.run.url})${options.triggerName ? ` \xB7 trigger ${cell(options.triggerName)}` : ""}`
  ];
  return lines.join("\n");
}
function conclusionFor(status, onReview) {
  if (status.verdict === "go") return "success";
  if (status.verdict === "stop") return "failure";
  if (status.verdict === "review") return onReview === "fail" ? "failure" : "neutral";
  if (status.state === "cancelled" || status.state === "superseded") return "cancelled";
  return "failure";
}

// github-action/src/runtime.ts
import { appendFileSync, readFileSync } from "node:fs";
import { EOL } from "node:os";
import { randomUUID } from "node:crypto";
function input(env, name, options = {}) {
  const value = (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
  if (options.required && !value) throw new Error(`Input required and not supplied: ${name}`);
  return value;
}
function booleanInput(env, name) {
  const value = input(env, name).toLowerCase();
  if (value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`Input ${name} is true or false, not "${value}"`);
}
function appendKeyValue(file, key, value) {
  const delimiter = `qarmiq_${randomUUID()}`;
  appendFileSync(file, `${key}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`);
}
function setOutput(env, name, value) {
  if (env.GITHUB_OUTPUT) appendKeyValue(env.GITHUB_OUTPUT, name, value);
}
function appendSummary(env, markdown) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}${EOL}`);
}
function escapeData(text) {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function annotate(level, message, write = (l) => process.stdout.write(l + EOL)) {
  write(`::${level}::${escapeData(message)}`);
}
function maskValue(value, write = (l) => process.stdout.write(l + EOL)) {
  if (value) write(`::add-mask::${escapeData(value)}`);
}
function pullRequestOf(env, readFile = (p) => readFileSync(p, "utf8")) {
  if (!env.GITHUB_EVENT_PATH) return null;
  try {
    const event = JSON.parse(readFile(env.GITHUB_EVENT_PATH));
    const pr = event.pull_request;
    if (!pr || typeof pr.number !== "number" || typeof pr.head?.sha !== "string" || typeof pr.head.ref !== "string") return null;
    return { number: pr.number, headSha: pr.head.sha, headRef: pr.head.ref };
  } catch {
    return null;
  }
}

// github-action/src/main.ts
async function run(env, deps = {}) {
  const log = deps.log ?? ((line) => process.stdout.write(`${line}
`));
  let token, triggerId, onReview, rerun, comment;
  try {
    token = input(env, "token", { required: true });
    maskValue(token, log);
    triggerId = input(env, "trigger", { required: true });
    const review = input(env, "on-review") || "neutral";
    if (review !== "neutral" && review !== "fail") throw new Error(`Input on-review is neutral or fail, not "${review}"`);
    onReview = review;
    rerun = booleanInput(env, "rerun");
    comment = env.INPUT_COMMENT === void 0 ? true : booleanInput(env, "comment");
  } catch (error) {
    annotate("error", error.message, log);
    return 1;
  }
  const checkName = input(env, "check-name") || "Qarmiq";
  const githubToken = input(env, "github-token");
  const pr = pullRequestOf(env, deps.readFile);
  const detected = detectBuild(env);
  const request = compact({
    environment: input(env, "environment") || void 0,
    // On a pull request, the commit the author pushed, not the merge commit GitHub made.
    sha: pr?.headSha ?? detected.sha,
    ref: pr?.headRef ?? detected.ref,
    rerun: rerun || void 0,
    source: compact({ ...detected.source, pr: pr ? String(pr.number) : detected.source.pr })
  });
  const github = githubToken && env.GITHUB_REPOSITORY ? new GitHubApi(env.GITHUB_API_URL || "https://api.github.com", env.GITHUB_REPOSITORY, githubToken, deps.fetch) : null;
  let checkId = null;
  let checkWarned = false;
  const warnCheck = (message) => {
    if (checkWarned) return;
    checkWarned = true;
    annotate("warning", `Could not report the "${checkName}" check (${message}). Give the job \`permissions: checks: write\` to see it on the commit; the verdict still decides this step.`, log);
  };
  const client = new QarmiqCiClient({ baseUrl: input(env, "qarmiq-url") || "https://app.qarmiq.ai", token, fetch: deps.fetch });
  let final;
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
      }
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

// github-action/src/index.ts
var controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
run(process.env, { signal: controller.signal }).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stdout.write(`::error::${String(error instanceof Error ? error.stack ?? error.message : error).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}
`);
  process.exitCode = 1;
});
