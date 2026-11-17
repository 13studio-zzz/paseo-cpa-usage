import {
  balanceToneFromRemaining,
  toneFromUsedPct,
  unavailable,
  windowFromReportedDuration,
  windowFromUsedPct,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { apiCall, type AuthFile } from "./cpa";

interface CodexWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
}
interface CodexLimit {
  primary_window?: CodexWindow | null;
  secondary_window?: CodexWindow | null;
}
interface CodexUsage {
  plan_type?: string;
  rate_limit?: CodexLimit | null;
  code_review_rate_limit?: CodexLimit | null;
  additional_rate_limits?: { limit_name?: string; metered_feature?: string; rate_limit?: CodexLimit }[] | null;
  credits?: { has_credits?: boolean; unlimited?: boolean; balance?: number | string | null } | null;
}
type ClaudeUsage = Record<string, { utilization?: number | null; resets_at?: string | null } | null>;

function failed(status: number, body: unknown): UsageReport {
  if (status === 401 || status === 403) return unavailable({ kind: "rejected", status, refreshedBy: "CLIProxyAPI" });
  return { status: "error", error: `Upstream HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}` };
}

async function codex(file: AuthFile): Promise<UsageReport> {
  const header: Record<string, string> = { Authorization: "Bearer $TOKEN$", "User-Agent": "codex_cli_rs/0.76.0" };
  const account = file.id_token?.chatgpt_account_id;
  if (account) header["Chatgpt-Account-Id"] = account;
  const { status, body } = await apiCall(file.auth_index, "https://chatgpt.com/backend-api/wham/usage", header);
  if (status >= 400) return failed(status, body);
  const usage = body as CodexUsage;
  const windows: UsageWindow[] = [];
  const add = (limit: CodexLimit | null | undefined, scope?: { id: string; label: string }) => {
    for (const [slot, w] of [["primary", limit?.primary_window], ["secondary", limit?.secondary_window]] as const) {
      if (!w) continue;
      windows.push(
        windowFromReportedDuration({
          durationSeconds: w.limit_window_seconds ?? null,
          scope,
          unknown: { id: slot, label: slot === "primary" ? "Primary" : "Secondary", shortLabel: slot[0] },
          utilizationPct: w.used_percent,
          resetsAt: w.reset_at ? new Date(w.reset_at * 1000).toISOString() : null,
          summary: !scope,
          tone: toneFromUsedPct(w.used_percent),
        }),
      );
    }
  };
  add(usage.rate_limit);
  add(usage.code_review_rate_limit, { id: "code_review", label: "Review" });
  for (const extra of usage.additional_rate_limits ?? []) {
    const id = extra.metered_feature || extra.limit_name || "extra";
    add(extra.rate_limit, { id, label: extra.limit_name || id });
  }
  const balance = usage.credits?.has_credits ? Number(usage.credits.balance) : NaN;
  return {
    status: "available",
    planLabel: usage.plan_type ?? file.id_token?.plan_type,
    windows,
    balances: Number.isFinite(balance)
      ? [{ id: "credits", label: "Credits", remaining: balance, unit: "credits", tone: balanceToneFromRemaining(balance) }]
      : undefined,
  };
}

const CLAUDE_WINDOWS: Record<string, [label: string, short: string, summary: boolean]> = {
  five_hour: ["5-hour", "5h", true],
  seven_day: ["Weekly", "wk", true],
  seven_day_opus: ["Weekly Opus", "Opus", false],
  seven_day_sonnet: ["Weekly Sonnet", "Sonnet", false],
};

async function claude(file: AuthFile): Promise<UsageReport> {
  const { status, body } = await apiCall(file.auth_index, "https://api.anthropic.com/api/oauth/usage", {
    Authorization: "Bearer $TOKEN$",
    "anthropic-beta": "oauth-2025-04-20",
  });
  if (status >= 400) return failed(status, body);
  const usage = body as ClaudeUsage;
  const windows = Object.entries(CLAUDE_WINDOWS).flatMap(([id, [label, shortLabel, summary]]) => {
    const w = usage[id];
    if (typeof w?.utilization !== "number") return [];
    return [windowFromUsedPct({ id, label, shortLabel, summary, utilizationPct: w.utilization, resetsAt: w.resets_at, tone: toneFromUsedPct(w.utilization) })];
  });
  return { status: "available", windows };
}

/** Provider quota readers. Providers missing here are listed but report no quota API. */
export const QUOTA: Record<string, (file: AuthFile) => Promise<UsageReport>> = { codex, claude };
