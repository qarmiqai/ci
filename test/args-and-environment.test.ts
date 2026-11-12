import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { detectBuild } from "../src/ci-environment.js";

describe("parseArgs", () => {
  it("needs the run command and a trigger; everything else has a default", () => {
    expect(parseArgs([])).toHaveProperty("error");
    expect(parseArgs(["start", "--trigger", "t"])).toHaveProperty("error");
    expect((parseArgs(["run"]) as { error: string }).error).toContain("--trigger is required");
    expect(parseArgs(["run", "--trigger", "t"])).toEqual({ trigger: "t", rerun: false, onReview: "allow", wait: 25, source: {} });
  });

  it("reads every option, the source flags into source", () => {
    expect(
      parseArgs(["run", "--trigger", "t", "--environment", "Preprod", "--sha", "abc1234", "--ref", "main", "--rerun", "--on-review", "fail", "--wait", "0", "--source-repo", "acme/shop", "--source-pr", "42"]),
    ).toEqual({ trigger: "t", environment: "Preprod", sha: "abc1234", ref: "main", rerun: true, onReview: "fail", wait: 0, source: { repo: "acme/shop", pr: "42" } });
  });

  it("refuses an unknown option, a missing value, and a bad --on-review or --wait", () => {
    expect((parseArgs(["run", "--trigger", "t", "--nope", "x"]) as { error: string }).error).toContain("unknown option --nope");
    expect((parseArgs(["run", "--trigger"]) as { error: string }).error).toContain("--trigger needs a value");
    expect((parseArgs(["run", "--trigger", "--sha", "abc"]) as { error: string }).error).toContain("--trigger needs a value");
    expect((parseArgs(["run", "--trigger", "t", "--on-review", "block"]) as { error: string }).error).toContain("allow or fail");
    expect((parseArgs(["run", "--trigger", "t", "--wait", "-1"]) as { error: string }).error).toContain("whole number");
    expect((parseArgs(["run", "--trigger", "t", "--wait", "2.5"]) as { error: string }).error).toContain("whole number");
  });
});

describe("detectBuild", () => {
  it("reads a GitHub Actions push", () => {
    expect(
      detectBuild({
        GITHUB_ACTIONS: "true",
        GITHUB_SHA: "abc1234",
        GITHUB_REF: "refs/heads/main",
        GITHUB_REF_NAME: "main",
        GITHUB_HEAD_REF: "",
        GITHUB_REPOSITORY: "acme/shop",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_RUN_ID: "99",
        GITHUB_ACTOR: "dev",
      }),
    ).toEqual({ sha: "abc1234", ref: "main", source: { provider: "github", repo: "acme/shop", url: "https://github.com/acme/shop/actions/runs/99", actor: "dev" } });
  });

  it("reads a GitHub pull request as its own branch and number, not the merge ref", () => {
    const build = detectBuild({ GITHUB_ACTIONS: "true", GITHUB_REF: "refs/pull/42/merge", GITHUB_REF_NAME: "42/merge", GITHUB_HEAD_REF: "feature/cart" });
    expect(build.ref).toBe("feature/cart");
    expect(build.source.pr).toBe("42");
  });

  it("reads GitLab CI, a merge request's source branch first", () => {
    expect(
      detectBuild({ GITLAB_CI: "true", CI_COMMIT_SHA: "def5678", CI_COMMIT_REF_NAME: "main", CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feature/x", CI_MERGE_REQUEST_IID: "7", CI_PROJECT_PATH: "acme/shop", CI_JOB_URL: "https://gitlab.com/acme/shop/-/jobs/1" }),
    ).toEqual({ sha: "def5678", ref: "feature/x", source: { provider: "gitlab", repo: "acme/shop", pr: "7", url: "https://gitlab.com/acme/shop/-/jobs/1" } });
  });

  it("reads Bitbucket Pipelines", () => {
    expect(detectBuild({ BITBUCKET_BUILD_NUMBER: "12", BITBUCKET_COMMIT: "aaa1111", BITBUCKET_BRANCH: "main", BITBUCKET_REPO_FULL_NAME: "acme/shop" })).toEqual({
      sha: "aaa1111",
      ref: "main",
      source: { provider: "bitbucket", repo: "acme/shop" },
    });
  });

  it("knows nothing about a CI it does not recognise", () => {
    expect(detectBuild({ CI: "true", JENKINS_URL: "https://ci.example.com" })).toEqual({ source: {} });
  });
});
