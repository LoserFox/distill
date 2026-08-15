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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { Session } from '@deepseek-ai/dsh-session';
export declare const name = "distill";
export declare const inject: string[];
/** Distillation plugin configuration. */
export interface Config {
    /** Master switch; defaults to true. */
    enabled?: boolean;
    /** New human user messages required before one reflection runs; defaults to 3. */
    minUserMessages?: number;
    /** Explicit provider route; must be paired with `model`. Defaults to the agent's own route. */
    provider?: string;
    /** Explicit model id; must be paired with `provider`. Defaults to the agent's own route. */
    model?: string;
    /** Reflection output-token cap; defaults to 2048. */
    maxTokens?: number;
    /** Reflection deadline in milliseconds; defaults to 30000. */
    timeoutMs?: number;
    /** Skill target root; defaults to `project` (`.agents/skills` under the git root). */
    targetRoot?: 'project' | 'user';
    /** User agent root override for the `user` target; defaults to `$DSH_AGENTS_HOME` or the home directory. */
    agentsHome?: string;
    /** Subagent provider registry name used for the review child; defaults to `spawn`. */
    providerName?: string;
    /** Whether the review may update previously distilled skills; defaults to true. */
    allowUpdate?: boolean;
}
/** Validate and detach distillation configuration. */
export declare const Config: z<Config>;
/** Exact model-visible request emitted before one review dispatch. */
export interface DistillReviewRequestEventData {
    /** Exact human `user/message` seqs represented in the review window. */
    readonly messageSeqs: number[];
    /** Exact review subagent route. */
    readonly route: {
        provider: string;
        model: string;
    };
    /** Exact child prompt (curriculum, updatable list, and framed messages). */
    readonly prompt: string;
    /** Exact child tool whitelist. */
    readonly toolFilter: {
        allow: readonly string[];
    };
    /** Exact child output-token cap. */
    readonly maxTokens: number;
}
declare module '@deepseek-ai/cordis' {
    interface Events {
        /** Ephemeral pre-dispatch notification; never written to the session log. */
        'distill/review-request'(session: Session, request: DistillReviewRequestEventData): void;
    }
}
/** One distilled skill proposal extracted from the reflection output. */
export interface DistilledSkill {
    readonly name: string;
    readonly description: string;
    readonly whenToUse?: string;
    readonly content: string;
}
/** Structured review result: a create/update proposal or an explicit skip. */
export type ReflectionResult = {
    kind: 'none';
} | {
    kind: 'skill';
    action: 'create' | 'update';
    skill: DistilledSkill;
};
/** Reflection target resolution for one agent. */
export interface DistillTarget {
    readonly provider: string;
    readonly model: string;
}
/** One committed-token window of human user messages. */
export interface DistillMessageWindow {
    readonly messages: readonly {
        seq: number;
        text: string;
    }[];
    readonly throughSeq: number;
}
/**
 * Register the distillation plugin: review scheduling on `agent/turn-stopping`,
 * background subagent dispatch, and `SKILL.md` materialization into a local
 * skill root.
 * @param ctx - context exposing the subagent and skill services.
 * @param config - validated plugin configuration.
 */
export declare function apply(ctx: Context, config?: Config): void;
/** Parse the captured structured review result into a validated proposal. */
export declare function parseReflection(value: unknown): ReflectionResult;
/** Render one distilled skill as a frontmatter Markdown bundle carrying the ownership marker. */
export declare function renderSkillFile(skill: DistilledSkill): string;
