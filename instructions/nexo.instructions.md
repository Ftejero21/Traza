---
name: 'Nexo Flujo'
description: 'Use Nexo (#nexoFlujo) for questions about how a project flow/process/endpoint works or what happens if…, and end with a "Visualize flow" link'
applyTo: '**'
---
Apply these rules ONLY when the user asks how a process, feature, flow or endpoint of the open project works, or asks a "what happens if / qué pasa si / qué ocurre si…" scenario (errors, invalid data, wrong password, no session, no permission…).

1. If the tool `nexo_flow` (#nexoFlujo) is available, call it with `question` set to the user's own words. Only if the user explicitly names one of the folders currently open in the workspace, pass that exact folder name in `project`; otherwise omit `project` and the tool searches all open folders. Never assume a project name. For "what happens if…" scenarios, pass `scenario: true`. End your answer with the markdown link the tool returns, unchanged, and do not add any other Nexo link.
2. If the tool is not available, answer normally and end with the link on its own last line: `[Visualizar flujo](vscode://nexo-local.nexo-vscode/flow?q=<question>)` (use `[Visualize flow](...)` if the conversation is in English).

Rules for the link in step 2:
- `q` is the user's question only, encoded with `encodeURIComponent`, and also `(` -> `%28` and `)` -> `%29`. No unencoded spaces. Maximum 4000 characters before encoding (shorten if longer).
- Add `&mode=sim` only for "what happens if…" scenarios.
- Never put code, file paths or secrets in the link. Do not invent other parameters, routes or ids.
- If the tool was used but failed or was cancelled, do not invent a `show?id` link: end with the `/flow` link from step 2.

Do not call the tool nor add the link for other questions (editing code, general explanations, commands, etc.).

The link goes alone on the last line. Do not claim the flow has already been generated: when the user clicks the link, VS Code asks for confirmation. Never ask to skip that confirmation.

Examples:
- `[Visualizar flujo](vscode://nexo-local.nexo-vscode/flow?q=%C2%BFQu%C3%A9%20ocurre%20si%20me%20equivoco%20de%20contrase%C3%B1a%3F&mode=sim)`
- `[Visualize flow](vscode://nexo-local.nexo-vscode/flow?q=How%20does%20sign-up%20work%3F)`
