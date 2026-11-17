import { useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { cpaSettings, statusRpc } from "../shared/contracts";

const INTERVALS = [
  { label: "Paseo default (5 min)", value: "0" },
  { label: "15 minutes", value: "15" },
  { label: "30 minutes", value: "30" },
  { label: "1 hour", value: "60" },
] as const;

export function CpaSettingsScreen() {
  const settings = useSettings(cpaSettings);
  const getStatus = useRpc(statusRpc);
  const status = useQuery({ queryKey: ["cpa-status"], queryFn: () => getStatus({ probe: false }), refetchInterval: 30_000 });
  const test = useMutation({ mutationFn: () => getStatus({ probe: true }), onSuccess: () => status.refetch() });

  const data = status.data;
  const connection = status.isPending
    ? "Checking..."
    : data?.connected
      ? `Connected to ${data.baseUrl} (key from ${data.via})`
      : "Not connected";
  const ready = settings.status === "ready" ? settings : undefined;
  const save = (patch: Partial<NonNullable<typeof ready>["values"]>) =>
    ready && void ready.save({ ...ready.values, ...patch }, ready.revision);

  return (
    <>
      <SettingsSection title="Connection">
        <SettingsCard>
          <SettingsRow label="Status" hint={connection} error={data?.error ?? (status.error ? String(status.error) : null)} />
          <SettingsAction
            label="Connection test"
            hint={test.data ? (test.data.connected ? test.data.probe : test.data.error) : "Rediscovers CPA and reads one account's quota"}
            error={test.error ? String(test.error) : null}
            actionLabel={test.isPending ? "Testing..." : "Test"}
            disabled={test.isPending}
            onPress={() => test.mutate()}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Providers">
        <SettingsCard>
          {(data?.providers ?? []).map((provider) => (
            <SettingsSwitch
              key={provider.id}
              label={provider.id}
              hint={`${provider.accounts} account(s)${provider.supported ? "" : " · quota API not supported"}`}
              value={!ready?.values.disabledProviders.includes(provider.id)}
              disabled={!ready || settings.saving}
              onValueChange={(on) =>
                ready &&
                save({
                  disabledProviders: on
                    ? ready.values.disabledProviders.filter((id) => id !== provider.id)
                    : [...ready.values.disabledProviders, provider.id],
                })
              }
            />
          ))}
          {!data?.providers.length ? <SettingsRow label="No OAuth accounts found" /> : null}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Refresh">
        <SettingsCard>
          <SettingsSelect
            label="Quota refresh interval"
            hint="Minimum time between upstream quota calls per account, including manual refresh in Usage"
            value={String(ready?.values.refreshMinutes ?? 0)}
            options={INTERVALS}
            disabled={!ready || settings.saving}
            error={settings.saveError ?? (settings.status === "invalid" || settings.status === "error" ? settings.error : null)}
            onValueChange={(value) => save({ refreshMinutes: Number(value) })}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
