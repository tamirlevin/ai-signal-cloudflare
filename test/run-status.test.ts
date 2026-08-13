import { describe, expect, it } from "vitest";
import { latestRunStatus } from "../src/repository";

describe("collector status", () => {
  it("returns a public-safe summary of the latest run", async () => {
    const db = {
      prepare: () => ({
        first: async () => ({
          trigger: "cron",
          status: "skipped",
          issue_date: "2026-08-10",
          error_code: null,
          error_message: null,
          started_at: "2026-08-12T22:15:40.800Z",
          finished_at: "2026-08-12T22:15:41.843Z",
          duration_ms: 1043
        })
      })
    } as unknown as D1Database;

    await expect(latestRunStatus(db)).resolves.toEqual({
      trigger: "cron",
      status: "skipped",
      issueDate: "2026-08-10",
      startedAt: "2026-08-12T22:15:40.800Z",
      finishedAt: "2026-08-12T22:15:41.843Z",
      durationMs: 1043
    });
  });

  it("includes a safe validation detail for a failed run", async () => {
    const db = {
      prepare: () => ({
        first: async () => ({
          trigger: "manual",
          status: "failed",
          issue_date: "2026-08-11",
          error_code: "VALIDATION_FAILED",
          error_message: "edition.signals contains a duplicate story URL",
          started_at: "2026-08-13T04:13:46.936Z",
          finished_at: "2026-08-13T04:14:51.493Z",
          duration_ms: 64557
        })
      })
    } as unknown as D1Database;

    await expect(latestRunStatus(db)).resolves.toMatchObject({
      status: "failed",
      errorCode: "VALIDATION_FAILED",
      failureDetail: "edition.signals contains a duplicate story URL"
    });
  });
});
