function usableHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function freshShadowCandidates(edition, shadowRun, limit = 5) {
  const report = shadowRun?.report;
  if (!edition || shadowRun?.status === "failed" || !report) return [];
  const baseIssueDate = shadowRun.baseIssueDate ?? report.baseIssue?.issueDate;
  if (!baseIssueDate || baseIssueDate !== edition.issueDate) return [];

  const editionPublishedAt = Date.parse(edition.publishedAt);
  const reportCompletedAt = Date.parse(shadowRun.finishedAt ?? report.generatedAt);
  if (!Number.isFinite(editionPublishedAt) || !Number.isFinite(reportCompletedAt) || reportCompletedAt <= editionPublishedAt) return [];

  const seenUrls = new Set();
  const candidates = [];
  for (const candidate of report.wouldAdd ?? []) {
    const url = usableHttpsUrl(candidate?.url);
    const publishedAt = Date.parse(candidate?.publishedAt);
    if (!url || !Number.isFinite(publishedAt) || publishedAt <= editionPublishedAt || seenUrls.has(url)) continue;
    seenUrls.add(url);
    candidates.push({ ...candidate, url });
    if (candidates.length >= limit) break;
  }
  return candidates;
}
