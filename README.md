# @dsh-external/distill

## 安装（mygo 外部插件）

```sh
mygo install distill <目录|git-url>
```

- 清单 id：`distill`（dsh.plugin.json）；不注册任何面向模型的工具或技能——它只挂接 `agent/settled` 并运行后台反省。
- **宿主前提**：dsh 组合（cordis.yml）必须挂载 `subagent-spawn`（注册反省子代理使用的 `spawn` 子代理提供方）与 `tool-skill`（子代理可调用的 `skill` 查看器）——两者在 `base.cordis.yml` 中默认存在。
- 卸载：`mygo remove distill`。

## 概述

自动对话反思与技能蒸馏。

需要 `ctx.subagents`（`inject: ['subagents']`）以及已注册的子代理提供方——`subagent-spawn` 插件注册了默认的 `spawn` 提供方——并且部署中包含面向模型的 `skill` 工具（`tool-skill`），反省子代理才能查看技能。反省提示词改编自 Nous Research 的 [hermes-agent](https://github.com/NousResearch/hermes-agent) `_SKILL_REVIEW_PROMPT`（MIT 许可，Copyright (c) 2025 Nous Research），针对本界面做了改写；完整署名见源文件头。

## 行为

每次 `agent/settled` 以 `completed` 原因结束时，插件会收集自上次蒸馏检查点以来新增的人类 `user/message` 事件；数量达到 `minUserMessages` 后，派发一个后台反省子代理（Hermes Agent 后台反省的形态：受限工具集的全新子代理，在回合之后运行，从不与用户任务争抢）。子代理的提示词携带 Hermes 策展课程、消息窗口帧和可更新技能列表；其工具集白名单只保留 `skill` 查看器，最终答案通过结构化输出契约捕获。该派发会以仅日志的 `session/distill-review-request` 事件记录精确的路由、提示词、工具白名单和 token 上限，使模型可见输入可从会话日志中重建。

反省子代理提议以下之一：

- `{"action": "skip"}` — 无值得保存的内容；本轮结束。
- `{"action": "create", "skill": {"name", "description", "whenToUse?", "content"}}` — 一个新技能，写成带 frontmatter 的 `SKILL.md` 包，本地技能提供方会像发现手写技能一样发现它。
- `{"action": "update", "skill": {...}}` — 对某个先前蒸馏出的技能的完整替换。

每个提议都会经过校验（通过 `isSkillName` 校验 kebab-case 名称，描述和内容非空）。目标文件已存在时 create 被跳过。只有目标文件存在**且**带有插件 `distilled-by: dsh-distill` frontmatter 所有权标记时 update 才会被应用；缺失或非蒸馏所有的目标会跳过并记录警告，因此用户手写、内置和运行时注册的技能永远不会被重写。蒸馏出的文件都带该标记，且只有带标记的技能会出现在子代理的可更新列表中。无论结果如何，检查点都会推进到最后一条已反思消息，因此每轮只覆盖新消息。

反思目标优先使用显式配置的 `provider`/`model` 对（两者需同时配置），否则使用已结束 agent 自身的 `agent.options` 路由。两者都不存在时本轮跳过并记录警告。子代理运行在 `providerName` 指定的子代理提供方上；提供方缺失、或运行失败、被取消、无捕获结果时只记录警告，绝不会使循环崩溃。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关。 |
| `minUserMessages` | `3` | 触发一次反省所需的新增人类用户消息数。 |
| `provider` / `model` | 未设置 | 显式辅助路由；必须同时提供。默认使用 agent 自身路由。 |
| `maxTokens` | `2048` | 反省子代理输出 token 上限。 |
| `timeoutMs` | `30000` | 反省的端到端截止时间。 |
| `targetRoot` | `project` | `project` 写入 `<git-root>/.agents/skills`；`user` 写入 `~/.agents/skills`。 |
| `providerName` | `spawn` | 反省子代理使用的子代理提供方注册名。 |
| `allowUpdate` | `true` | 是否允许反省更新先前蒸馏出的技能；`false` 时只提供 create。 |

## 模型体验

主对话不注册任何工具或提示，插件从不改变其表面。唯一的模型可见效果是间接的：后台运行一个带 `skill` 工具的反省子代理（它看到与主 agent 相同的目录，可在提议前查看任意技能内容），写入或更新的技能会在后续轮次出现在 `dsh-tool-skill` 目录中。反省派发本身是记录在日志中的辅助委派，对话循环不可见。

## 已知限制与后续工作

- **仅整文件更新** — update 会重写整个 `SKILL.md`；不支持局部补丁或支持文件（`references/` / `templates/` / `scripts/`）写入。提示词把支持文件意图并入正文或跳过。
- **所有权标记按来源选择** — 本变更之前蒸馏出的技能没有 `distilled-by` 标记，会被当作用户所有（永不更新），除非用户重新创建或手动标记。
- **内存检查点推导** — 检查点从最近一条已记录的 `session/distill-review-request` 推导；从未反省过的会话从第一条用户消息开始。
- **项目目标需要 git 根** — 没有 `.git` 祖先时，项目目标回退到会话 cwd。
- **每个会话一次进行中的反省** — 反省进行期间到达的已结束回合会被跳过；下一次结算会重新评估。
- **反省子代理依赖部署的工具** — 子代理的 `skill` 工具和目录来自同一部署中的 `tool-skill`；没有它的部署仍会运行反省，但子代理在提议前无法查看技能。
