import { describe, expect, it } from "vitest";
import { run } from "../../github-action/src/main.js";
import { cell, commentMarker, conclusionFor, renderReport } from "../../github-action/src/report.js";
import { noSleep, status } from "../fake-qarmiq.js";
import { fakeWorld, type World } from "./fake-world.js";

const PR = { number: 42, headSha: "head1111111111111111111111111111111111111", headRef: "feature/cart" };
const finished = (verdict: "go" | "stop" | "review", reason: string) => status({ state: "finished", verdict, reason });
const go = (world: World) => run(world.env, { fetch: world.fetch, sleep: noSleep, log: (l) => world.log.push(l) });

describe("the GitHub action", () => {
  it("on a pull request: tests the pushed commit, reports a completed check on it, comments once, and passes on go", async () => {
    const world = fakeWorld({ statuses: [status(), finished("go", "all 2 scenarios passed")], pullRequest: PR });
    expect(await go(world)).toBe(0);
    // The head the author pushed, not the merge commit GitHub made; the PR number and branch from the event.
    expect(world.qarmiqRequests[0]!.body).toMatchObject({ sha: PR.headSha, ref: PR.headRef, source: { provider: "github", repo: "acme/shop", pr: "42" } });
    expect(world.checks).toHaveLength(1);
    expect(world.checks[0]).toMatchObject({ name: "Qarmiq", head_sha: PR.headSha, status: "completed", conclusion: "success" });
    expect(world.checks[0]!.output.title).toBe("Go: every scenario passed");
    expect(world.comments).toHaveLength(1);
    expect(world.comments[0]!.body.startsWith(commentMarker("trig1"))).toBe(true);
    expect(world.outputs()).toMatch(/verdict<<qarmiq_[\w-]+\ngo\n/);
    expect(world.summary()).toContain("### Qarmiq: Go: every scenario passed");
  });

  it("edits its own comment on the next push instead of adding another, and leaves other comments alone", async () => {
    const existingComments = [
      { id: 1, issue: 42, body: "Looks good to me" },
      { id: 2, issue: 42, body: `${commentMarker("trig1")}\n### Qarmiq: Stop: a scenario failed` },
      { id: 3, issue: 42, body: `${commentMarker("other")}\n### Qarmiq: Go` },
    ];
    const world = fakeWorld({ statuses: [finished("go", "fixed")], pullRequest: PR, existingComments });
    await go(world);
    expect(world.comments.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(world.comments[1]!.body).toContain("Go: every scenario passed");
    expect(world.comments[0]!.body).toBe("Looks good to me");
    expect(world.comments[2]!.body).toContain("### Qarmiq: Go");
  });

  it("stop fails the step with an error annotation; review is a neutral check that passes, or fails when asked", async () => {
    const stop = fakeWorld({ statuses: [finished("stop", "1 of 2 scenarios failed")] });
    expect(await go(stop)).toBe(1);
    expect(stop.checks[0]).toMatchObject({ conclusion: "failure" });
    expect(stop.log.some((l) => l.startsWith("::error::Qarmiq: 1 of 2 scenarios failed"))).toBe(true);

    const review = fakeWorld({ statuses: [finished("review", "1 of 2 scenarios could not be decided")] });
    expect(await go(review)).toBe(0);
    expect(review.checks[0]).toMatchObject({ conclusion: "neutral" });
    expect(review.log.some((l) => l.startsWith("::warning::Qarmiq could not decide"))).toBe(true);

    const strict = fakeWorld({ statuses: [finished("review", "undecided")], inputs: { "on-review": "fail" } });
    expect(await go(strict)).toBe(1);
    expect(strict.checks[0]).toMatchObject({ conclusion: "failure" });
  });

  it("without checks or pull-requests write, warns once for each and still decides the step by the verdict", async () => {
    const world = fakeWorld({ statuses: [status(), status(), finished("stop", "failed")], pullRequest: PR, checksForbidden: true, commentsForbidden: true });
    expect(await go(world)).toBe(1);
    const warnings = world.log.filter((l) => l.startsWith("::warning::"));
    expect(warnings.filter((l) => l.includes("checks: write"))).toHaveLength(1);
    expect(warnings.filter((l) => l.includes("pull-requests: write"))).toHaveLength(1);
    expect(world.summary()).toContain("Stop: a scenario failed");
  });

  it("posts no comment outside a pull request, or when told not to", async () => {
    const push = fakeWorld({ statuses: [finished("go", "ok")] });
    await go(push);
    expect(push.comments).toHaveLength(0);
    expect(push.qarmiqRequests[0]!.body).toMatchObject({ sha: push.env.GITHUB_SHA, ref: "main" });

    const quiet = fakeWorld({ statuses: [finished("go", "ok")], pullRequest: PR, inputs: { comment: "false" } });
    await go(quiet);
    expect(quiet.comments).toHaveLength(0);
  });

  it("refuses a missing input or a bad on-review before calling anything, and masks the token", async () => {
    const missing = fakeWorld({ statuses: [] });
    delete missing.env.INPUT_TRIGGER;
    expect(await go(missing)).toBe(1);
    expect(missing.log.some((l) => l === "::error::Input required and not supplied: trigger")).toBe(true);
    expect(missing.qarmiqRequests).toHaveLength(0);

    const bad = fakeWorld({ statuses: [], inputs: { "on-review": "block" } });
    expect(await go(bad)).toBe(1);
    expect(bad.qarmiqRequests).toHaveLength(0);
    expect(bad.log[0]).toBe("::add-mask::qt_deadbeef_secret");
  });

  it("a refusal from Qarmiq fails the step with its reason", async () => {
    const world = fakeWorld({ statuses: [], startStatus: 429, startBody: { error: "monthly_cap", message: "This project has started 500 CI runs this month.", retry_after: 3600 } });
    expect(await go(world)).toBe(1);
    expect(world.log).toContain("::error::Qarmiq refused (monthly_cap): This project has started 500 CI runs this month. Try again in 3600 s.");
    expect(world.checks).toHaveLength(0);
  });

  it("cancelling the job cancels the run, and the check says so", async () => {
    const controller = new AbortController();
    const second = fakeWorld({ statuses: [status()] });
    // The job is cancelled while the first status read is out: the run is still going, so the next turn cancels it on Qarmiq.
    let reads = 0;
    const counting: typeof fetch = async (input, init) => {
      if ((init?.method ?? "GET") === "GET" && String(input).includes("qarmiq.test") && ++reads === 1) controller.abort();
      return second.fetch(input, init);
    };
    const cancelled = await run(second.env, { fetch: counting, sleep: noSleep, log: (l) => second.log.push(l), signal: controller.signal });
    expect(second.qarmiqRequests.at(-1)!.method).toBe("DELETE");
    expect(cancelled).toBe(1);
    expect(second.checks[0]).toMatchObject({ conclusion: "cancelled" });
  });
});

describe("the report", () => {
  it("keeps a scenario's text inside its table cell", () => {
    expect(cell("A | B\nC <b>")).toBe("A \\| B C &lt;b&gt;");
    const text = renderReport(status({ scenarios: [{ id: "s", ref: "SHOP-S1", statement: "Totals | taxes\nmatch", verdict: "failed" }] }));
    expect(text).toContain("| ❌ failed | `SHOP-S1` | Totals \\| taxes match |");
  });

  it("concludes no verdict as never a success", () => {
    expect(conclusionFor(status({ state: "timed_out", verdict: null }), "neutral")).toBe("failure");
    expect(conclusionFor(status({ state: "superseded", verdict: null }), "neutral")).toBe("cancelled");
  });
});
