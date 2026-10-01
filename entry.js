// dsh-boot-animation — Host half.
//
// Two contributions, both required for the overlay to exist at all:
//
//  1. a webserver route serving the clip pool (bytes from ./assets/videos) and
//     a same-origin manifest naming them, and
//  2. an index injection whose head row installs the screen before the shell
//     boots.
//
// The head row is the whole reason this is a plugin rather than a client
// component: the kernel constructs its own boot page synchronously in
// `AppWebEntry`'s constructor, which runs from the shell module script, so only a
// parser-blocking index row executes early enough to pre-empt it.

import { readdir, stat, open } from 'node:fs/promises'
import { createReadStream, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, extname, join, resolve, sep } from 'node:path'

/**
 * Absolute path of the pre-boot screen source.
 *
 * The script is read per index render rather than once at module load. Reading it
 * at load time would pin the served script to whatever the file held when the
 * process started, so editing a label or the exit fade would require restarting
 * dsh — the one operation this plugin's whole design tries to avoid asking for.
 */
const BOOT_SCREEN_PATH = fileURLToPath(new URL('./src/boot-screen.js', import.meta.url))

/** Video container extensions the pool accepts, in discovery order. */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.m4v', '.mov'])

/** Route prefix both the manifest and the clip bytes live under. */
const ROUTE = '/plugins/dsh-boot-animation'

/**
 * Settings namespace this plugin owns.
 *
 * Lowercase-hyphenated because that is the parser's contract, and it is also the
 * key the browser card registers under: the Plugins settings page renders the
 * intersection of the namespaces the Host serves and the cards registered into
 * `settings.plugin.item`, so this one string is what pairs the two halves.
 */
const SETTINGS_NS = 'boot-animation'

/**
 * What the screen does when nothing has been configured, and the value every
 * field falls back to individually — the schema defaults mirror these, so an
 * absent settings document and an empty one behave identically.
 */
const DEFAULT_SETTINGS = {
  /**
   * Whether the screen is injected at all. Off restores DSH's own boot page: the
   * rows are simply not added, so no overlay, no clip request and no script run.
   */
  enabled: true,
  /** How long the dissolve into the app takes. */
  fadeMs: 2000,
  /** When the hand-off happens: see ENTER_MODES. */
  enterMode: 'tail',
  /** Clip file names excluded from the pool by the user. */
  disabledClips: [],
}

/** The schema defaults, in the order the browser card presents them. */
const ENTER_MODES = ['tail', 'end', 'click']

/** Package name the loader mounts this row as. */
export const name = 'dsh-boot-animation'

/** Services this half consumes. */
export const inject = ['webServer']

/** The clip directory, resolved from this module rather than the process cwd. */
const assetDir = fileURLToPath(new URL('./assets/videos', import.meta.url))

/** MIME type served for one clip. */
function contentType(file) {
  switch (extname(file).toLowerCase()) {
    case '.webm': return 'video/webm'
    case '.mov': return 'video/quicktime'
    default: return 'video/mp4'
  }
}

/**
 * Whether the movie box precedes the media data.
 *
 * A player cannot decode a frame until it has read `moov`, so a file whose
 * `moov` sits at the end must be fetched almost in full before anything appears
 * — the usual reason a clip shows nothing but black for a while. This is reported
 * to the browser card, which is where a user can act on it (tools/faststart.mjs
 * rewrites such a file losslessly).
 *
 * The header window is 64 KiB because the order of the first two boxes is NOT the
 * answer: all three clips in this pool carry a ~21 KiB `uuid` metadata box before
 * the media data, so a 1 KiB read saw `ftyp, uuid` and returned no verdict at all.
 * @param absolute - resolved clip path.
 * @returns true when `moov` comes first, false when `mdat` does, undefined when
 *   neither box is found within the header window.
 */
async function readFaststart(absolute) {
  let handle
  try {
    handle = await open(absolute, 'r')
    const head = Buffer.alloc(65536)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    let offset = 0
    while (offset + 8 <= bytesRead) {
      const type = head.toString('latin1', offset + 4, offset + 8)
      if (type === 'moov') return true
      if (type === 'mdat') return false
      const size = head.readUInt32BE(offset)
      if (size < 8) break
      offset += size
    }
    return undefined
  } catch {
    // An unreadable header is not a reason to drop the clip from the pool; the
    // card simply shows no optimisation verdict for it.
    return undefined
  } finally {
    await handle?.close()
  }
}

/**
 * List the clip files currently on disk, newest first.
 *
 * The modification time travels with each path because the manifest publishes it
 * as the clip's revision: the bytes route caches immutably under a filename that
 * carries no revision of its own, so a clip replaced in place must be requested
 * under a new URL or the browser keeps serving the year-old copy it holds.
 * @returns every servable clip with its revision stamp and card metadata.
 */
async function listClips() {
  let entries
  try {
    entries = await readdir(assetDir, { withFileTypes: true })
  } catch (error) {
    // A missing directory is an empty pool, not a failure: the overlay then has
    // nothing to play and the plugin must stay invisible rather than break boot.
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const files = entries
    .filter(entry => entry.isFile() && VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map(entry => join(assetDir, entry.name))
  const stamped = await Promise.all(files.map(async (file) => {
    const info = await stat(file)
    return {
      file,
      // Sorted on the raw time, published rounded: two files written in the same
      // millisecond would tie on the rounded value and order nondeterministically.
      mtime: info.mtimeMs,
      revision: Math.round(info.mtimeMs),
      bytes: info.size,
      faststart: await readFaststart(file),
    }
  }))
  return stamped.sort((left, right) => right.mtime - left.mtime)
}

/** Answer one JSON response. */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Parse one `Range` header against a known length.
 * @param header - raw header value, if present.
 * @param size - complete resource length.
 * @returns inclusive byte range, or undefined for a full response.
 */
function parseRange(header, size) {
  if (typeof header !== 'string') return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return undefined
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return undefined
  if (rawStart === '') {
    const length = Number(rawEnd)
    if (!Number.isFinite(length) || length <= 0) return undefined
    return { start: Math.max(size - length, 0), end: size - 1 }
  }
  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= size) return { unsatisfiable: true }
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (!Number.isFinite(end) || end < start) return { unsatisfiable: true }
  return { start, end }
}

/**
 * Stream one clip, honouring range requests so the browser can seek and so a
 * repeated load does not re-download bytes it already holds.
 * @param absolute - resolved clip path on disk.
 * @param req - incoming request.
 * @param res - outgoing response.
 */
async function serveClip(absolute, req, res) {
  const info = await stat(absolute)
  const type = contentType(absolute)
  const range = parseRange(req.headers.range, info.size)
  if (range?.unsatisfiable === true) {
    res.writeHead(416, { 'content-range': `bytes */${String(info.size)}` })
    res.end()
    return
  }

  // Nothing about a clip response may be stored, complete or not.
  //
  // The overlay replaces the media element when it hands over or skips on, which
  // aborts the in-flight request; whatever arrived is a TRUNCATED body. Any
  // directive that lets the browser keep it — `immutable`, or `no-cache` plus an
  // ETag — turns that into a poisoned cache entry: the next normal reload decodes
  // the fragment, and a clip whose `moov` sits at the end has no index in a
  // fragment, so it paints nothing while a faststart clip still plays. An ETag is
  // no defence, because it only ever claimed the FILE had not changed, never that
  // the copy in hand was complete — and answering `If-None-Match` with 304 is
  // precisely what made the browser confident in a fragment.
  //
  // The cost is that each page load streams the chosen clip again. These are local
  // files over loopback — a few tens of milliseconds — and it buys the only
  // guarantee that matters: what the player decodes is always the whole file.
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  }

  // Streamed from disk rather than read whole and sliced. A browser playing a
  // clip issues many overlapping range requests, and reading a 10 MB file per
  // request holds the whole clip in memory on every one of them; the original
  // implementation did exactly that. Streaming also lets the response start
  // before the file is fully read, which is what keeps playback fed while the
  // element seeks into the parts it still needs.
  const from = range === undefined ? 0 : range.start
  const to = range === undefined ? info.size - 1 : range.end
  res.writeHead(range === undefined ? 200 : 206, {
    ...headers,
    'content-length': String(to - from + 1),
    ...(range === undefined ? {} : {
      'content-range': `bytes ${String(from)}-${String(to)}/${String(info.size)}`,
    }),
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(absolute, { start: from, end: to })
  stream.on('error', () => { res.destroy() })
  res.on('close', () => { stream.destroy() })
  stream.pipe(res)
}

/**
 * Resolve a requested pool path to a file inside the clip directory.
 * @param url - request URL.
 * @returns the absolute path, or undefined when the request is not a pool clip.
 */
function resolveClip(url) {
  const pathname = decodeURIComponent(url.split('?')[0])
  if (!pathname.startsWith(`${ROUTE}/clip/`)) return undefined
  const requested = basename(pathname.slice(`${ROUTE}/clip/`.length))
  if (!VIDEO_EXTENSIONS.has(extname(requested).toLowerCase())) return undefined
  const absolute = resolve(assetDir, requested)
  // Containment: a traversal attempt must not escape the clip directory.
  if (!absolute.startsWith(assetDir + sep)) return undefined
  return absolute
}

/**
 * Mount the clip route and the pre-boot index injection.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  const server = ctx.webServer

  // The registered settings owner scope, once the optional settings service has
  // taken the namespace. Null means "no settings provider in this profile", and
  // every read then answers the defaults.
  let settingsOwner = null

  /**
   * The settings the screen should run with right now.
   *
   * Read per index render rather than cached: the owner resolves a stored edit
   * immediately, and the boot screen is rebuilt from this on the next page load,
   * which is exactly when a new value can take effect.
   * @returns the resolved settings, with every field defaulted.
   */
  function currentSettings() {
    if (settingsOwner === null) return DEFAULT_SETTINGS
    try {
      const stored = settingsOwner.get()
      return {
        enabled: typeof stored?.enabled === 'boolean' ? stored.enabled : DEFAULT_SETTINGS.enabled,
        fadeMs: typeof stored?.fadeMs === 'number' ? stored.fadeMs : DEFAULT_SETTINGS.fadeMs,
        enterMode: ENTER_MODES.includes(stored?.enterMode) ? stored.enterMode : DEFAULT_SETTINGS.enterMode,
        disabledClips: Array.isArray(stored?.disabledClips) ? stored.disabledClips : [],
      }
    } catch (error) {
      ctx.logger?.warn?.('boot-animation: settings unreadable, using defaults', error)
      return DEFAULT_SETTINGS
    }
  }

  // Optional service, so it is reached through `ctx.inject` rather than declared
  // in `inject`: a profile without a settings provider must still boot, and the
  // namespace then stays unserved — which is also what keeps the browser card
  // away, since the Plugins page renders only namespaces the Host actually
  // serves.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => {
      // Imported lazily, and the whole registration is allowed to fail: the
      // plugin's own module imports nothing but node: builtins, so a missing
      // schema package costs the settings surface and nothing else.
      void import('@deepseek-ai/schemastery').then((module) => {
        const z = module.default ?? module
        const schema = z.object({
          enabled: z.boolean().default(DEFAULT_SETTINGS.enabled),
          fadeMs: z.number().min(300).max(5000).default(DEFAULT_SETTINGS.fadeMs),
          enterMode: z.union([...ENTER_MODES]).default(DEFAULT_SETTINGS.enterMode),
          disabledClips: z.array(z.string()).default([]),
        })
        settingsOwner = settingsCtx.settings.register(SETTINGS_NS, schema)
      }).catch((error) => {
        settingsCtx.logger?.warn?.(
          'boot-animation: settings namespace not registered (schema package unavailable)', error,
        )
      })
    })
  }

  ctx.effect(() => server.register({
    kind: 'prefix',
    path: ROUTE,
    handler: (req, res) => {
      void (async () => {
        const url = req.url ?? ''
        if (url.split('?')[0] === `${ROUTE}/clips.json`) {
          const clips = await listClips()
          const disabled = new Set(currentSettings().disabledClips)
          sendJson(res, 200, {
            clips: clips.map(clip => ({
              // The revision is the size+time pair the bytes route also answers as
              // its ETag, and the URL is what makes a stale cache entry unreachable:
              // it changes whenever the file does — or whenever the scheme that
              // produced a bad entry changes. The first scheme (mtime alone) left
              // truncated `immutable` entries that a normal reload kept reusing, and
              // nothing but a hard reload could dislodge them.
              src: `${ROUTE}/clip/${encodeURIComponent(basename(clip.file))}`
                + `?v=${String(clip.revision)}-${String(clip.bytes)}`,
              name: basename(clip.file),
              // Everything on disk is listed, with the pool decision carried as a
              // field. The screen plays only the enabled ones; the settings card
              // needs the whole list to offer them back.
              enabled: !disabled.has(basename(clip.file)),
              bytes: clip.bytes,
              faststart: clip.faststart,
            })),
          })
          return
        }
        const absolute = resolveClip(url)
        if (absolute === undefined) {
          sendJson(res, 404, { error: 'not found' })
          return
        }
        try {
          await serveClip(absolute, req, res)
        } catch (error) {
          if (error?.code === 'ENOENT') {
            sendJson(res, 404, { error: 'not found' })
            return
          }
          throw error
        }
      })().catch((error) => {
        ctx.logger?.error?.('boot-animation: clip route failed', error)
        if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
        else res.end()
      })
    },
  }), 'boot-animation: clip route')

  // `ctx.on` already returns a disposer the fiber tracks, so it is registered
  // directly rather than wrapped in an effect — matching the other subscribers
  // of this event (ui-theme, client-modules, client-connection).
  ctx.on('webserver/index-inject', (table) => {
    const settings = currentSettings()

    // Switched off means switched off: no configuration row, no screen script, no
    // overlay, and not one request for a clip. The kernel's own boot page is what
    // shows. Injecting a disabled screen and making the script bail out would look
    // the same and leave the whole thing running; this is the only version of
    // "off" that is actually off.
    if (!settings.enabled) return

    // The row reads a plain global the script fills in, so the injection stays
    // JSON-serializable data and the script itself stays a static asset.
    table.push({
      kind: 'script',
      placement: 'head',
      text: `globalThis.__DSH_BOOT_ANIM_CFG__=${JSON.stringify({
        base: ROUTE,
        manifest: `${ROUTE}/clips.json`,
        holdMs: 15000,
        fadeMs: settings.fadeMs,
        enterMode: settings.enterMode,
      })}`,
    })
    table.push({ kind: 'script', placement: 'head', text: bootScreenSource() })
  })
}

/**
 * The pre-boot screen source, re-read on every index render.
 *
 * Synchronous because the injection table is collected synchronously; the file is
 * a few kilobytes and read once per page load, not per request in a hot path.
 * A missing or unreadable file must not blank the boot page: the caller then
 * serves the kernel page alone, which is the documented fallback.
 * @returns the script text, or an empty string when the source cannot be read.
 */
function bootScreenSource() {
  try {
    return readFileSync(BOOT_SCREEN_PATH, 'utf8')
  } catch (error) {
    process.emitWarning(`boot-animation: cannot read ${BOOT_SCREEN_PATH}: ${String(error)}`)
    return ''
  }
}
