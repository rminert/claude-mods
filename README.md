# claude-mods

Mods for [Claude Code](https://claude.com/claude-code): small plugins that change its interface or behaviour. This repository is a plugin marketplace, so each mod installs on its own.

| Mod | What it does |
| --- | --- |
| [cache-countdown](mods/cache-countdown) | Counts down until the session's prompt cache goes cold, keeps it warm while you're away, and writes a handoff prompt for a fresh session. |

## Installing a mod

At the prompt of a Claude Code terminal session:

```
/plugin install cache-countdown --marketplace rminert/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```bash
claude plugin install cache-countdown --marketplace rminert/claude-mods
```

In the Claude desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `rminert/claude-mods`, then **Add plugin**.

## Adding a mod

1. Put the mod in `mods/<name>/`, with its `.claude-plugin/plugin.json` and `hooks/`.
2. Add an entry for it to `.claude-plugin/marketplace.json` with `"source": "./mods/<name>"`.
3. Run `claude plugin validate mods/<name>` and `claude plugin test mods/<name>`.
4. Add a row to the table above.
