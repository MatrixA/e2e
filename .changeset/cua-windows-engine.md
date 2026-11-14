---
"@e2e-dev/cua": patch
---

New package: `@e2e-dev/cua`, a Windows desktop engine on [Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver). `cua()` launches the target's app (an AUMID, an executable, or an app name) on every `app.open()`, reads its front window through UI Automation, and drives it with `screen`, `expect`, the agent, and a `desktop` fixture for selectors, menus, and key chords.
