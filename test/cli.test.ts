import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { fakeQarmiq, noSleep, started, status } from "./fake-qarmiq.js";

function io(fetchImpl: typeof fetch) {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), fetch: fetchImpl, sleep: noSleep } };
}

const finished = (verdict: "go" | "stop" | "review", reason: string) => ({ status: 200, body: status({ state: "finished", verdict, reason }) });

describe("qarmiq-ci run", () => {
  it("exits 0 on go, 1 on stop, and 0 on review with a warning unless told to fail", async () => {
    for (const [verdict, args, code] of [
      ["go", [], 0],
      ["stop", [], 1],
      ["review", [], 0],
      ["review", ["--on-review", "fail"], 1],
    ] as const) {
      const q = fakeQarmiq({ start: { status: 201, body: started() }, statuses: [finished(verdict, "why")] });
      const run = io(q.fetch);
      expect(await main(["run", "--trigger", "t", ...args], { QARMIQ_CI_TOKEN: "qt_x" }, run.io)).toBe(code);
      expect(run.out.join("\n")).toContain(`${verdict}: why`);
      expect(run.out.some((l) => l.includes("a person should look"))).toBe(verdict === "review" && args.length === 0);
    }
  });

  it("fills the commit, branch and source from GitHub Actions, and lets a flag win over what it read", async () => {
    const q = fakeQarmiq({ start: { status: 201, body: started() }, statuses: [finished("go", "ok")] });
    const env = {
      QARMIQ_CI_TOKEN: "qt_x",
      QARMIQ_URL: "https://qarmiq.example.com",
      GITHUB_ACTIONS: "true",
      GITHUB_SHA: "abc1234",
      GITHUB_REF_NAME: "main",
      GITHUB_REPOSITORY: "acme/shop",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: "99",
    };
    await main(["run", "--trigger", "t", "--ref", "release", "--source-repo", "acme/shop-fork"], env, io(q.fetch).io);
    const [start] = q.requests;
    expect(start!.url.origin).toBe("https://qarmiq.example.com");
    expect(start!.body).toEqual({ sha: "abc1234", ref: "release", source: { provider: "github", repo: "acme/shop-fork", url: "https://github.com/acme/shop/actions/runs/99" } });
  });

  it("sends nothing it does not know: outside a recognised CI, only what the flags say", async () => {
    const q = fakeQarmiq({ start: { status: 201, body: started() }, statuses: [finished("go", "ok")] });
    await main(["run", "--trigger", "t"], { QARMIQ_CI_TOKEN: "qt_x" }, io(q.fetch).io);
    expect(q.requests[0]!.body).toEqual({ source: {} });
    expect(q.requests[0]!.url.origin).toBe("https://app.qarmiq.ai");
  });

  it("says when the commit was already started, instead of pretending to start it", async () => {
    const q = fakeQarmiq({ start: { status: 200, body: started({ deduplicated: true }) }, statuses: [finished("go", "ok")] });
    const run = io(q.fetch);
    await main(["run", "--trigger", "t", "--sha", "abc1234"], { QARMIQ_CI_TOKEN: "qt_x" }, run.io);
    expect(run.out[0]).toMatch(/^Already started for this commit SHOP-R12/);
  });

  it("exits 2, with the reason, for a missing token, bad arguments, or a refusal", async () => {
    const q = fakeQarmiq({ start: { status: 429, body: { error: "concurrency", message: "This project already has 5 CI runs in flight; its limit is 5.", retry_after: 60 } } });
    const noToken = io(q.fetch);
    expect(await main(["run", "--trigger", "t"], {}, noToken.io)).toBe(2);
    expect(noToken.err[0]).toContain("QARMIQ_CI_TOKEN is not set");

    const badArgs = io(q.fetch);
    expect(await main(["run"], { QARMIQ_CI_TOKEN: "qt_x" }, badArgs.io)).toBe(2);

    const refused = io(q.fetch);
    expect(await main(["run", "--trigger", "t"], { QARMIQ_CI_TOKEN: "qt_x" }, refused.io)).toBe(2);
    expect(refused.err[0]).toBe("Qarmiq refused (concurrency): This project already has 5 CI runs in flight; its limit is 5. Try again in 60 s.");
  });

  it("never prints the token", async () => {
    const q = fakeQarmiq({ start: { status: 401, body: { error: "Unauthorized" } } });
    const run = io(q.fetch);
    await main(["run", "--trigger", "t"], { QARMIQ_CI_TOKEN: "qt_deadbeef_secretsecret" }, run.io);
    expect([...run.out, ...run.err].join("\n")).not.toContain("secretsecret");
  });
});
