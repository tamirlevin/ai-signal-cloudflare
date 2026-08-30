import { describe, expect, it } from "vitest";
import { latestRunStatus, latestScheduledRunStatus, scheduledHeartbeat } from "../src/repository";

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

  it("queries the latest completed cron run for the scheduled heartbeat", async () => {
    let sql = "";
    const db = {
      prepare: (statement: string) => {
        sql = statement;
        return {
          first: async () => ({
            trigger: "cron",
            status: "skipped",
            issue_date: "2026-08-26",
            error_code: null,
            error_message: null,
            started_at: "2026-08-30T22:15:18.655Z",
            finished_at: "2026-08-30T22:15:19.180Z",
            duration_ms: 525
          })
        };
      }
    } as unknown as D1Database;

    await expect(latestScheduledRunStatus(db)).resolves.toMatchObject({ trigger: "cron", status: "skipped" });
    expect(sql).toContain("WHERE trigger = 'cron'");
    expect(sql).toContain("ORDER BY finished_at DESC");
  });

  it("treats a recent skipped cron run as a healthy heartbeat", () => {
    const heartbeat = scheduledHeartbeat({
      trigger: "cron",
      status: "skipped",
      issueDate: "2026-08-26",
      startedAt: "2026-08-30T22:15:18.655Z",
      finishedAt: "2026-08-30T22:15:19.180Z",
      durationMs: 525
    }, new Date("2026-08-31T23:15:19.180Z"));

    expect(heartbeat).toEqual({
      status: "healthy",
      staleAfterHours: 26,
      lastCompletedAt: "2026-08-30T22:15:19.180Z",
      lastOutcome: "skipped"
    });
  });

  it("marks a scheduled heartbeat stale only after 26 hours", () => {
    const heartbeat = scheduledHeartbeat({
      trigger: "cron",
      status: "success",
      startedAt: "2026-08-30T22:15:18.655Z",
      finishedAt: "2026-08-30T22:15:19.180Z",
      durationMs: 525
    }, new Date("2026-09-01T00:15:20.180Z"));

    expect(heartbeat).toMatchObject({ status: "stale", staleAfterHours: 26, lastOutcome: "success" });
  });

  it("reports a missing heartbeat when no cron run has completed", () => {
    expect(scheduledHeartbeat(null)).toEqual({ status: "missing", staleAfterHours: 26 });
  });
});
