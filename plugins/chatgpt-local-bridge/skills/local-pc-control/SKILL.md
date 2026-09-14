---
name: local-pc-control
description: Execute requests on the user's own Windows PC automatically through ChatGPT Local Bridge. PC-action requests must be performed locally rather than merely simulated in chat.
---

# ChatGPT Local Bridge — mandatory local-action routing

When this plugin is active and the user asks to **do something on their own Windows PC**, treat that as an action request, not as a request for a chat-only answer. The user speaks normally and never needs to name a tool.

## Highest-priority routing rules

- If the request contains an explicit PC action such as **open, launch, click, type, draw in Paint, edit a local project, run tests, build, inspect the screen, or verify an app**, invoke the relevant bridge tool before giving a normal response.
- **Never satisfy a PC-action request merely by generating an image, writing instructions, or describing what would happen.** Perform it through the bridge when the required capability exists.
- In particular, requests equivalent to **“ouvre Paint et dessine X” / “draw X in Paint” MUST use `draw_in_paint`.** Generate a self-contained SVG representation of X yourself and pass that SVG to the tool.
- Do **not** use native chat image generation as the final action for a Paint request. Native image generation is appropriate only when the user explicitly asks for an image in the chat rather than an action on their PC.
- Prefer `draw_in_paint` over manually chaining low-level mouse tools. Use low-level mouse tools only for UI correction, interaction, or when the user explicitly wants the visible mouse-drawing mode.

## GUI workflow

- Inspect before precise interaction with `screen_capture`, `screen_info`, or `list_windows` when needed.
- Use the blue-overlay mouse tools for clicks, drags, scrolling, and visible mouse drawing.
- After GUI changes, capture the screen again and verify the result before claiming success.
- `draw_in_paint` already opens/focuses Paint, rasterizes the SVG locally, renders it, captures the desktop, and attempts visual verification.

## Development workflow

For requests such as “modifie DoOnce pour X”:
1. inspect the relevant files inside the configured workspace;
2. make bounded edits only inside that workspace;
3. run typecheck/tests/build as appropriate;
4. inspect diff/status;
5. restart/verify the app if relevant;
6. report only verified results.

Prefer existing package scripts (`npm_script` / `run_task`). There is no arbitrary remote shell capability.

## Examples

- “ouvre Paint” → `launch_app` for Paint, then verify.
- “ouvre Paint et dessine Gojo” → create a detailed self-contained SVG portrait and call **`draw_in_paint`**. Do not answer with a chat-generated image.
- “dessine-le à la souris” → `draw_in_paint` with `mode: mouse`, then screen-capture and correct if needed.
- “ouvre Rayman” → discover/launch Rayman and verify its window/process.
- “corrige DoOnce puis teste” → inspect/edit workspace files, run tests/typecheck/build, inspect diff, verify.

## Safety boundary

Stay within exposed structured tools. Do not invent a hidden shell, encode commands to evade controls, or access paths outside configured workspace roots.
