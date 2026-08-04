# @dsh-external/distill

English | [中文](README.zh.md)

## Install (dshx / Marisa external plugin)

```sh
dshx install distill <dir|git-url>
```

- Manifest id: `distill` (dsh.plugin.json); contributes no model-facing tools
  or skills — it only hooks `agent/settled` and runs background reviews.
- **Host prerequisites**: the dsh composition (cordis.yml) must mount
  `subagent-spawn` (registers the `spawn` subagent provider the review child
  uses) and `tool-skill` (the `skill` viewer the child may call) — both are
  present by default in `base.cordis.yml`.
- Remove: `dshx remove distill`.

## Overview

Automatic conversation reflection and skill distillation.

Requires `ctx.subagents` (`inject: ['subagents']`) with a registered subagent provider — the `subagent-spawn` plugin registers the default `spawn` provider — and the model-facing `skill` tool (`tool-skill`) in the deployment so the review child can view skills. The review prompt adapts Nous Research's [hermes-agent](https://github.com/NousResearch/hermes-agent) `_SKILL_REVIEW_PROMPT` (MIT License, Copyright (c) 2025 Nous Research), reworked for this surface; the full attribution lives in the source header.

## Behavior

On every `agent/settled` with a `completed` reason, the plugin collects the human `user/message` events appended since the last recorded distillation checkpoint and, once their count reaches `minUserMessages`, spawns one background review subagent (Hermes Agent's background-review shape: a fresh child with a restricted toolset, running after the turn, never competing with the user's task). The child's prompt carries the Hermes curation curriculum, the framed message window, and the list of updatable skills; its toolset is whitelisted to the `skill` viewer and its final answer is captured through the structured-output contract. The dispatch records itself as a log-only `session/distill-review-request` event carrying the exact route, prompt, tool whitelist, and token cap, so the model-visible input is reconstructable from the session log.

The review child proposes one of:

- `{"action": "skip"}` — nothing worth saving; the pass ends.
- `{"action": "create", "skill": {"name", "description", "whenToUse?", "content"}}` — a new skill, written as a frontmatter `SKILL.md` bundle that the local skill provider discovers like any hand-authored skill.
- `{"action": "update", "skill": {...}}` — a complete replacement of one previously distilled skill.

Every proposal is validated (kebab-case name via `isSkillName`, non-empty description and content). A create is skipped when the target file already exists. An update is applied only when the target file exists AND carries the plugin's `distilled-by: dsh-distill` frontmatter ownership marker; missing or non-distill-owned targets are skipped with a warning, so user-authored, bundled, and runtime-registered skills are never rewritten. Distilled files carry the marker, and only marked skills appear in the child's updatable list. The checkpoint advances to the last reflected message regardless of outcome, so each pass covers only new messages.

The review route is the explicit `provider`/`model` pair when both are configured, otherwise the settled agent's own `agent.options` route. When neither exists the pass is skipped with a warning. The child runs on the subagent provider named by `providerName`; a missing provider or a failed, cancelled, or capture-less run logs a warning and never crashes the loop.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `minUserMessages` | `3` | New human user messages required before one review runs. |
| `provider` / `model` | unset | Explicit auxiliary route; must be supplied together. Defaults to the agent's own route. |
| `maxTokens` | `2048` | Review subagent output-token cap. |
| `timeoutMs` | `30000` | End-to-end review deadline. |
| `targetRoot` | `project` | `project` writes to `<git-root>/.agents/skills`; `user` writes to `~/.agents/skills`. |
| `providerName` | `spawn` | Subagent provider registry name used for the review child. |
| `allowUpdate` | `true` | Whether the review may update previously distilled skills; `false` offers create only. |

## Model Experience

No tool or prompt is registered on the main conversation; the plugin never changes its surface. The only model-visible effects are indirect: a review subagent runs in the background with the `skill` tool (it sees the same catalog the main agent sees and may view any skill's content before proposing), and a written or updated skill appears in the `dsh-tool-skill` catalog on later turns. The review dispatch itself is a logged auxiliary delegation invisible to the conversation loop.

## Known Limitations and Deferred Work

- **Full-file updates only** — an update rewrites the whole `SKILL.md`; there is no partial patch or support-file (`references/` / `templates/` / `scripts/`) writing. The prompt folds support-file intent into the body or skips it.
- **Ownership marker is opt-in by origin** — skills distilled before this change carry no `distilled-by` marker and are treated as user-owned (never updated) until the user re-creates or manually marks them.
- **In-memory checkpoint derivation** — the checkpoint is derived from the last logged `session/distill-review-request`; a session that never reviewed starts from its first user message.
- **Project target needs a git root** — without a `.git` ancestor the project target falls back to the session cwd.
- **One in-flight pass per session** — a settled turn arriving during a running review is skipped; the next settle re-evaluates.
- **Review child needs the deployment's tools** — the child's `skill` tool and catalog come from `tool-skill` in the same deployment; a deployment without it still runs the review, but the child cannot view skills before proposing.
