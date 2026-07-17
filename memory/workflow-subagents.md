---
name: workflow-subagents
description: Pedro wants implementation work done by sonnet/opus subagents, not by the lead model directly
metadata:
  type: feedback
---

Instruction given 2026-07-16 during the agent-sessions-backup build: "use sonnet or opus subagents for implementation."

**Why:** cost/efficiency — the lead (Fable/Mythos-class) session should orchestrate, review, and integrate; bulk code-writing and operational babysitting belong in cheaper subagents.

**How to apply:** for each implementation chunk (feature slice, script, infra task), spawn an Agent (general-purpose) with `model: "sonnet"` — escalate to `"opus"` for the trickiest pieces (parsers, auth flows). Lead reviews diffs, keeps architectural decisions, runs final gates. See [[project-decisions]].
