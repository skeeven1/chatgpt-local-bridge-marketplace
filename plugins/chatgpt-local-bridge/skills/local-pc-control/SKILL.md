---
name: local-pc-control
description: Use ChatGPT Local Bridge automatically whenever the user asks to do something on their own Windows PC or an allowed local workspace.
---

# ChatGPT Local Bridge workflow

Use the local bridge automatically when the user's intent is to act on their own Windows PC or an allowed workspace. The user should speak normally and should never need to name a tool.

## Core behavior

- Infer the requested action from natural language and call the smallest relevant bridge tools yourself.
- Do not ask the user to type tool names, JSON, coordinates, or shell commands.
- For GUI work, inspect before acting: use `screen_capture`, `screen_info`, or `list_windows` as needed.
- After GUI changes, capture the screen again and verify the visible result before claiming success.
- For precise UI work, use the blue-overlay mouse tools and re-check the screen between meaningful stages.
- For Paint/image tasks, prefer high-fidelity target rendering when the user wants the final image; use visible mouse rendering when the user explicitly wants to watch the drawing process. Verify the result afterward.
- For development tasks, read the relevant files, make bounded edits only inside configured workspaces, run the appropriate typecheck/test/build, then inspect diff/status before reporting completion.
- Prefer existing package scripts (`npm_script` / `run_task`) over arbitrary command execution. There is no arbitrary remote shell capability.
- Never claim an app opened, a file changed, a test passed, or a drawing succeeded until the local tool result or a post-action screen capture verifies it.
- If an operation is destructive or sensitive, follow the bridge's confirmation requirements rather than weakening them.

## Typical mappings

- "ouvre Paint" → discover/launch Paint, then verify with windows or screen capture.
- "dessine Gojo dans Paint" → ensure Paint is visible, create or receive a target image, render it, capture the result, compare/correct if needed.
- "modifie DoOnce pour X" → inspect `doonce`, edit only the needed files, run typecheck/tests/build as appropriate, inspect diff, restart/verify if relevant.
- "ouvre Rayman" → discover the installed app, launch the resolved GUI entry, verify the process/window.

## Safety boundary

Stay within the bridge's exposed structured tools. Do not invent a hidden shell, encode commands to evade controls, or access paths outside configured workspace roots.
