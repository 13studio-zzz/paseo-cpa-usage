# CLIProxyAPI usage for Paseo

A [Paseo](https://paseo.sh) plugin that shows the quota of every OAuth account in a local
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) or EasyCLIProxyAPI pool in
Paseo's Usage view and `paseo usage`. Cards are titled by provider: `CPA (Codex)`, `CPA (Claude)`.

See [OVERVIEW.md](OVERVIEW.md) for what it reads and where.

## Install

```bash
paseo plugin add git:eerraa/paseo-cpa-usage
```

Plugins must be enabled on the daemon (Settings > Plugins). Requires Paseo 0.15.3 or later.

## Develop

```bash
npm install
npm run typecheck
paseo plugin install /absolute/path/to/paseo-cpa-usage
paseo plugin reload cpa-usage
paseo usage ls --refresh
```

## License

MIT
