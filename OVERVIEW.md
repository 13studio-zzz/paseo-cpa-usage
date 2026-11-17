Shows the subscription quota of every OAuth account in a local CLIProxyAPI (CPA) or EasyCLIProxyAPI pool in the Paseo Usage view. Each account gets its own card with remaining percentage per window and its reset time.

The plugin finds the running `cli-proxy-api.exe` on Windows, reads the server port and the Management Key from the local config files next to it (`config.toml` of EasyCLIProxyAPI, then `config.yaml`), or from the `CPA_MANAGEMENT_KEY` environment variable. The key never leaves the daemon. Quotas are read through CPA's management `api-call` proxy, so account tokens stay inside CPA. The plugin only reads; it never changes CPA settings or the account pool.

Settings, under Settings > Plugins: connection status and a connection test, a switch per provider found in the pool, and a minimum refresh interval per account.

Quota readers exist for Codex and Claude accounts. Accounts of other providers are listed as having no quota API.
