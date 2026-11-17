import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CpaSettingsScreen } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({ id: "cpa", title: "CLIProxyAPI", icon: "Gauge", Component: CpaSettingsScreen });
  return () => {};
}
