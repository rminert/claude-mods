# cache-countdown

Claude Code caches the conversation it sends the model. While the cache is warm, each message re-reads the conversation at about a tenth of the normal input price. The cache expires an hour after the last request (five minutes while a session is in usage overage). After that, the next message pays full price to rebuild it and the first reply is slower. This mod shows how long you have left, and gives you two ways to avoid paying that cost.

## What it adds

A band above the prompt:

- **Cache warm · 42:13** and a small bar that drains, green, then amber in the last five minutes, then red once the cache is cold.
- A line saying how much conversation is cached, or, once cold, what your next message will cost to rebuild.
- **Keep warm**: keeps the cache alive while you're away (at lunch, in a meeting). Five minutes before the cache would expire, it asks one tool-less side question over the cached conversation. That restarts the hour without adding anything to the transcript. Each ping costs about one cached read of the conversation. Keep-warm switches off when you send your next message, or after four hours.
- **Handoff**: writes a prompt a brand-new session can start from (goal, where it stands, decisions made, key files, next steps, gotchas). Do it while the cache is warm, and it's cheap. It opens in a side pane with a **Copy** button and is saved to `~/.claude/handoffs/<project>-<time>.md`. Then start fresh instead of reviving a large, cold context.

Commands: `/keepwarm` (toggle), `/keepwarm on|off`, `/keepwarm 1.5` (hours), and `/handoff`.

## Settings

Set under `pluginConfigs` in `~/.claude/settings.json`, or in the config menu of a terminal session:

| Setting | Default | |
| --- | --- | --- |
| `ttlMinutes` | 60 | Cache lifetime. Set 5 while a session is in usage overage. |
| `pingLeadMinutes` | 5 | How long before expiry keep-warm pings. |
| `warnMinutes` | 5 | Toast when this much time is left and keep-warm is off; 0 turns it off. |
| `keepWarmMaxHours` | 4 | Keep-warm switches itself off after this long. |
| `stopWhenBack` | true | Keep-warm switches off when you send your next message. |

## Limits

The countdown starts from the last request it saw. The first time the mod loads, it assumes the cache was just written. It cannot tell whether a session is in usage overage, so set `ttlMinutes` yourself then.
