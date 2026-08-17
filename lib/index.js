/**
 * Automatic conversation reflection and skill distillation.
 *
 * Listens for `agent/turn-stopping` and, after enough new user messages accumulate,
 * spawns a background review subagent over the recent conversation (Hermes
 * Agent's background-review shape: a forked agent with a restricted toolset,
 * running after the turn, never competing with the user's task). When the
 * review proposes a reusable workflow, the plugin writes it as a local
 * `SKILL.md` bundle — or rewrites one it previously distilled — that
 * `dsh-skill-filesystem` discovers like any hand-authored skill, closing the
 * learning loop without model-facing tools in the main session.
 *
 * The review prompt is adapted from Nous Research's `hermes-agent`
 * `_SKILL_REVIEW_PROMPT` (MIT License, Copyright (c) 2025 Nous Research;
 * https://github.com/NousResearch/hermes-agent), which owns the curation
 * philosophy, signals, and anti-patterns below; only the tool references and
 * output contract were reworked for this surface: the review child may only
 * view skills (the `skill` tool) and must report its proposal through the
 * structured-output contract.
 *
 * @module distill
 */
var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import { accessSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { access } from 'node:fs/promises';
import z from '@deepseek-ai/schemastery';
import { isSkillName } from '@deepseek-ai/dsh-skill';
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools';
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout';
export const name = 'distill';
export const inject = ['subagents'];
const DEFAULT_MIN_USER_MESSAGES = 3;
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 30_000;
/** The model-facing skill viewer the review child may use (`dsh-tool-skill`). */
const SKILL_TOOL = 'skill';
/**
 * Whether the running harness recognizes the `session/distill-review-request`
 * event type (checked once per process, then cached).
 *
 * The harness's session-persistence read path refuses any log containing an
 * event type outside its hard-coded `KNOWN_SESSION_EVENT_TYPES` unless the
 * event carries `ignorable: true`, and `session.append` cannot write that
 * marker — so a plugin-only event type this build does not know produces a
 * session log that the same harness can no longer load. Detect support
 * before appending; when unknown, skip the review rather than corrupt the
 * session history. `undefined` means "not yet probed".
 */
let distillEventSupported = undefined;
async function detectDistillEventSupport() {
    if (distillEventSupported !== undefined)
        return distillEventSupported;
    try {
        const { KNOWN_SESSION_EVENT_TYPES } = await import('@deepseek-ai/dsh-session');
        distillEventSupported = KNOWN_SESSION_EVENT_TYPES?.has?.('session/distill-review-request') === true;
    }
    catch {
        // The module cannot be resolved/linked in this runtime: assume the
        // harness does not know the type and stay conservative (no bad logs).
        distillEventSupported = false;
    }
    return distillEventSupported;
}
/** Frontmatter marker proving one `SKILL.md` was created by this plugin. */
const DISTILL_MARKER = 'distilled-by: dsh-distill';
/** Validate and detach distillation configuration. */
export const Config = z.object({
    enabled: z.boolean().default(true),
    minUserMessages: z.number().step(1).min(1).default(DEFAULT_MIN_USER_MESSAGES),
    provider: z.string(),
    model: z.string(),
    maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
    timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_TIMEOUT_MS),
    targetRoot: z.union([z.const('project'), z.const('user')]).default('project'),
    agentsHome: z.string(),
    providerName: z.string().default('spawn'),
    allowUpdate: z.boolean().default(true),
});
/**
 * The structured-output contract the review child must satisfy: one object
 * with an `action` (`create` / `update` / `skip`) and, for the two writing
 * actions, a complete skill proposal. The `skill` object is deliberately not
 * required at schema level so `skip` needs no dummy payload; the plugin
 * enforces presence for writing actions in {@link parseReflection}.
 */
const REVIEW_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        action: { type: 'string', enum: ['create', 'update', 'skip'] },
        skill: {
            type: 'object',
            additionalProperties: false,
            properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                whenToUse: { type: 'string' },
                content: { type: 'string' },
            },
            required: ['name', 'description', 'content'],
        },
    },
    required: ['action'],
};
/**
 * Register the distillation plugin: review scheduling on `agent/turn-stopping`,
 * background subagent dispatch, and `SKILL.md` materialization into a local
 * skill root.
 * @param ctx - context exposing the subagent and skill services.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config = {}) {
    const resolved = validateConfig(config);
    if (!resolved.enabled)
        return;
    assertObjectJsonSchema(REVIEW_SCHEMA);
    const pending = new Map();
    ctx.on('agent/turn-stopping', ({ agent }) => {
        const session = agent.session;
        if (pending.has(session.id))
            return;
        const job = (async () => {
            try {
                await reviewOnce(ctx, resolved, agent, session);
            }
            catch (error) {
                ctx.logger.warn(`distill: review failed: ${errorMessage(error)}`);
            }
            finally {
                pending.delete(session.id);
            }
        })();
        pending.set(session.id, job);
    });
    ctx.on('session/disposed', (session) => {
        pending.delete(session.id);
    });
}
/** Validate and normalize the plugin configuration. */
function validateConfig(config) {
    const hasProvider = config.provider !== undefined;
    const hasModel = config.model !== undefined;
    if (hasProvider !== hasModel) {
        throw new Error('distill: provider and model must be supplied together');
    }
    return {
        enabled: config.enabled ?? true,
        minUserMessages: config.minUserMessages ?? DEFAULT_MIN_USER_MESSAGES,
        provider: config.provider,
        model: config.model,
        maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
        timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        targetRoot: config.targetRoot ?? 'project',
        agentsHome: config.agentsHome,
        providerName: config.providerName ?? 'spawn',
        allowUpdate: config.allowUpdate ?? true,
    };
}
/**
 * Run one review pass over the messages accumulated since the last recorded
 * distillation checkpoint, then materialize the proposed skill change.
 * @param ctx - context exposing the subagent and skill services.
 * @param config - validated plugin configuration.
 * @param agent - the settled agent whose session is the distillation source.
 * @param session - the agent's live session.
 */
async function reviewOnce(ctx, config, agent, session) {
    if (!await detectDistillEventSupport()) {
        ctx.logger.warn('distill: this harness does not recognize session/distill-review-request; skipping review so session logs stay loadable');
        return;
    }
    const window = collectWindow(session.events, checkpointSeq(session.events));
    if (window.messages.length < config.minUserMessages)
        return;
    const target = resolveTarget(config, agent);
    if (target === undefined) {
        ctx.logger.warn('distill: no provider/model available; set both distill config fields or agent options');
        return;
    }
    const updatable = config.allowUpdate
        ? await listOwnedSkillNames(config, session.header.cwd)
        : [];
    const prompt = buildReviewPrompt(window.messages, updatable);
    session.append('session/distill-review-request', {
        messageSeqs: window.messages.map(message => message.seq),
        route: target,
        prompt,
        toolFilter: { allow: [SKILL_TOOL] },
        maxTokens: config.maxTokens,
    });
    const structured = await runReview(ctx, config, agent, prompt, target);
    await applyProposal(ctx, config, session, structured);
}
/** Extract human user-message text after the last distillation checkpoint. */
function collectWindow(events, sinceSeq) {
    const messages = [];
    let throughSeq = sinceSeq;
    for (const event of events) {
        if (event.type !== 'user/message' || event.data.source.kind !== 'user')
            continue;
        if (event.seq <= sinceSeq)
            continue;
        const text = event.data.content
            .filter((block) => block.type === 'text')
            .map(block => block.text)
            .join('\n');
        if (text.trim().length === 0)
            continue;
        messages.push({ seq: event.seq, text });
        throughSeq = event.seq;
    }
    return { messages, throughSeq };
}
/** Derive the reflection checkpoint from the last logged distillation request. */
function checkpointSeq(events) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        // The loop bounds prove the read-only event view contains this index.
        // oxlint-disable-next-line typescript/no-non-null-assertion
        const event = events[index];
        if (event.type !== 'session/distill-review-request')
            continue;
        const seqs = event.data.messageSeqs;
        if (seqs.length === 0)
            return -1;
        let last = -1;
        for (const seq of seqs)
            last = seq;
        return last;
    }
    return -1;
}
/** Resolve the explicit route pair or the agent's own route. */
function resolveTarget(config, agent) {
    if (config.provider !== undefined && config.model !== undefined) {
        return { provider: config.provider, model: config.model };
    }
    if (agent.options.provider !== undefined
        && agent.options.provider.length > 0
        && agent.options.model !== undefined
        && agent.options.model.length > 0) {
        return { provider: agent.options.provider, model: agent.options.model };
    }
    return undefined;
}
/**
 * Spawn the background review subagent and return its structured proposal.
 *
 * The child runs as a fresh agent on the configured provider with a tool
 * whitelist limited to the model-facing `skill` viewer (Hermes' skill_view
 * analog), the resolved auxiliary route, and the structured-output contract.
 * The run is detached from the settled turn: the caller owns the result
 * promise and disposes the run after settlement, so the review never blocks
 * the loop, and the shared deadline cancels the child on timeout.
 * @param ctx - context exposing the subagent service.
 * @param config - validated plugin configuration.
 * @param agent - the settled parent agent authorizing the delegation.
 * @param prompt - the exact review prompt delivered as the child's user message.
 * @param target - the resolved auxiliary route.
 * @returns the captured structured proposal, or `undefined` when the child
 *   failed, was cancelled, or finished without a valid capture.
 */
async function runReview(ctx, config, agent, prompt, target) {
    const env_1 = { stack: [], error: void 0, hasError: false };
    try {
        const callDeadline = __addDisposableResource(env_1, deadline(undefined, config.timeoutMs, 'DISTILL_TIMEOUT'), false);
        const content = [{ type: 'text', text: prompt }];
        const run = await ctx.subagents.start(config.providerName, {
            label: 'distill-review',
            prompt: content,
            parent: agent,
            signal: callDeadline.signal,
            agentOptions: { provider: target.provider, model: target.model, maxTokens: config.maxTokens },
            toolFilter: { allow: [SKILL_TOOL] },
            outputSchema: REVIEW_SCHEMA,
        });
        const result = await run.result;
        await run.dispose();
        if (result.stopReason !== 'completed') {
            ctx.logger.warn(`distill: review subagent ended with ${result.stopReason}`);
            return undefined;
        }
        if (result.structured === undefined) {
            ctx.logger.warn('distill: review subagent finished without a structured proposal');
            return undefined;
        }
        return result.structured;
    }
    catch (e_1) {
        env_1.error = e_1;
        env_1.hasError = true;
    }
    finally {
        __disposeResources(env_1);
    }
}
/**
 * Apply one validated proposal: create writes a new bundle, update rewrites an
 * existing distill-owned bundle; every other combination is skipped.
 * @param ctx - context exposing the skill service.
 * @param config - validated plugin configuration.
 * @param session - the source session (carries the workspace cwd).
 * @param structured - the raw structured review result.
 */
async function applyProposal(ctx, config, session, structured) {
    if (structured === undefined)
        return;
    let result;
    try {
        result = parseReflection(structured);
    }
    catch (error) {
        ctx.logger.warn(`distill: invalid review proposal: ${errorMessage(error)}`);
        return;
    }
    if (result.kind === 'none')
        return;
    const filePath = resolveSkillPath(config, session.header.cwd, result.skill.name);
    const exists = await pathExists(filePath);
    if (result.action === 'create') {
        if (exists) {
            ctx.logger.info(`distill: skill "${result.skill.name}" already exists; skipping`);
            return;
        }
    }
    else if (!exists) {
        ctx.logger.warn(`distill: proposed update for missing skill "${result.skill.name}"; skipping`);
        return;
    }
    else if (!(await isOwnedSkill(filePath))) {
        ctx.logger.warn(`distill: proposed update for non-distill-owned skill "${result.skill.name}"; skipping`);
        return;
    }
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, renderSkillFile(result.skill), { encoding: 'utf8' });
    ctx.logger.info(`distill: ${result.action === 'create' ? 'created' : 'updated'} skill "${result.skill.name}" at ${filePath}`);
}
/** List names of distill-owned skills (files carrying the ownership marker) under the target root. */
async function listOwnedSkillNames(config, cwd) {
    const root = skillRoot(config, cwd);
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    }
    catch {
        // A missing root simply means nothing was distilled yet.
        return [];
    }
    const names = [];
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const filePath = join(root, entry.name, 'SKILL.md');
        if (!(await pathExists(filePath)))
            continue;
        if (await isOwnedSkill(filePath))
            names.push(entry.name);
    }
    return names;
}
/** Whether one existing `SKILL.md` carries this plugin's ownership marker. */
async function isOwnedSkill(filePath) {
    let raw;
    try {
        raw = await readFile(filePath, 'utf8');
    }
    catch {
        return false;
    }
    return raw.includes(`\n${DISTILL_MARKER}\n`);
}
/**
 * Build the review prompt: the Hermes curation curriculum plus this surface's
 * contract, followed by the framed message window.
 *
 * The curation text is adapted from Nous Research's hermes-agent
 * `_SKILL_REVIEW_PROMPT` (MIT License, Copyright (c) 2025 Nous Research).
 * Hermes tool references (skill_view, skills_list, skill_manage, curator,
 * hub installs, /skill-name) map onto this surface as follows: the skill
 * catalog is injected automatically and the child may view any skill with the
 * `skill` tool; the only writable targets are new skills and the distill-owned
 * skills named in the updatable list; support files and unlisted skills are
 * off-limits and map to a skip.
 * @param messages - the framed review window.
 * @param updatable - names of distill-owned skills the review may rewrite.
 * @returns the complete review prompt.
 */
function buildReviewPrompt(messages, updatable) {
    return [
        'You are the background skill reviewer. Review the conversation window below and propose a skill-library update. Be ACTIVE — most sessions produce at least one skill update, even if small. A pass that does nothing is a missed learning opportunity, not a neutral outcome.',
        '',
        'Target shape of the library: CLASS-LEVEL skills, each with a rich SKILL.md. Not a long flat list of narrow one-session-one-skill entries. This shapes WHAT you propose, not WHETHER you propose.',
        '',
        'Signals to look for (any one of these warrants action):',
        '  • User corrected your style, tone, format, legibility, or verbosity. Frustration signals like \'stop doing X\', \'this is too verbose\', \'don\'t format like this\', \'why are you explaining\', \'just give me the answer\', \'you always do Y and I hate it\', or an explicit \'remember this\' are FIRST-CLASS skill signals, not just memory signals. Propose updating the relevant skill so the next session starts already knowing.',
        '  • User corrected your workflow, approach, or sequence of steps. Encode the correction as a pitfall or explicit step in the skill that governs that class of task.',
        '  • Non-trivial technique, fix, workaround, debugging path, or tool-usage pattern emerged that a future session would benefit from. Capture it.',
        '  • A skill that got loaded or consulted this session turned out to be wrong, missing a step, or outdated. Patch it NOW.',
        '',
        'Preference order — prefer the earliest action that fits, but do pick one when a signal above fired:',
        '  1. UPDATE A DISTILL-OWNED SKILL. The updatable list below names the only skills you may rewrite (this plugin\'s own previous distillations). Use the `skill` tool to view one\'s current content first; then propose the COMPLETE replacement SKILL.md body in `content` — the whole skill is rewritten, so carry over everything worth keeping.',
        '  2. CREATE A NEW CLASS-LEVEL UMBRELLA SKILL when no updatable skill covers the class. The name MUST be at the class level. The name MUST NOT be a specific PR number, error string, feature codename, library-alone name, or \'fix-X / debug-Y / audit-Z-today\' session artifact. If the proposed name only makes sense for today\'s task, it\'s wrong. If the name already appears in the available-skills catalog, prefer option 1 when the skill is updatable; otherwise skip.',
        '',
        'User-preference embedding (important): when the user expressed a style/format/workflow preference, the update belongs in the SKILL.md body, not just in memory. Memory captures \'who the user is and what the current situation and state of your operations are\'; skills capture \'how to do this class of task for this user\'. When they complain about how you handled a task, the skill that governs that task needs to carry the lesson.',
        '',
        'Protected skills (DO NOT propose updates for these):',
        '  • Bundled skills (shipped with the harness).',
        '  • Runtime-registered skills.',
        '  • USER-OWNED skills — anything not distilled by this plugin, including skills the user hand-wrote, installed by URL, or asked a foreground agent to create. Being loaded or consulted this session does not make one writable.',
        '  • Any skill not in the updatable list — the write would be refused.',
        'Support files (`references/`, `templates/`, `scripts/`) cannot be written through this surface; fold their essential content into the updated SKILL.md body or skip.',
        'If the only skills that need updating are protected, return {"action": "skip"}.',
        '',
        'Do NOT capture (these become persistent self-imposed constraints that bite you later when the environment changes):',
        '  • Environment-dependent failures: missing binaries, fresh-install errors, post-migration path mismatches, \'command not found\', unconfigured credentials, uninstalled packages. The user can fix these — they are not durable rules.',
        '  • Negative claims about tools or features (\'browser tools do not work\', \'X tool is broken\', \'cannot use Y from execute_code\'). These harden into refusals the agent cites against itself for months after the actual problem was fixed.',
        '  • Session-specific transient errors that resolved before the conversation ended. If retrying worked, the lesson is the retry pattern, not the original failure.',
        '  • One-off task narratives. A user asking \'summarize today\'s market\' or \'analyze this PR\' is not a class of work that warrants a skill.',
        '',
        '  • Unresolved failures: if the session ended WITHOUT actually finding a working method — you tried several things, none worked, and told the user to check manually — do NOT write those attempts up as a \'reliable workflow\' or \'recommended approach\'. That presents an untested sequence of failures as validated guidance a future session will trust and repeat. Either return {"action": "skip"}, or, only if you are independently confident of a real working alternative (not something you are merely guessing might work), capture ONLY that alternative — never the dead ends, and never dressed up as best practice.',
        '',
        'If a tool failed because of setup state, capture the FIX (install command, config step, env var to set) under an existing setup or troubleshooting skill — never \'this tool does not work\' as a standalone constraint.',
        '',
        '"skip" is a real option but should NOT be the default. If the session ran smoothly with no corrections and produced no new technique, just return {"action": "skip"}. Otherwise, act.',
        '',
        'Output contract — report your proposal by calling the `structured_output` tool exactly once, with one JSON object matching its parameter schema:',
        '  • {"action": "skip"} — nothing worth saving.',
        '  • {"action": "create", "skill": {"name": "...", "description": "...", "whenToUse": "...", "content": "..."}} — one new skill.',
        '  • {"action": "update", "skill": {"name": "...", "description": "...", "whenToUse": "...", "content": "..."}} — one complete replacement of a skill from the updatable list; `content` MUST be the full new Markdown body, not a diff.',
        '  • name must be kebab-case ASCII. description must be one concise sentence. content must be complete Markdown instructions a future agent can follow without seeing this conversation. whenToUse is optional; omit it when the trigger is obvious.',
        '',
        ...updatable.length === 0
            ? ['Updatable skills (distill-owned): none — only create is available this pass.']
            : [`Updatable skills (distill-owned): ${updatable.join(', ')}`],
        '',
        'Reflect on this JSON array of human messages:',
        JSON.stringify(messages.map(message => message.text)),
    ].join('\n');
}
/** Parse the captured structured review result into a validated proposal. */
export function parseReflection(value) {
    if (typeof value !== 'object' || value === null) {
        throw new Error('distill: review result is not an object');
    }
    const candidate = value;
    const action = candidate.action;
    if (action === 'skip')
        return { kind: 'none' };
    if (action !== 'create' && action !== 'update') {
        throw new Error(`distill: unsupported action "${String(action)}"`);
    }
    return { kind: 'skill', action, skill: parseSkill(candidate.skill) };
}
/** Validate one proposed skill shape. */
function parseSkill(value) {
    if (typeof value !== 'object' || value === null) {
        throw new Error('distill: proposed skill is not an object');
    }
    const candidate = value;
    if (typeof candidate.name !== 'string' || !isSkillName(candidate.name)) {
        throw new Error('distill: proposed skill name is missing or invalid');
    }
    if (typeof candidate.description !== 'string' || candidate.description.trim().length === 0) {
        throw new Error('distill: proposed skill description is missing');
    }
    if (typeof candidate.content !== 'string' || candidate.content.trim().length === 0) {
        throw new Error('distill: proposed skill content is missing');
    }
    const skill = {
        name: candidate.name,
        description: candidate.description,
        content: candidate.content,
        ...typeof candidate.whenToUse === 'string' && candidate.whenToUse.trim().length > 0
            ? { whenToUse: candidate.whenToUse }
            : {},
    };
    return skill;
}
/** Render one distilled skill as a frontmatter Markdown bundle carrying the ownership marker. */
export function renderSkillFile(skill) {
    return [
        '---',
        `name: ${skill.name}`,
        `description: ${escapeText(skill.description)}`,
        ...skill.whenToUse === undefined ? [] : [`whenToUse: ${escapeText(skill.whenToUse)}`],
        DISTILL_MARKER,
        '---',
        '',
        skill.content,
    ].join('\n') + '\n';
}
/** Resolve the absolute `SKILL.md` path for the configured target root. */
function resolveSkillPath(config, cwd, name) {
    return join(skillRoot(config, cwd), name, 'SKILL.md');
}
/** Resolve the absolute skill root for the configured target. */
function skillRoot(config, cwd) {
    return config.targetRoot === 'user'
        ? join(resolveUserAgentsHome(config.agentsHome), '.agents', 'skills')
        : join(findProjectRootSync(cwd ?? process.cwd()), '.agents', 'skills');
}
/** Resolve the shared user agent root, honoring the config override, `DSH_AGENTS_HOME`, then the home directory. */
function resolveUserAgentsHome(configured) {
    if (configured !== undefined && configured.length > 0)
        return resolve(configured);
    const envConfigured = process.env.DSH_AGENTS_HOME;
    return envConfigured !== undefined && envConfigured.length > 0 ? resolve(envConfigured) : homedir();
}
/** Walk upward from a directory to the git root, falling back to the start path. */
function findProjectRootSync(start) {
    let current = resolve(start);
    while (true) {
        if (pathExistsSync(join(current, '.git')))
            return current;
        const parent = dirname(current);
        if (parent === current)
            return resolve(start);
        current = parent;
    }
}
/** Return whether a path exists on the host. */
async function pathExists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        // Missing host paths are expected while walking toward the filesystem root.
        return false;
    }
}
/** Return whether a path exists on the host. */
function pathExistsSync(path) {
    try {
        accessSync(path);
        return true;
    }
    catch {
        // Missing host paths are expected while walking toward the filesystem root.
        return false;
    }
}
/** Escape text for one-line YAML frontmatter values. */
function escapeText(value) {
    return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
/** Stringify an unknown error for log lines. */
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
