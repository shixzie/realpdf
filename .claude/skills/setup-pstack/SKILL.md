---
name: setup-pstack
description: Configure which model pstack uses per role. Detects the models the Agent tool accepts and writes the model sheet `.claude/pstack-models.md` that the pstack skills read. Use for /setup-pstack, "configure pstack models", or changing pstack's model choices.
---

# Setup pstack

Write `.claude/pstack-models.md`, the model sheet that sets pstack's model per role. Claude Code does not load this file on its own. Each skill that spawns subagents (`poteto-mode` and its playbooks, `how`, `why`, `arena`, `architect`, `interrogate`, `swarm`, `reflect`) reads its role line from the sheet when it spawns, so a change applies from the next spawn.

## Steps

### 1. Detect available models

The valid values are the ones the `Agent` tool's `model` parameter accepts in this session. Read them from its schema. In Claude Code they are the family aliases, such as `opus`, `fable`, `sonnet`, and `haiku`, and each alias resolves to that family's current model. If the schema does not list them, ask the user to paste the model names they have access to. Never write a model you have not confirmed is available. The aliases `inherit-parent` and `auto` are always valid even though the tool does not list them. Both mean the role runs on the parent session's model, so the skill leaves `model` unset.

### 2. Load current state

The default role-to-model mapping is the sheet shown in step 5 below. It matches the defaults written in each skill. If `.claude/pstack-models.md` already exists, read it and treat its role values as the current choices. Otherwise start from those defaults. A line whose role is not in step 5, such as `how critics`, is from a retired role. Drop it. A `# budget` line or an `alwaysApply` header comes from the Cursor version of this skill and does nothing in Claude Code. Drop it too.

### 3. Map and confirm

**(a) Build the working table.** Start from the defaults. On a re-run, keep every role the user changed, whether to another model, a different panel list, or an alias.

**(b) Show the roles and confirm.** Show every role with its model, marking any value not in the detected set as needing a choice. Also list each line step 2 dropped. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent` and `auto` as the options. Prefer AskUserQuestion over free text. For panel roles (arena runners, architect runners, interrogate reviewers) the value is a list, and one subagent runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena picks one value from it whose model family differs from the parent's when possible. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.

**(c) Reasoning effort.** The `Agent` tool takes a model, not a reasoning effort, so the sheet has no budget. Subagents run at the effort their agent definition sets, else the session's effort. If the user asks for more or less reasoning, point them at `/effort` for the session, or at an `effort` field in the frontmatter of an agent definition under `.claude/agents/`, such as `poteto-agent.md`.

### 4. Validate

Every model written must be in the detected set. `inherit-parent` and `auto` always pass. If a chosen model is not available, stop and ask again.

### 5. Write the sheet

Write `.claude/pstack-models.md` with a `description` header and one line per role, using the same labels poteto-mode uses. Overwrite the whole file so re-runs stay idempotent. The defaults:

```
---
description: pstack per-role model choices (overrides skill defaults)
---
# pstack model configuration. One line per role. Delete a line to fall back to the skill default.
# `inherit-parent` or `auto` as a value: the role runs on the parent session's model (the skill omits the Agent `model`). Alias entries in a panel list still count toward its fan-out.
feature, refactoring: sonnet
bug-fix: sonnet
perf-issue: sonnet
hillclimb: sonnet
judgment and prose: opus
hardest tasks: opus
how explorer: sonnet
how explainer: opus
why investigators: sonnet
why synthesizer: opus
reflect tooling: fable
reflect judgment, divergent, synthesizer: opus
arena runners: opus, fable, sonnet
arena cross-judge pool: opus, fable, sonnet
swarm workers: sonnet
architect runners: opus, fable, sonnet
interrogate reviewers: opus, fable, sonnet
```

### 6. Confirm

Tell the user the sheet was written and that the next subagent spawn picks it up. Commit it so every session in the repo uses the same choices. Re-running this skill updates it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /create-verification-skill." On yes, invoke `/create-verification-skill`. On no, move on without pushing.
