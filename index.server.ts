import type { PluginServerContext } from "@getpaseo/plugin/server";
import { hashAccountKey, unavailable, type UsageReport } from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import { cpaSettings, statusRpc } from "./shared/contracts";
import { connect, listAccounts } from "./server/cpa";
import { QUOTA } from "./server/quota";

const input = z.object({ name: z.string(), provider: z.string() }).strict();
type Values = z.output<typeof cpaSettings.schema>;

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

  server.registerUsageSource({
    id: "cliproxyapi",
    label: "CLIProxyAPI",
    input,
    async discover(scope) {
      if (scope.kind !== "global") return [];
      return (await listAccounts())
        .filter((file) => !values.disabledProviders.includes(file.provider ?? ""))
        .map((file) => ({
          key: `cpa-${hashAccountKey(file.name).slice(0, 40)}`,
          label: [file.note, file.label || file.email, file.disabled ? "(disabled)" : ""].filter(Boolean).join(" · "),
          harness: `CPA ${file.provider}`,
          input: { name: file.name, provider: file.provider ?? "" },
        }));
    },
    async fetch(raw) {
      const { name, provider } = input.parse(raw);
      const read = QUOTA[provider];
      if (!read) return unavailable({ kind: "no_quota", detail: `No quota API for ${provider} accounts` });
      const hit = cache.get(name);
      if (hit && Date.now() - hit.at < values.refreshMinutes * 60_000) return hit.report;
      const file = (await listAccounts()).find((entry) => entry.name === name);
      if (!file) return { status: "error", error: "Account no longer in the CPA pool" };
      const report = await read(file);
      if (report.status === "available") cache.set(name, { at: Date.now(), report });
      return report;
    },
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
