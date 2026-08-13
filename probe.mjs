/**
 * distill probe: boot the real dsh composition (base + personal overlay)
 * without any API key and assert the externally mounted distill plugin's
 * Loader entry is present and its fiber is active. distill registers no
 * model-facing tools and only reacts to `agent/settled`, so no event needs
 * firing here — an active fiber with no Loader error is the whole contract.
 *
 * The host's base.cordis.yml already mounts the in-repo `@deepseek-ai/dsh-distill`
 * under the same id `distill`; two entries with one id cannot coexist in one
 * tree, so this probe boots a copy of base.cordis.yml with the builtin distill
 * block removed — the exact state of a host that switched to the external
 * plugin — while every other entry stays verbatim. All entry names in
 * base.cordis.yml are bare package specifiers, and under the tsx source
 * launch the Loader resolves bare specifiers through plain ESM (not
 * baseUrl), so the temp copy's location does not change resolution.
 *
 * Run from the dsh checkout so tsx picks up its tsconfig paths:
 *   cd <dsh-checkout> && node --import tsx/esm /root/plugin-repos/distill/probe.mjs
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { boot, loadPersonalPatches } from '@deepseek-ai/dsh-app-boot'

/** Fiber state constant mirrored from cordis FiberState (ACTIVE = 2). */
const FIBER_ACTIVE = 2

/** Locate the dsh checkout from the `dsh` launcher on PATH. */
function resolveCheckout() {
  const pathDirs = (process.env.PATH ?? '').split(/[:;]/)
  for (const dir of pathDirs) {
    const launcher = resolve(dir, 'dsh')
    if (!existsSync(launcher)) continue
    const real = realpathSync(launcher)
    const candidate = resolve(real, '..', '..')
    if (existsSync(resolve(candidate, 'packages'))) return candidate
  }
  throw new Error('probe: cannot locate the dsh checkout (put dsh on PATH)')
}

/**
 * Copy a base cordis.yml to a temp file, dropping the top-level entry whose
 * `- id:` line matches `matchId` (the whole block, through the next top-level
 * `- ` item or EOF). Returns the temp file path.
 */
function stripEntry(basePath, matchId) {
  const lines = readFileSync(basePath, 'utf8').split('\n')
  const pattern = new RegExp(`^- id: ${matchId}\\s*$`)
  const out = []
  let skipping = false
  for (const line of lines) {
    if (!skipping && pattern.test(line)) {
      skipping = true
      continue
    }
    if (skipping) {
      if (/^-\s/.test(line)) skipping = false
      else continue
    }
    out.push(line)
  }
  const dir = mkdtempSync(join(tmpdir(), 'distill-probe-'))
  const file = join(dir, 'base.cordis.yml')
  writeFileSync(file, out.join('\n'))
  return file
}

const checkout = process.env.DSH_CHECKOUT ?? resolveCheckout()
const originalConfig = resolve(checkout, 'apps/cli/config/base.cordis.yml')
const configPath = stripEntry(originalConfig, 'distill')
// Take the real personal overlay but keep only the distill insert: unrelated
// overlay entries are shared-machine state that could break the probe's boot
// (e.g. a concurrently installed telegram bot with no token fails activation,
// and the package-name-mounted mygo-panel cannot resolve from the temp
// copy's baseUrl). The probe's contract is "distill mounts and activates in
// the real base composition", so only its insert is needed.
const personal = loadPersonalPatches('distill-probe') ?? []
const distillInsert = personal
  .flatMap((patch) => (Array.isArray(patch.insert) ? patch.insert : []))
  .filter((entry) => entry.id === 'distill')
const patches = [{ insert: distillInsert }]
console.log(`probe: booting ${originalConfig} minus builtin distill → ${configPath}`)
console.log(`probe: distill insert from personal overlay: ${distillInsert.length} entry(ies)`)

const ctx = await boot('distill-probe', configPath, patches, (ctx) => {
  // base.cordis.yml evaluates `!!js launcherSessionQueryPath ?? ...` against
  // the entry context; the real launchers provide this key (tui.ts).
  ctx.provide('launcherSessionQueryPath', '/root/.dsh/sessions/query-probe.db')
})

// boot() already rejects when any enabled entry failed or stayed inactive
// (assertEntriesActivated); find the distill entry for an explicit assertion.
// Inserted entries carry `options.id` = manifest id and `options.name` = the
// absolute plugin path, so match on the id.
const entry = [...ctx.loader.entries()].find((candidate) => candidate.options.id === 'distill')
const state = entry?.fiber?.state
console.log('distill entry:', entry?.options.name ?? '(missing)')
console.log('distill fiber state:', state, '(2 = ACTIVE)')
console.log('distill disabled:', entry?.disabled ?? '(missing)')

await ctx.fiber.dispose()
process.exit(entry !== undefined && !entry.disabled && state === FIBER_ACTIVE ? 0 : 1)
