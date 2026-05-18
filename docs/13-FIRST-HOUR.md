# Open Brain — Your First Hour

You just got Open Brain running. Now what? This guide is the **first 60 minutes of actually using it** — what to capture, how to prompt your AI, what to expect, and how to tell whether it's working *for you* (not just running).

If something's broken, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md). For the full prompting reference, see [06-PROMPT-KIT.md](06-PROMPT-KIT.md).

---

## Minute 0–5: confirm it works

Run the universal smoke test:

```bash
./scripts/verify.sh <your-api-url>    # Linux/macOS
.\scripts\verify.ps1 <your-api-url>   # Windows
```

If all 4 checks pass, the server is fine. From here on, everything is about **the AI client side**.

Open your AI client (VS Code Copilot in **agent mode**, Claude Code, Cursor agent, Claude Desktop) and paste:

> Use the `thought_stats` tool to show me my Open Brain stats.

You should get something like:

```
{ "total": 0, "by_type": {}, "top_topics": [], "top_people": [] }
```

A clean zero. That's a working AI client + a working server.

---

## Minute 5–20: your first 5 captures

The temptation is to immediately capture some big technical decision. Don't. **Capture small, varied, real things first** so you have something to search.

Try these in your AI client, one at a time:

> Save this thought: I just set up Open Brain on [your machine] using the [Docker Desktop / Azure / Fly] path. The hardest part was [X].

> Save this thought: I'm working on a project called [your project]. The stack is [...]. The main thing we're trying to figure out is [...].

> Save this thought: Decision — I'm going to try Open Brain for two weeks. If I haven't captured 20 thoughts by [date], I should reconsider whether it fits my workflow.

> Save this thought: Pattern — when I onboard a new tool, I capture a thought about *why* I chose it. Six months later that's the only context that survives.

> Save this thought: Bug I keep hitting — [some real bug you're tracking]. Workaround so far: [...].

Now ask:

> List all my thoughts.

You should see all 5, with auto-extracted metadata (type, topics, people). **No manual tagging.** That's the magic — every thought is queryable later by meaning.

---

## Minute 20–40: search the way you'd actually think

Try these searches. Notice how they work even when the original thought *didn't* use the search words:

> What did I decide about Open Brain itself?

> Search my brain for anything about workflow patterns.

> Show me bugs I'm tracking.

> What's the project I'm currently working on?

The search is **semantic** — it matches by *meaning* via 768-dim or 1536-dim vectors, not by keywords. "Show me bugs I'm tracking" finds your bug capture even though you said "bug I keep hitting", not "tracking".

### When search returns nothing useful

Two common causes:

1. **You don't have enough captures yet.** Below ~10 thoughts, semantic search has nothing to rank. Capture more, try again.
2. **The `threshold` filter is too high.** The default is 0.5. Ask:
   > Search my brain for X with threshold 0.0 and limit 10.

   That returns the closest matches regardless of score, useful for sanity-checking.

---

## Minute 40–60: bake it into your real workflow

The thing that makes Open Brain *work* over months is using it **at the moment a decision happens**, not in batched journaling sessions. Three habits to try:

### 1. After every "I figured it out" moment

The moment you debug something tricky, before you context-switch:

> Save this thought: [Bug name] — root cause was [...]. Fix: [...]. Worth remembering because [...].

Future-you (or future-Claude) will find this 4 months from now when the bug returns in a different shape.

### 2. At the start of every project

> Save this thought: Starting project [X]. Goal: [...]. Constraints: [...]. Non-goals: [...]. Stack: [...]. Tag this with project=[X].

Then every later capture for that project:

> Save this thought, tag project=[X]: [whatever]

…stays scoped. `search_thoughts` with `project=X` returns only that project's context.

### 3. When you switch AI tools

Mid-conversation in Cursor, capture the gist:

> Save this thought: In Cursor, working on [...]. We just agreed to [...]. Next step is [...].

Open VS Code Copilot tomorrow:

> Search my brain for what I was doing in Cursor yesterday.

This is the single highest-value loop. Your context travels with you across tools.

---

## Multi-developer teams (1–3 people)

If you're sharing one Open Brain instance with a teammate, every capture takes a `created_by` parameter:

> Save this thought, created_by=scott: We chose Redis for session caching.

Then filter:

> Show me thoughts created_by=alice from the last 7 days.

Etiquette:
- Tag `project=` so your teammate's contracting work doesn't pollute your search results.
- Use `source=` when capturing from a meeting or doc, so it's clear where the thought came from.
- Periodically run `thought_stats` to see what topics the team has been thinking about.

See [README — Multi-Developer Teams](../README.md#multi-developer-teams) for the full pattern.

---

## What "good" looks like at the 1-month mark

If Open Brain is working *for you*, after a month you should hit moments like:

- You ask Claude about a feature you started in March. Claude searches your brain, finds the original spec capture, the architecture decision, and the bug you hit during prototyping. None of it was in the current chat. ← This is the goal.
- You switch from VS Code Copilot to Cursor and the new tool already knows your project's stack, conventions, and the open question you've been stuck on.
- A teammate asks "why did we decide X?" and you forward them a `search_thoughts` result instead of digging through Slack.

If after a month none of that has happened, you probably aren't capturing at the moment of decision. Add a "capture this" reminder to your IDE snippets or your morning standup template.

---

## What to do next

| Want to… | Read |
|----------|------|
| Get better at prompting clients to use Open Brain features | [docs/06-PROMPT-KIT.md](06-PROMPT-KIT.md) |
| Understand the auto-extracted metadata | [docs/01-ARCHITECTURE.md](01-ARCHITECTURE.md) |
| Set up Slack ingest, Plan Forge integration, or webhooks | [docs/05-CAPTURE-PIPELINE.md](05-CAPTURE-PIPELINE.md) |
| Move from dev box to always-on | [docs/12-HOSTED-CHEAP.md](12-HOSTED-CHEAP.md) |
| Back up your thoughts | [docs/11-DOCKER-DESKTOP-DEVBOX.md → Day-2 operations](11-DOCKER-DESKTOP-DEVBOX.md#day-2-operations) |
