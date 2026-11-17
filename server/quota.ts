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
type ClaudeWindow = { utilization?: number | string | null; resets_at?: string | null } | null;
type ClaudeScopeName = { id?: string | null; display_name?: string | null } | null;
interface ClaudeLimit {
  kind?: string;
  percent?: number | string | null;
  resets_at?: string | null;
  scope?: { model?: ClaudeScopeName; surface?: ClaudeScopeName } | null;
}
type ClaudeUsage = Record<string, unknown> & { limits?: unknown };

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

const CLAUDE_WINDOWS: Record<string, [label: string, short: string]> = {
  five_hour: ["5-hour", "5h"],
  seven_day: ["Weekly", "wk"],
};

/** Model-scoped weekly limits from before `limits[]`; a `limits[]` entry for the same model replaces them. */
const CLAUDE_LEGACY_SCOPED: Record<string, string> = { seven_day_opus: "Opus", seven_day_sonnet: "Sonnet" };

const pct = (value: unknown) =>
  typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : NaN;
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/**
 * Weekly limits scoped to one model or surface, such as Fable. They arrive only as `limits[]`
 * entries of kind `weekly_scoped`, named by `scope.model` or `scope.surface`. The window ID comes
 * from the name, so `seven_day_opus` and a `limits[]` entry named Opus stay one window.
 */
function claudeScoped(usage: ClaudeUsage) {
  const scoped = new Map<string, { name: string; used: number; resetsAt?: string | null }>();
  for (const [field, name] of Object.entries(CLAUDE_LEGACY_SCOPED)) {
    const window = usage[field] as ClaudeWindow | undefined;
    const used = pct(window?.utilization);
    if (Number.isFinite(used)) scoped.set(`seven_day_${slug(name)}`, { name, used, resetsAt: window?.resets_at });
  }
  for (const limit of (Array.isArray(usage.limits) ? usage.limits : []) as (ClaudeLimit | null)[]) {
    const used = pct(limit?.percent);
    if (limit?.kind !== "weekly_scoped" || !Number.isFinite(used)) continue;
    for (const dimension of ["model", "surface"] as const) {
      const scope = limit.scope?.[dimension];
      const name = scope?.display_name?.trim() || scope?.id?.trim();
      if (!name || !slug(name)) continue;
      scoped.set(`seven_day_${dimension === "surface" ? "surface_" : ""}${slug(name)}`, { name, used, resetsAt: limit.resets_at });
      break;
    }
  }
  return [...scoped].map(([id, { name, used, resetsAt }]) =>
    windowFromUsedPct({ id, label: `Weekly ${name}`, shortLabel: name, summary: false, utilizationPct: used, resetsAt, tone: toneFromUsedPct(used) }),
  );
}

async function claude(file: AuthFile): Promise<UsageReport> {
  const { status, body } = await apiCall(file.auth_index, "https://api.anthropic.com/api/oauth/usage", {
    Authorization: "Bearer $TOKEN$",
    "anthropic-beta": "oauth-2025-04-20",
  });
  if (status >= 400) return failed(status, body);
  const usage = (body ?? {}) as ClaudeUsage;
  const windows = Object.entries(CLAUDE_WINDOWS).flatMap(([id, [label, shortLabel]]) => {
    const window = usage[id] as ClaudeWindow | undefined;
    const used = pct(window?.utilization);
    if (!Number.isFinite(used)) return [];
    return [windowFromUsedPct({ id, label, shortLabel, summary: true, utilizationPct: used, resetsAt: window?.resets_at, tone: toneFromUsedPct(used) })];
  });
  return { status: "available", windows: [...windows, ...claudeScoped(usage)] };
}

/** Provider quota readers. Providers missing here are listed but report no quota API. */
export const QUOTA: Record<string, (file: AuthFile) => Promise<UsageReport>> = { codex, claude };
