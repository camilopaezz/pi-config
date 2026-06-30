/**
 * plan_enter and plan_exit tool definitions for pi-plan.
 *
 * plan_enter: called by the LLM to enter plan mode voluntarily
 * plan_exit:  called by the LLM when the plan is complete
 */

import { Type } from "typebox";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Shared state (mutated by both tools and event handlers) ──────────────

export type PlanMode = "plan" | "build";

export interface PlanState {
  mode: PlanMode;
  /** The mode active during the last assistant message — used to detect transitions */
  lastAssistantMode: PlanMode;
  planFilePath: string | null;
}

export function createPlanState(): PlanState {
  return { mode: "build", lastAssistantMode: "build", planFilePath: null };
}

/** Serialized form persisted via pi.appendEntry */
export interface PlanStateSerialized {
  mode: PlanMode;
  lastAssistantMode: PlanMode;
  planFilePath: string | null;
}

export const PLAN_STATE_ENTRY_TYPE = "pi-plan-state";

/** Callback to persist current state — provided by index.ts */
export type PersistFn = () => void;

// ── Plan file helpers ────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "plan";
}

function generatePlanPath(cwd: string, topic?: string): string {
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");

  const slug = topic ? slugify(topic) : "plan";
  return join(cwd, ".pi", "plans", `plan-${timestamp}-${slug}.md`);
}

function ensurePlanDir(cwd: string): void {
  const dir = join(cwd, ".pi", "plans");
  mkdirSync(dir, { recursive: true });
}

export function createPlanFile(cwd: string, topic?: string): string {
  ensurePlanDir(cwd);
  const path = generatePlanPath(cwd, topic);

  const heading = topic
    ? `# Plan: ${topic}\n\n_Generated ${new Date().toISOString()}_\n\n`
    : `# Plan\n\n_Generated ${new Date().toISOString()}_\n\n`;

  writeFileSync(path, heading, "utf-8");
  return path;
}

export function readPlanFile(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

// ── Tool registration ────────────────────────────────────────────────────

export interface PlanEnterInput {
  topic?: string;
}

export interface PlanExitInput {
  /** Optional summary of the plan for the user */
  summary?: string;
}

/**
 * Register the plan_enter tool. The LLM can call this to enter plan mode on its
 * own initiative (e.g., when the user asks to "plan" something without using
 * the /plan command).
 */
export function registerPlanEnterTool(
  pi: ExtensionAPI,
  state: PlanState,
  persist: PersistFn,
): void {
  pi.registerTool({
    name: "plan_enter",
    label: "Enter Plan Mode",
    description:
      "Enter plan mode to design a solution before implementing. " +
      "In plan mode, you can only use read-only tools plus write/edit on the plan file. " +
      "Call this when the user asks you to plan something.",
    promptSnippet: "Enter read-only plan mode to design a solution",
    promptGuidelines: [
      "Use plan_enter when the user asks you to plan, design, or architect " +
        "before implementing. In plan mode you explore and design without making changes.",
    ],
    parameters: Type.Object({
      topic: Type.Optional(
        Type.String({
          description:
            "Optional topic or title for the plan. Used to name the plan file.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Plan mode is only available in interactive mode." }],
          details: {},
        };
      }

      if (state.mode === "plan") {
        return {
          content: [
            {
              type: "text",
              text: `Already in plan mode. Current plan file: ${state.planFilePath ?? "(none)"}`,
            },
          ],
          details: {},
        };
      }

      const path = createPlanFile(ctx.cwd, params.topic);
      state.mode = "plan";
      state.planFilePath = path;
      // Keep lastAssistantMode as-is so before_agent_start detects the transition
      persist();

      return {
        content: [
          {
            type: "text",
            text: [
              `Plan mode activated. Plan file: ${path}`,
              "",
              "You are now in plan mode. You may only:",
              "- Use read-only tools: read, grep, find, ls, web_search, web_fetch, ask_user_question",
              "- Write and edit ONLY the plan file",
              "- Call plan_exit when the plan is complete",
              "",
              "Bash commands, file writes, and edits outside the plan file are blocked.",
              "Follow the plan workflow: explore → design → review → final plan → plan_exit.",
            ].join("\n"),
          },
        ],
        details: { planFile: path, mode: "plan" },
      };
    },
  });
}

/**
 * Register the plan_exit tool. The LLM calls this when it has finished
 * planning and wants to present the plan to the user for approval.
 */
export function registerPlanExitTool(
  pi: ExtensionAPI,
  state: PlanState,
  persist: PersistFn,
): void {
  pi.registerTool({
    name: "plan_exit",
    label: "Exit Plan Mode",
    description:
      "Exit plan mode and present the completed plan to the user. " +
      "The user will review the plan and decide whether to proceed with implementation. " +
      "Call this when the plan is complete and ready for user review.",
    promptSnippet: "Exit plan mode and present the plan for user approval",
    promptGuidelines: [
      "Always call plan_exit when you have finished planning. Do not ask the user " +
        "to type a command — use this tool instead.",
    ],
    parameters: Type.Object({
      summary: Type.Optional(
        Type.String({
          description:
            "A brief summary of the plan for the user to review before deciding.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        state.mode = "build";
        state.lastAssistantMode = "plan";
        persist();
        return {
          content: [{ type: "text", text: "Exited plan mode (non-interactive)." }],
          details: { mode: "build" },
        };
      }

      if (state.mode !== "plan") {
        return {
          content: [{ type: "text", text: "Not currently in plan mode." }],
          details: {},
        };
      }

      // Read the plan file to present to the user
      const planContent = state.planFilePath
        ? readPlanFile(state.planFilePath)
        : "";
      const summary = params.summary || "Plan is ready for review.";

      const preview = planContent
        ? planContent.slice(0, 600) + (planContent.length > 600 ? "\n\n... _(truncated)_" : "")
        : "(no plan file content)";

      const approved = await ctx.ui.confirm(
        "Plan Complete",
        [
          `${summary}`,
          "",
          `Plan file: ${state.planFilePath || "(none)"}`,
          "",
          "── Preview ──",
          preview,
          "",
          "Approve this plan and switch to build mode?",
        ].join("\n"),
      );

      if (approved) {
        state.mode = "build";
        state.lastAssistantMode = "plan";
        persist();
        // Send a follow-up message so the LLM picks up in build mode immediately
        pi.sendUserMessage(
          "The plan has been approved. Proceed with implementation.",
          { deliverAs: "followUp" },
        );
        return {
          content: [
            {
              type: "text",
              text: "Plan approved! Switching to build mode. Starting implementation...",
            },
          ],
          details: { mode: "build", planFile: state.planFilePath },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: "Plan not approved. Staying in plan mode. What would you like to change?",
          },
        ],
        details: { mode: "plan" },
      };
    },
  });
}
