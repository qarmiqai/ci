import type { RunSource } from "./types.js";

// What the CI this process runs in already knows about the build: the commit, the branch, and where the pipeline run lives. Read from
// the CI's own documented variables, only to fill what the caller did not say. Unknown CIs give nothing, and the caller names it all.
export interface DetectedBuild {
  sha?: string;
  ref?: string;
  source: RunSource;
}

export function detectBuild(env: Record<string, string | undefined>): DetectedBuild {
  if (env.GITHUB_ACTIONS === "true") {
    const pr = env.GITHUB_REF?.match(/^refs\/pull\/(\d+)\//)?.[1];
    const url =
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
    return {
      sha: env.GITHUB_SHA,
      // On a pull request GITHUB_REF_NAME is "<n>/merge"; the branch the change lives on is GITHUB_HEAD_REF.
      ref: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME,
      source: compact({ provider: "github", repo: env.GITHUB_REPOSITORY, pr, url, actor: env.GITHUB_ACTOR }),
    };
  }
  if (env.GITLAB_CI === "true") {
    return {
      sha: env.CI_COMMIT_SHA,
      ref: env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME || env.CI_COMMIT_REF_NAME,
      source: compact({ provider: "gitlab", repo: env.CI_PROJECT_PATH, pr: env.CI_MERGE_REQUEST_IID, url: env.CI_JOB_URL, actor: env.GITLAB_USER_LOGIN }),
    };
  }
  if (env.BITBUCKET_BUILD_NUMBER) {
    const url = env.BITBUCKET_GIT_HTTP_ORIGIN && env.BITBUCKET_BUILD_NUMBER ? `${env.BITBUCKET_GIT_HTTP_ORIGIN}/pipelines/results/${env.BITBUCKET_BUILD_NUMBER}` : undefined;
    return {
      sha: env.BITBUCKET_COMMIT,
      ref: env.BITBUCKET_BRANCH,
      source: compact({ provider: "bitbucket", repo: env.BITBUCKET_REPO_FULL_NAME, pr: env.BITBUCKET_PR_ID, url }),
    };
  }
  return { source: {} };
}

// Drops absent and empty fields, so what is sent is only what is known.
export function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== "")) as T;
}
