import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SkillService from '@deepseek-ai/dsh-skill'
import SubagentService from '@deepseek-ai/dsh-subagent'
import type { ResolvedSubagentStartRequest, SubagentCapabilities, SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import * as distill from '../src/index.ts'
import { parseReflection, renderSkillFile } from '../src/index.ts'

const DISTILL_MARKER = 'distilled-by: dsh-distill'

/** One structured review outcome fed to every dispatched run. */
class RecordingProvider implements SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }
  readonly inheritsParentContext = false
  readonly requests: ResolvedSubagentStartRequest[] = []
  private readonly structured: unknown
  private readonly stopReason: SubagentResult['stopReason']
  private readonly startError: Error | undefined
  private readonly noCapture: boolean
  private readonly resultPromise: Promise<SubagentResult> | undefined

  constructor(
    name: string,
    structured: unknown,
    options: { stopReason?: SubagentResult['stopReason']; startError?: Error; noCapture?: boolean; resultPromise?: Promise<SubagentResult> } = {},
  ) {
    this.name = name
    this.structured = structured
    this.stopReason = options.stopReason ?? 'completed'
    this.startError = options.startError
    this.noCapture = options.noCapture ?? false
    this.resultPromise = options.resultPromise
  }

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    if (this.startError !== undefined) throw this.startError
    this.requests.push(request)
    return {
      id: SessionId('review-run'),
      localAgent: undefined,
      result: this.resultPromise ?? Promise.resolve({
        output: [],
        structured: this.noCapture ? undefined : this.structured,
        stopReason: this.stopReason,
      }),
      dispose: async () => {},
    }
  }
}

const CREATE_JSON = {
  action: 'create',
  skill: {
    name: 'issue-format',
    description: 'File GitHub issues in the dsh2026/issues format',
    whenToUse: 'when filing an issue',
    content: 'Use [bug][area] title format with a <details> body template.',
  },
}

const UPDATE_JSON = {
  action: 'update',
  skill: {
    name: 'issue-format',
    description: 'File GitHub issues in the dsh2026/issues format',
    content: 'Use [bug][area] title format, and always include a reproduction checklist.',
  },
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function waitForFile(path: string): Promise<void> {
  await vi.waitFor(async () => {
    await expect(readFile(path, 'utf8')).resolves.toBeTruthy()
  }, { timeout: 5000 })
}

function userMessage(session: Session, text: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }], source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

/** Read every review record the ledger holds for one session id. */
async function ledgerRecords(dir: string, sessionId: string): Promise<DistillReviewRequestRecord[]> {
  const filePath = join(dir, 'distill', 'reviews', `${sessionId}.jsonl`)
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return []
  }
  return raw.split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as DistillReviewRequestRecord)
}

/** Pre-write one ledger record (simulating a prior review dispatch). */
async function seedLedgerRecord(dir: string, sessionId: string, record: DistillReviewRequestRecord): Promise<void> {
  const filePath = join(dir, 'distill', 'reviews', `${sessionId}.jsonl`)
  await mkdir(join(dir, 'distill', 'reviews'), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8' })
}

function stubAgent(session: Session, options: { provider?: string; model?: string } = {}): Agent {
  return {
    id: session.id,
    options,
    session,
    ctx: new Context(),
    status: 'idle',
    acceptsNextStep: false,
    send: () => {},
    updateInbox: () => 'not-found',
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    reserveTurnAdmission: () => undefined,
    cancel: () => {},
  } as unknown as Agent
}

async function setup(structured: unknown = CREATE_JSON, options: { stopReason?: SubagentResult['stopReason']; startError?: Error; noCapture?: boolean; resultPromise?: Promise<SubagentResult> } = {}) {
  const ctx = new Context()
  await ctx.plugin(SubagentService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SkillService)
  const provider = new RecordingProvider('spawn', structured, options)
  ctx.subagents.registerProvider(provider)
  const dir = await mkdtemp(join(tmpdir(), 'distill-test-'))
  // Isolate the review ledger under the temp root so tests never touch the
  // real harness home, mirroring the DSH_AGENTS_HOME/HOME stubbing below.
  process.env.DSH_HOME = dir
  return { ctx, dir, provider }
}

afterEach(() => {
  delete process.env.DSH_HOME
})

function settleAgent(ctx: Context, agent: Agent): void {
  agentEvents(ctx, agent).emit('agent/turn-stopping', { turn: 1, signal: new AbortController().signal })
}

describe('dsh-distill', () => {
  it('spawns a review subagent after enough user messages and writes a SKILL.md bundle', async () => {
    const { ctx, dir, provider } = await setup()
    await ctx.plugin(distill, {
      enabled: true,
      minUserMessages: 2,
      provider: 'route',
      model: 'model',
      targetRoot: 'project',
    })
    const session = ctx.sessions.create(SessionId('s1'), {
      meta: { cwd: dir },
    })
    const agent = stubAgent(session)
    ctx.agents.register(agent)
    const s1 = userMessage(session, 'how do I file an issue?')
    const s2 = userMessage(session, 'use [bug][area] format')
    settleAgent(ctx, agent)
    await settle()
    await settle()
    await settle()
    await settle()
    await settle()
    await settle()
    await settle()
    await settle()

    await vi.waitFor(() => { expect(provider.requests).toHaveLength(1) }, { timeout: 5000 })
    expect(provider.requests[0]?.label).toBe('distill-review')
    expect(provider.requests[0]?.agentOptions).toMatchObject({ provider: 'route', model: 'model', maxTokens: 2048 })
    expect(provider.requests[0]?.toolFilter).toEqual({ allow: ['skill'] })
    expect(provider.requests[0]?.outputSchema).toBeDefined()
    const prompt = provider.requests[0]?.prompt[0]
    expect(prompt).toBeDefined()
    expect(prompt?.type).toBe('text')
    if (prompt?.type === 'text') {
      expect(prompt.text).toContain('Updatable skills (distill-owned): none')
      expect(prompt.text).toContain('Reflect on this JSON array of human messages:')
      expect(prompt.text).toContain(JSON.stringify(['how do I file an issue?', 'use [bug][area] format']))
    }
    const records = await ledgerRecords(dir, 's1')
    expect(records).toHaveLength(1)
    expect(records[0]?.messageSeqs).toEqual([s1, s2])
    expect(records[0]?.toolFilter).toEqual({ allow: ['skill'] })

    const filePath = join(dir, '.agents', 'skills', 'issue-format', 'SKILL.md')
    await waitForFile(filePath)
    const content = await readFile(filePath, 'utf8')
    expect(content).toContain('name: issue-format')
    expect(content).toContain('description: File GitHub issues in the dsh2026/issues format')
    expect(content).toContain('whenToUse: when filing an issue')
    expect(content).toContain('Use [bug][area] title format')
    expect(content).toContain(DISTILL_MARKER)
    await rm(dir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })

  it('skips review below the message threshold', async () => {
    const { ctx, dir, provider } = await setup()
    await ctx.plugin(distill, {
      minUserMessages: 5,
      provider: 'route',
      model: 'model',
      targetRoot: 'project',
    })
    const session = ctx.sessions.create(SessionId('s3'), { meta: { cwd: dir } })
    const agent = stubAgent(session)
    ctx.agents.register(agent)
    userMessage(session, 'one')
    userMessage(session, 'two')
    userMessage(session, '   ')
    settleAgent(ctx, agent)
    await settle()
    await settle()

    expect(provider.requests).toHaveLength(0)
    await rm(dir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })

  it('falls back to the agent route when no explicit pair is configured', async () => {
    const { ctx, dir, provider } = await setup()
    await ctx.plugin(distill, { minUserMessages: 1 })
    const session = ctx.sessions.create(SessionId('s4'), { meta: { cwd: dir } })
    const agent = stubAgent(session, { provider: 'agent-route', model: 'agent-model' })
    ctx.agents.register(agent)
    userMessage(session, 'do the thing')
    settleAgent(ctx, agent)
    await settle()

    await vi.waitFor(() => { expect(provider.requests).toHaveLength(1) }, { timeout: 5000 })
    expect(provider.requests[0]?.agentOptions).toMatchObject({ provider: 'agent-route', model: 'agent-model' })
    await rm(dir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })

  it('skips when the review proposes skip', async () => {
    const { ctx, dir, provider } = await setup({ action: 'skip' })
    await ctx.plugin(distill, { minUserMessages: 1, provider: 'route', model: 'model', targetRoot: 'project' })
    const session = ctx.sessions.create(SessionId('s5'), { meta: { cwd: dir } })
    const agent = stubAgent(session)
    ctx.agents.register(agent)
    userMessage(session, 'hello')
    settleAgent(ctx, agent)
    await settle()

    await vi.waitFor(() => { expect(provider.requests).toHaveLength(1) }, { timeout: 5000 })
    await expect(readFile(join(dir, '.agents', 'skills', 'issue-format', 'SKILL.md'), 'utf8')).rejects.toThrow()
    await rm(dir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })

  it('skips writing when the proposed create name already exists', async () => {
    const { ctx, dir, provider } = await setup()
    await ctx.plugin(distill, { minUserMessages: 1, provider: 'route', model: 'model', targetRoot: 'project' })
    const session = ctx.sessions.create(SessionId('s6'), { meta: { cwd: dir } })
    const existing = join(dir, '.agents', 'skills', 'issue-format', 'SKILL.md')
    await mkdir(join(dir, '.agents', 'skills', 'issue-format'), { recursive: true })
    await writeFile(existing, '---\nname: issue-format\ndescription: existing\n---\nold', 'utf8')
    const agent = stubAgent(session)
    ctx.agents.register(agent)
    userMessage(session, 'hello')
    settleAgent(ctx, agent)
    await settle()

    await vi.waitFor(() => { expect(provider.requests).toHaveLength(1) })
    const content = await readFile(existing, 'utf8')
    expect(content).toContain('old')
    expect(content).not.toContain('Use [bug][area] title format')
    await rm(dir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })

  it('updates an existing distill-owned skill with the full replacement', async () => {
    const { ctx, dir, provider } = await setup(UPDATE_JSON)
    await ctx.plugin(distill, { minUserMessages: 1, provider: 'route', model: 'model', targetRoot: 'project' })
    const session = ctx.sessions.create(SessionId('s7'), { meta: { cwd: dir } })
    const existing = join(dir, '.agents', 'skills', 'issue-format', 'SKILL.md')
    await mkdir(join(dir, '.agents', 'skills', 'issue-format'), { recursive: true })
    await writeFile(existing, [
      '---',
      'name: issue-format',
      'description: old description',
      DISTILL_MARKER,
      '---',
      '',
      'old body',
    ].join('\n') + '\n', 'utf8')
    const agent = stubAgent(session)
    ctx.agents.register(agent)
    userMessage(session, 'always include a reproduction checklist')
    settleAgent(ctx, agent)
    await settle()
    await settle()

    await vi.waitFor(() => { expect(provider.requests).toHaveLength(1) }, { timeout: 5000 })
    const prompt = provider.requests[0]?.prompt[0]
    expect(prompt?.type).toBe('text')
    if (prompt?.type === 'text') {
      expect(prompt.text).toContain('Updatable skills (distill-owned): issue-format')
    }
    await vi.waitFor(async () => {
      const content = await readFile(existing, 'utf8')
      expect(content).toContain('always include a reproduction checklist')
      expect(content).toContain(DISTILL_MARKER)
      expect(content).not.toContain('old body')
    }, { timeout: 5000 })
    await rm(dir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })

  it('refuses to update a skill that is not distill-owned', async () => {
    const { ctx, dir } = await setup(UPDATE_JSON)
    await ctx.plugin(distill, { minUserMessages: 1, provider: 'route', model: 'model', targetRoot: 'project' })
    const session = ctx.sessions.create(SessionId('s8'), { meta: { cwd: dir } })
    const existing = join(dir, '.agents', 'skills', 'issue-format', 'SKILL.md')
    await mkdir(join(dir, '.agents', 'skills', 'issue-format'), { recursive: true })
    await writeFile(existing, '---\nname: issue-format\ndescription: user owned\n---\nuser body', 'utf8')
    const agent = stubAgent(session)
    ctx.agents.register(agent)
    userMessage(session, 'hello')
    settleAgent(ctx, agent)
    await settle()
    await settle()

    const content = await readFile(existing, 'utf8')
    expect(content).toContain('user body')
    expect(content).not.toContain('reproduction checklist')
    await rm(dir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })

  it('refuses to update a skill whose file cannot be read', async () => {
    const { ctx, dir, provider } = await setup(UPDATE_JSON)
    await ctx.plugin(distill, { minUserMessages: 1, provider: 'route', model: 'model', targetRoot: 'project' })
    const session = ctx.sessions.create(SessionId('s24'), { meta: { cwd: dir } })
    // SKILL.md exists as a directory, so the ownership read fails.
    const existing = join(dir, '.agents', 'skills', 'issue-format', 'SKILL.md')
    await mkdir(existing, { recursive: true })
    const agent = stubAgent(session)
    ctx.agents.register(agent)
    userMessage(session, 'hello')
    settleAgent(ctx, agent)
    await settle()
    await settle()

    await vi.waitFor(() => { expect(provider.requests).toHaveLength(1) }, { timeout: 5000 })
    await expect(readdir(existing)).resolves.toEqual([])
    await rm(dir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })

  it('refuses to update a missing skill', async () => {
    const { ctx, dir } = await setup(UPDATE_JSON)
    await ctx.plugin(distill, { minUserMessages: 1, provider: 'route', model: 'model', targetRoot: 'project' })
    const session = ctx.sessions.create(SessionId('s9'), { meta: { cwd: dir } })
    const agent = stubAgent(session)
    ctx.agents.register(agent)
    userMessage(session, 'hello')
    settleAgent(ctx, agent)
    await settle()
    await settle()

    await expect(readFile(join(dir, '.agents', 'skills', 'issue-format', 'SKILL.md'), 'utf8')).rejects.toThrow()
    await rm(dir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })

  it('lists only distill-owned skills as updatable in the prompt', async () => {
    const { ctx, dir, provider } = await setup()
    await ctx.plugin(distill, { minUserMessages: 1, provider: 'route', model: 'model', targetRoot: 'project' })
    const session = ctx.sessions.create(SessionId('s10'), { meta: { cwd: dir } })
    const owned = join(dir, '.agents', 'skills', 'owned-skill', 'SKILL.md')
    const unowned = join(dir, '.agents', 'skills', 'hand-written', 'SKILL.md')
    await mkdir(join(dir, '.agents', 'skills', 'owned-skill'), { recursive: true })
    await mkdir(join(dir, '.agents', 'skills', 'hand-written'), { recursive: true })
    await writeFile(owned, `---\nname: owned-skill\ndescription: d\n${DISTILL_MARKER}\n---\nbody`, 'utf8')
    await writeFile(unowned, '---\nname: hand-written\ndescription: d\n---\nbody', 'utf8')
    await writeFile(join(dir, '.agents', 'skills', 'stray.txt'), 'not a skill', 'utf8')
    await mkdir(join(dir, '.agents', 'skills', 'empty-dir'), { recursive: true })
    const agent = stubAgent(session)
    ctx.agents.register(agent)
    userMessage(session, 'hello')
    settleAgent(ctx, agent)
    await settle()
    await settle()

    await vi.waitFor(() => { expect(provider.requests).toHaveLength(1) }, { timeout: 5000 })
    const prompt = provider.requests[0]?.prompt[0]
    expect(prompt?.type).toBe('text')
    if (prompt?.type === 'text') {
      expect(prompt.text).toContain('Updatable skills (distill-owned): owned-skill')
      expect(prompt.text).not.toContain('hand-written')
    }
    await rm(dir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })

  it('honors allowUpdate false by offering no updatable skills', async () => {
    const { ctx, dir, provider } = await setup()
    await ctx.plugin(distill, { minUserMessages: 1, provider: 'route', model: 'model', targetRoot: 'project', allowUpdate: false })
    const session = ctx.sessions.create(SessionId('s11'), { meta: { cwd: dir } })
    const owned = join(dir, '.agents', 'skills', 'owned-skill', 'SKILL.md')
    await mkdir(join(dir, '.agents', 'skills', 'owned-skill'), { recursive: true })
    await writeFile(owned, `---\nname: owned-skill\ndescription: d\n${DISTILL_MARKER}\n---\nbody`, 'utf8')
    const agent = stubAgent(session)
    ctx.agents.register(agent)
    userMessage(session, 'hello')
    settleAgent(ctx, agent)
    await settle()
    await settle()

    await vi.waitFor(() => { expect(provider.requests).toHaveLength(1) }, { timeout: 5000 })
    const prompt = provider.requests[0]?.prompt[0]
    expect(prompt?.type).toBe('text')
    if (prompt?.type === 'text') {
      expect(prompt.text).toContain('Updatable skills (distill-owned): none')
      expect(prompt.text).not.toContain('owned-skill')
    }
    await rm(dir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })

  it('supports the user target root', async () => {
    const { ctx, dir } = await setup()
    await ctx.plugin(distill, {
      minUserMessages: 1,
      provider: 'route',
      model: 'model',
      targetRoot: 'user',
      agentsHome: dir,
    })
    const session = ctx.sessions.create(SessionId('s12'), { meta: { cwd: dir } })
    const agent = stubAgent(session)
    ctx.agents.register(agent)
    userMessage(session, 'hello')
    settleAgent(ctx, agent)
    await settle()
    await settle()

    const filePath = join(dir, '.agents', 'skills', 'issue-format', 'SKILL.md')
    await waitForFile(filePath)
    const content = await readFile(filePath, 'utf8')
    expect(content).toContain('name: issue-format')
    await rm(dir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })

  it('requires provider and model together', () => {
    const ctx = new Context()
    expect(() => {
      distill.apply(ctx, { provider: 'route' })
    }).toThrow(/provider and model must be supplied together/)
    void ctx.fiber.dispose()
  })

  it('does nothing when disabled', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    await ctx.plugin(distill, { enabled: false })
    expect(ctx).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('defaults every field when apply is called without the config schema', () => {
    // `ctx.plugin` coerces through the Config schema, so the `?? default` right
    // sides of validateConfig only run on a schema-free direct apply.
    const ctx = new Context()
    distill.apply(ctx, {})
    void ctx.fiber.dispose()
  })

  it('logs and continues when the review subagent fails to start', async () => {
    const { ctx, dir, provider } = await setup(CREATE_JSON, { startError: 'provider down' as unknown as Error })
    await ctx.plugin(distill, { minUserMessages: 1, provider: 'route', model: 'model', targetRoot: 'project' })
    const session = ctx.sessions.create(SessionId('s13'), { meta: { cwd: dir } })
    const agent = stubAgent(session)
    ctx.agents.register(agent)
    userMessage(session, 'hello')
    settleAgent(ctx, agent)
    await settle()
    await settle()
    await settle()

    // The failed review must not crash the loop; the pending job is released.
    settleAgent(ctx, agent)
    await settle()
    await settle()
    await settle()
    expect(provider.requests).toHaveLength(0)
    await rm(dir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })

  it('logs and continues when the review subagent ends with an error', async () => {
    const { ctx, dir, provider } = await setup(CREATE_JSON, { stopReason: 'error' })
    await ctx.plugin(distill, { minUserMessages: 1, provider: 'route', model: 'model', targetRoot: 'project' })
    const session = ctx.sessions.create(SessionId('s14'), { meta: { cwd: dir } })
    const agent = stubAgent(session)
    ctx.agents.register(agent)
    userMessage(session, 'hello')
    settleAgent(ctx, agent)
    await settle()
    await settle()
    await settle()

    await vi.waitFor(() => { expect(provider.requests).toHaveLength(1) }, { timeout: 5000 })
    await expect(readFile(join(dir, '.agents', 'skills', 'issue-format', 'SKILL.md'), 'utf8')).rejects.toThrow()
    await rm(dir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })

  it('logs and continues when the review child finishes without a structured capture', async () => {
    const { ctx, dir, provider } = await setup(undefined, { noCapture: true })
    await ctx.plugin(distill, { minUserMessages: 1, provider: 'route', model: 'model', targetRoot: 'project' })
    const session = ctx.sessions.create(SessionId('s15'), { meta: { cwd: dir } })
    const agent = stubAgent(session)
    ctx.agents.register(agent)
    userMessage(session, 'hello')
    settleAgent(ctx, agent)
    await settle()
    await settle()
    await settle()

    await vi.waitFor(() => { expect(provider.requests).toHaveLength(1) }, { timeout: 5000 })
    await expect(readFile(join(dir, '.agents', 'skills', 'issue-format', 'SKILL.md'), 'utf8')).rejects.toThrow()
    await rm(dir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })

  it('logs and continues on an invalid structured proposal', async () => {
    const { ctx, dir, provider } = await setup({ action: 'create' }) // missing skill
    await ctx.plugin(distill, { minUserMessages: 1, provider: 'route', model: 'model', targetRoot: 'project' })
    const session = ctx.sessions.create(SessionId('s16'), { meta: { cwd: dir } })
    const agent = stubAgent(session)
    ctx.agents.register(agent)
    userMessage(session, 'hello')
    settleAgent(ctx, agent)
    await settle()
    await settle()
    await settle()

    await vi.waitFor(() => { expect(provider.requests).toHaveLength(1) }, { timeout: 5000 })
    await expect(readFile(join(dir, '.agents', 'skills', 'issue-format', 'SKILL.md'), 'utf8')).rejects.toThrow()
    await rm(dir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })

  it('skips when no route is available', async () => {
    const { ctx, dir, provider } = await setup()
    await ctx.plugin(distill, { minUserMessages: 1, targetRoot: 'project' })
    const session = ctx.sessions.create(SessionId('s17'), { meta: { cwd: dir } })
    const agent = stubAgent(session) // no provider/model in options
    ctx.agents.register(agent)
    userMessage(session, 'hello')
    settleAgent(ctx, agent)
    await settle()

    expect(provider.requests).toHaveLength(0)
    await rm(dir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })

  it('continues from the last checkpoint on a second review', async () => {
    const { ctx, dir, provider } = await setup()
    await ctx.plugin(distill, { minUserMessages: 1, provider: 'route', model: 'model', targetRoot: 'project' })
    const session = ctx.sessions.create(SessionId('s18'), { meta: { cwd: dir } })
    const agent = stubAgent(session)
    ctx.agents.register(agent)
    const first = userMessage(session, 'first message')
    settleAgent(ctx, agent)
    // The first pass must settle before the second message, or the in-flight
    // guard would skip the second dispatch by design.
    await vi.waitFor(() => { expect(provider.requests).toHaveLength(1) }, { timeout: 5000 })
    const second = userMessage(session, 'second message')
    settleAgent(ctx, agent)
    await vi.waitFor(() => { expect(provider.requests).toHaveLength(2) }, { timeout: 5000 })
    const records = await ledgerRecords(dir, 's18')
    expect(records).toHaveLength(2)
    expect(records[0]?.messageSeqs).toEqual([first])
    expect(records[1]?.messageSeqs).toEqual([second])
    await rm(dir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })

  it('supports the DSH_AGENTS_HOME environment root for user targets', async () => {
    const { ctx, dir } = await setup()
    const original = process.env.DSH_AGENTS_HOME
    process.env.DSH_AGENTS_HOME = dir
    try {
      await ctx.plugin(distill, { minUserMessages: 1, provider: 'route', model: 'model', targetRoot: 'user' })
      const session = ctx.sessions.create(SessionId('s19'), { meta: { cwd: dir } })
      const agent = stubAgent(session)
      ctx.agents.register(agent)
      userMessage(session, 'hello')
      settleAgent(ctx, agent)
      await settle()
      await settle()

      await waitForFile(join(dir, '.agents', 'skills', 'issue-format', 'SKILL.md'))
      const content = await readFile(join(dir, '.agents', 'skills', 'issue-format', 'SKILL.md'), 'utf8')
      expect(content).toContain('name: issue-format')
    } finally {
      if (original === undefined) delete process.env.DSH_AGENTS_HOME
      else process.env.DSH_AGENTS_HOME = original
    }
    await rm(dir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })

  it('skips a second review while one is in flight', async () => {
    let resolveResult!: (result: SubagentResult) => void
    const gate = new Promise<SubagentResult>((resolve) => { resolveResult = resolve })
    const { ctx, dir, provider } = await setup(CREATE_JSON, { resultPromise: gate })
    await ctx.plugin(distill, { minUserMessages: 1, provider: 'route', model: 'model', targetRoot: 'project' })
    const session = ctx.sessions.create(SessionId('s20'), { meta: { cwd: dir } })
    const agent = stubAgent(session)
    ctx.agents.register(agent)
    userMessage(session, 'hello')
    settleAgent(ctx, agent)
    await vi.waitFor(() => { expect(provider.requests).toHaveLength(1) }, { timeout: 5000 })
    // A second settle while the first review is still running is skipped.
    settleAgent(ctx, agent)
    await settle()
    await settle()
    expect(provider.requests).toHaveLength(1)
    resolveResult({ output: [], structured: CREATE_JSON, stopReason: 'completed' })
    await vi.waitFor(() => { expect(provider.requests).toHaveLength(1) }, { timeout: 5000 })
    await waitForFile(join(dir, '.agents', 'skills', 'issue-format', 'SKILL.md'))
    await rm(dir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })

  it('restarts the window from the beginning after an empty checkpoint record', async () => {
    const { ctx, dir, provider } = await setup()
    await ctx.plugin(distill, { minUserMessages: 1, provider: 'route', model: 'model', targetRoot: 'project' })
    const session = ctx.sessions.create(SessionId('s21'), { meta: { cwd: dir } })
    await seedLedgerRecord(dir, 's21', {
      messageSeqs: [],
      route: { provider: 'route', model: 'model' },
      prompt: 'stale',
      toolFilter: { allow: ['skill'] },
      maxTokens: 2048,
    })
    const agent = stubAgent(session)
    ctx.agents.register(agent)
    const msg = userMessage(session, 'hello')
    settleAgent(ctx, agent)
    await vi.waitFor(() => { expect(provider.requests).toHaveLength(1) }, { timeout: 5000 })

    const records = await ledgerRecords(dir, 's21')
    expect(records).toHaveLength(2)
    expect(records[1]?.messageSeqs).toEqual([msg])
    await rm(dir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })

  it('finds the git root when the session has no cwd', async () => {
    const { ctx, dir } = await setup()
    await mkdir(join(dir, '.git'), { recursive: true })
    const originalCwd = process.cwd()
    process.chdir(dir)
    try {
      await ctx.plugin(distill, { minUserMessages: 1, provider: 'route', model: 'model', targetRoot: 'project' })
      const session = ctx.sessions.create(SessionId('s22')) // no meta.cwd
      const agent = stubAgent(session)
      ctx.agents.register(agent)
      userMessage(session, 'hello')
      settleAgent(ctx, agent)
      await settle()
      await settle()

      await waitForFile(join(dir, '.agents', 'skills', 'issue-format', 'SKILL.md'))
    } finally {
      process.chdir(originalCwd)
    }
    await rm(dir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })

  it('resolves the user root from the HOME directory when neither config nor DSH_AGENTS_HOME is set', async () => {
    const { ctx, dir } = await setup()
    const originalHome = process.env.HOME
    const originalProfile = process.env.USERPROFILE
    const originalAgentsHome = process.env.DSH_AGENTS_HOME
    // `os.homedir()` reads HOME on POSIX but USERPROFILE on Windows; stub
    // both so the user-root resolution is exercised on every platform.
    process.env.HOME = dir
    process.env.USERPROFILE = dir
    delete process.env.DSH_AGENTS_HOME
    try {
      await ctx.plugin(distill, { minUserMessages: 1, provider: 'route', model: 'model', targetRoot: 'user' })
      const session = ctx.sessions.create(SessionId('s23'), { meta: { cwd: dir } })
      const agent = stubAgent(session)
      ctx.agents.register(agent)
      userMessage(session, 'hello')
      settleAgent(ctx, agent)
      await settle()
      await settle()

      await waitForFile(join(dir, '.agents', 'skills', 'issue-format', 'SKILL.md'))
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      if (originalProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = originalProfile
      if (originalAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
      else process.env.DSH_AGENTS_HOME = originalAgentsHome
    }
    await rm(dir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })
})

describe('parseReflection', () => {
  it('parses a create proposal', () => {
    const result = parseReflection(CREATE_JSON)
    expect(result).toMatchObject({ kind: 'skill', action: 'create' })
    if (result.kind === 'skill') {
      expect(result.skill.name).toBe('issue-format')
      expect(result.skill.whenToUse).toBe('when filing an issue')
    }
  })

  it('parses an update proposal', () => {
    const result = parseReflection(UPDATE_JSON)
    expect(result).toMatchObject({ kind: 'skill', action: 'update', skill: { name: 'issue-format' } })
  })

  it('parses skip as none', () => {
    expect(parseReflection({ action: 'skip' })).toEqual({ kind: 'none' })
  })

  it('rejects an unsupported action', () => {
    expect(() => parseReflection({ action: 'rename' })).toThrow(/unsupported action/)
  })

  it('rejects a non-object result', () => {
    expect(() => parseReflection('{"action":"skip"}')).toThrow(/not an object/)
  })

  it('rejects a missing skill for a writing action', () => {
    expect(() => parseReflection({ action: 'create' })).toThrow(/not an object/)
  })

  it('rejects invalid names', () => {
    expect(() => parseReflection({ action: 'create', skill: { name: 'Bad Name!', description: 'd', content: 'c' } })).toThrow(/name/)
  })

  it('rejects missing content', () => {
    expect(() => parseReflection({ action: 'create', skill: { name: 'ok-name', description: 'd' } })).toThrow(/content/)
  })

  it('rejects a missing description', () => {
    expect(() => parseReflection({ action: 'create', skill: { name: 'ok-name', content: 'c' } })).toThrow(/description/)
  })

  it('rejects a non-object skill proposal', () => {
    expect(() => parseReflection({ action: 'create', skill: 'issue-format' })).toThrow(/not an object/)
  })

  it('omits whenToUse when it is empty', () => {
    const result = parseReflection({ action: 'create', skill: { name: 'ok-name', description: 'd', whenToUse: '  ', content: 'c' } })
    expect(result.kind).toBe('skill')
    if (result.kind === 'skill') {
      expect(result.skill.whenToUse).toBeUndefined()
    }
  })
})

describe('renderSkillFile', () => {
  it('renders frontmatter with the ownership marker and optional whenToUse', () => {
    const rendered = renderSkillFile({
      name: 'foo-bar',
      description: 'Does foo',
      whenToUse: 'when fooing',
      content: 'Step 1.',
    })
    expect(rendered).toBe(`---\nname: foo-bar\ndescription: Does foo\nwhenToUse: when fooing\n${DISTILL_MARKER}\n---\n\nStep 1.\n`)
  })

  it('omits whenToUse when absent', () => {
    const rendered = renderSkillFile({ name: 'foo-bar', description: 'Does foo', content: 'Step 1.' })
    expect(rendered).toBe(`---\nname: foo-bar\ndescription: Does foo\n${DISTILL_MARKER}\n---\n\nStep 1.\n`)
  })

  it('escapes quotes in frontmatter values', () => {
    const rendered = renderSkillFile({ name: 'foo-bar', description: 'say "hi"', content: 'x' })
    expect(rendered).toContain('description: say \\"hi\\"')
  })
})
