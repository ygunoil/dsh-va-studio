---
name: va-studio-example
description: Check whether the VA Studio example plugin is mounted and read its configured greeting.
---

# VA Studio example

Call the `va_studio_status` tool when the user asks whether the VA Studio example plugin is
loaded, which version it runs, or which greeting its patch config supplied. Read the tool result
as JSON and report `plugin`, `version` and `greeting` verbatim; report `workspace` only when the
user asked about the current workspace.

Do not call the tool for general programming tasks, and do not ask the user for credentials:
the tool is read-only and needs no configuration.
