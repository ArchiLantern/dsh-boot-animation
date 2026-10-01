# AGENTS.md — dsh-boot-animation

Maintainer briefing. Written for whoever (or whatever) picks this up next: what the
package is, which two facts about DSH it depends on, the invariants that break it
silently, and how to prove a change is safe.

Human-facing usage lives in [MANUAL.md](MANUAL.md). The long forensic record —
every bug, why it happened, what the evidence was — is [README.md](README.md).
Read this file first; go to README only for the history of a specific symptom.

## What it is

A DSH plugin that replaces the kernel's boot page with a full-window video clip,
then dissolves into the app. No DSH source is modified: it injects a script into
`<head>` ahead of the shell, and contributes a card to Settings → Plugins.

| Half | File | Job |
|---|---|---|
| Host (Node) | `entry.js` | Serves clips over HTTP with Range, registers a settings namespace, injects the pre-boot screen into the index |
| Browser (pre-boot) | `src/boot-screen.js` | The overlay itself: framework-free, injected as text, must run before the shell |
| Browser (plugin) | `src/client.js` → `lib/client.js` | Reports activation to the overlay, and renders the settings card |

### The two DSH facts everything rests on

1. **`webserver/index-inject` is the only moment early enough.** Rows pushed into
   that table render into `<head>`, ahead of the shell module. Anything later
   cannot pre-empt the boot page. `entry.js` subscribes to it.
2. **The Plugins settings page renders the intersection of two ledgers**: the
   settings namespaces the Host serves, and the cards registered into the
   `settings.plugin.item` slot. The pairing key is the namespace string, spelled
   in both halves (`SETTINGS_NS` / `SETTINGS_NAMESPACE`). `verify-settings.mjs`
   asserts they match, because nothing else can.

## Rules that were each learned the hard way

Every line here cost a real debugging session. They are not style preferences.

| Rule | What happens if it is broken |
|---|---|
| **Never read/write a CJK-bearing source file with PowerShell.** Use the file tools; verify with Node `readFileSync(..., 'utf8')`. | PowerShell 5.1 decodes BOM-less UTF-8 as GBK, and a `Set-Content` round-trip destroys every Chinese character — once collapsed `'…'` into `鈥?` and broke the script. |
| **No backtick anywhere inside a CSS blob** (the screen's `style()` string, the card's `CSS` string). | The string ends early and the build keeps the *previous* artifact. It looks like the change had no effect. |
| **Read optional services with `ctx.inject([...], (owner) => owner.get(name))`.** Never `ctx.get(name)`. | `ctx.get` is a one-shot read that races activation and silently answers `undefined`; the card then never registers and there is no error anywhere. Every other client plugin in the deployment uses the `ctx.inject` form. |
| **The client half declares no `inject`.** | A required service leaves the fiber PENDING in a profile that lacks it, `apply` never runs, `clientReady` is never sent, and the animation refuses to hand over. |
| **Serve clips `cache-control: no-store`, always.** | The overlay aborts the media request when it replaces the element; anything cacheable stores a truncated body. The next normal reload decodes the fragment — and a clip with `moov` at the end has no index in a fragment, so it paints nothing. A hard reload hides it. `ETag`/`no-cache` does **not** fix this: an ETag only ever claims the file has not changed, never that the copy in hand is complete. |
| **A clip's first frame must be evidenced by decoded data** (`readyState >= 2`, `loadeddata`, `canplay`, advancing time) — **not** by `requestVideoFrameCallback` alone. | The element starts at `opacity: 0` and reveal is what makes it visible, so waiting for a *composited* frame waits on the style change it is itself blocking. The screen locks on the gradient. |
| **A resolved `play()` promise is not a picture.** Keep the 6-second retry armed until a frame is really there. | A clip that starts and never paints leaves the gradient up forever, with no error and no next attempt. |
| **`faststart.mjs` must assert the RESULT** — that the output has `moov` before `mdat`. | It was written checking only the *plan* and its own payload proof, both of which are vacuously true for a file that did not move. It reported success for two sessions while writing byte-identical copies, so "I remuxed it" changed nothing. |
| **Strip comments before any regex assertion on an artifact.** | The bundles are comment-preserving concatenations, so prose explaining an old approach is matched as if it were the approach. This happened twice. |
| **Do not hardcode a user asset's name in a test.** Read it from the manifest. | The clips get renamed; the suite then fails for a reason that has nothing to do with the code. |
| **Do not `spawnSync` with piped stdio.** Import the module and call the function. | The agent sandbox refuses a child process whose output is captured through a pipe (`EPERM`). `stdio: 'inherit'` works, which is why `verify-all.mjs` can spawn its children. |
| **`spawnSync` is why `verify-*` suites must be runnable by `verify-all`** — no interactive prompts, no fixed ports. | A suite that only passes alone is a defect in the suite. |

## Change → restart matrix

| Changed | To see it |
|---|---|
| `src/boot-screen.js` | **Reload the page.** The Host re-reads this file on every index render, so a plain F5 is enough and no restart is needed. |
| `entry.js` (routes, settings schema, injected rows) | **Restart DSH.** The running process holds the old module. |
| `src/client.js` | Rebuild (`node build-client.mjs`), then reload; if the change does not appear, restart — the initial bundle revision is allocated per process. |
| `assets/videos/*` | Reload. The manifest is read per request and clip URLs carry a content revision. |

Installed state: the package is linked into the web profile
(`profiles/web/node_modules/dsh-boot-animation` → this directory) with a one-row
`- insert:` block in the profile's `cordis.patch.yml`. `package.json` is not
modified and no `pnpm install` runs. Revert with
`tools/rollback-live.ps1`, or strip it all with
`tools/deactivate-boot-animation.ps1`.

## Verifying a change

```sh
node build-client.mjs      # only if src/client.js changed
node tools/verify-all.mjs  # 17 offline suites, no system changes
```

What each suite is for is listed at the top of `tools/verify-all.mjs`. The ones
that matter most for correctness rather than wiring:

- `verify-enter-sequence.mjs` — loads `src/boot-screen.js` into a stub DOM with a
  fake clock and runs the hand-off for real. The only way to prove a negative like
  "a ready kernel does not enter while the clip is still playing".
- `verify-client-bundle.mjs` — renders the settings card against a stub React, so
  a render error or a bad prop is caught here rather than in the settings page.
- `verify-faststart.mjs` / `verify-apply-faststart.mjs` — exercise the two tools
  that touch the user's own media, on scratch copies.
- `verify-tree-hygiene.mjs` — no stray files, no orphaned tool, every suite listed
  in the aggregator, every documented path real.

`verify-all.mjs` also injects `NO_PROXY=127.0.0.1,localhost,::1`: the suites fetch
their own loopback servers, and this machine exports an `HTTP_PROXY` with Node
running `--use-env-proxy`, so without the exemption those requests go to the proxy
and fail as `fetch failed` — a red suite for a reason unrelated to the code.

## When someone reports something

| Report | Look at | Most likely |
|---|---|---|
| "Only the background shows" | The hint line (it names the failed clip and reason), then the card's pool rows | A clip that never paints. The loader skips it after 6s and says so. |
| "It works after a hard reload but not a normal one" | Response headers on the clip route | Something became cacheable. It must all be `no-store`. |
| "No card in Settings" | Console for `boot-animation:` warnings; `verify-settings.mjs` | The namespace did not register (schema package not resolvable) or the two namespace spellings disagree. |
| "No sound" | The audio-policy path in `toggleSound` / `startClip` | Expected until the first click; Chromium will not autoplay unmuted. Confirm the hint says 开声音. |
| "It never enters" | The bound table in README ("启动路径上每个走不下去的地方都有上界") | Every route has a bound; if one fired, the hint line says which. |
| "A new clip does not play" | The card's badges | `未优化` → run `tools/apply-faststart.bat`. |

## House rules for this package

- Comments and docs are English; user-facing copy inside the plugin is Chinese.
- Every tool under `tools/` is named in a root document (`verify-tree-hygiene.mjs`
  enforces it) and every verification suite is listed in `verify-all.mjs`.
- Generated `.ps1` / `.bat` / `.cmd` are **pure ASCII** — content, not filename.
- The three user clips are the only media the pool should hold; rewrites keep their
  originals in `assets/videos/originals/`, which the pool ignores because it lists
  regular files only.
