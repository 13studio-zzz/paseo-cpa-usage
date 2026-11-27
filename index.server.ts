import type { PluginServerContext } from "@getpaseo/plugin/server";
import { hashAccountKey, unavailable, type UsageReport } from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import { cpaSettings, statusRpc } from "./shared/contracts";
import { connect, listAccounts, type AuthFile } from "./server/cpa";
import { QUOTA } from "./server/quota";

const input = z.object({ name: z.string(), provider: z.string() }).strict();
type Values = z.output<typeof cpaSettings.schema>;

/**
 * CPA auth-file providers that get their own Usage source, so each card is titled "CPA (<provider>)".
 * Paseo only accepts usage sources registered while the plugin starts, so the list is fixed;
 * accounts of any other provider go to the "CPA" fallback source.
 */
const PROVIDERS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  antigravity: "Antigravity",
  gemini: "Gemini",
  "gemini-cli": "Gemini CLI",
  aistudio: "AI Studio",
  vertex: "Vertex",
  kimi: "Kimi",
  xai: "Grok",
  devin: "Devin",
  meta: "Meta",
  qwen: "Qwen",
  iflow: "iFlow",
};

const known = (provider: string) => Object.hasOwn(PROVIDERS, provider);
const providerName = (provider: string) => (known(provider) ? PROVIDERS[provider] : provider);

export default function contribute(server: PluginServerContext) {
  let values: Values = cpaSettings.schema.parse({});
  const cache = new Map<string, { at: number; report: UsageReport }>();
  const settings = server.registerSettings(cpaSettings);
  const apply = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status !== "ready") return;
    values = state.values;
    cache.clear();
  };
  void settings.read().then(apply, (error) => console.error("CPA settings read failed", error));
  const unsubscribe = settings.subscribe(apply);

  const enabled = (file: AuthFile) => !values.disabledProviders.includes(file.provider ?? "");
  const account = (file: AuthFile, withProvider: boolean) => ({
    key: `cpa-${hashAccountKey(file.name).slice(0, 40)}`,
    label: [withProvider ? file.provider : "", file.note, file.label || file.email, file.disabled ? "(disabled)" : ""]
      .filter(Boolean)
      .join(" · "),
    harness: `CPA (${providerName(file.provider ?? "")})`,
    input: { name: file.name, provider: file.provider ?? "" },
  });

  async function fetchQuota(raw: unknown): Promise<UsageReport> {
    const { name, provider } = input.parse(raw);
    const read = Object.hasOwn(QUOTA, provider) ? QUOTA[provider] : undefined;
    if (!read) return unavailable({ kind: "no_quota", detail: `No quota API for ${provider} accounts` });
    const file = (await listAccounts()).find((entry) => entry.name === name && entry.provider === provider);
    if (!file) return { status: "error", error: "Account no longer in the CPA pool" };
    const hit = cache.get(name);
    if (hit && Date.now() - hit.at < values.refreshMinutes * 60_000) return hit.report;
    const report = await read(file);
    if (report.status === "available") cache.set(name, { at: Date.now(), report });
    return report;
  }

  for (const [provider, name] of Object.entries(PROVIDERS)) {
    server.registerUsageSource({
      id: `cliproxyapi.${provider}`,
      label: `CPA (${name})`,
      input,
      async discover(scope) {
        if (scope.kind !== "global") return [];
        // A CPA outage is reported once, by the fallback source below.
        const files = await listAccounts().catch(() => []);
        return files.filter((file) => file.provider === provider && enabled(file)).map((file) => account(file, false));
      },
      fetch: fetchQuota,
    });
  }

  server.registerUsageSource({
    id: "cliproxyapi",
    label: "CPA",
    input,
    async discover(scope) {
      if (scope.kind !== "global") return [];
      return (await listAccounts())
        .filter((file) => !known(file.provider ?? "") && enabled(file))
        .map((file) => account(file, true));
    },
    fetch: fetchQuota,
  });

  server.handle(statusRpc, async ({ probe }) => {
    try {
      const conn = await connect(probe);
      const accounts = await listAccounts(probe);
      const counts = new Map<string, number>();
      for (const file of accounts) counts.set(file.provider ?? "", (counts.get(file.provider ?? "") ?? 0) + 1);
      let probeText: string | undefined;
      if (probe) {
        const file = accounts.find((entry) => QUOTA[entry.provider ?? ""] && !entry.disabled);
        const report = file && (await QUOTA[file.provider ?? ""](file));
        probeText = !file || !report
          ? "No account with a supported quota API"
          : report.status === "available"
            ? `${file.label}: ${report.windows.map((w) => `${w.shortLabel || w.label} ${Math.round(w.remainingPct ?? 0)}% left`).join(", ")}`
            : `${file.label}: ${report.status === "error" ? report.error : report.problem.kind}`;
      }
      return {
        connected: true,
        baseUrl: conn.baseUrl,
        via: conn.via,
        providers: [...counts].map(([id, count]) => ({ id, accounts: count, supported: !!QUOTA[id] })),
        probe: probeText,
      };
    } catch (error) {
      return { connected: false, error: error instanceof Error ? error.message : String(error), providers: [] };
    }
  });

  return () => unsubscribe();
}
