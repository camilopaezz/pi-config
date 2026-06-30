/**
 * pi-plan — Plan Mode extension for pi
 *
 * Implements a two-phase workflow:
 *   1. Plan mode  — read-only exploration + plan file authoring
 *   2. Build mode — full tool access for implementation
 *
 * Entry points:
 *   /plan [topic]   — user command to enter plan mode
 *   plan_enter tool  — LLM-initiated entry into plan mode
 *   plan_exit tool   — LLM presents plan, user approves → build mode
 *
 * Architecture follows OpenCode's pattern:
 *   - Mode reminders are injected at transition boundaries (not every turn)
 *   - Tool filtering enforces read-only in plan mode
 *   - State is persisted across restarts via pi.appendEntry
 */

import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { planModeReminder, buildSwitchReminder } from "./prompts";
import {
  createPlanFile,
  createPlanState,
  registerPlanEnterTool,
  registerPlanExitTool,
  PLAN_STATE_ENTRY_TYPE,
  type PersistFn,
  type PlanState,
  type PlanStateSerialized,
} from "./plan-tools";

// ── Persistence ──────────────────────────────────────────────────────────

function persistState(
  pi: ExtensionAPI,
  state: PlanState,
): void {
  const serialized: PlanStateSerialized = {
    mode: state.mode,
    lastAssistantMode: state.lastAssistantMode,
    planFilePath: state.planFilePath,
  };
  pi.appendEntry(PLAN_STATE_ENTRY_TYPE, serialized);
}

function restoreState(
  ctx: ExtensionContext,
  state: PlanState,
): void {
  // Walk entries in order; last pi-plan-state entry wins
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === PLAN_STATE_ENTRY_TYPE) {
      const data = entry.data as PlanStateSerialized | undefined;
      if (data && typeof data.mode === "string") {
        state.mode = data.mode;
        state.lastAssistantMode = data.lastAssistantMode ?? "build";
        state.planFilePath = data.planFilePath ?? null;
      }
    }
  }
}

// ── Tool allow-/block-lists for plan mode ────────────────────────────────

/** Tools always allowed in plan mode (read-only, question, plan exit) */
const PLAN_MODE_ALLOWED_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "web_fetch",
  "ask_user_question",
  "plan_enter",
  "plan_exit",
]);

/** Tools that are path-conditional in plan mode (only allowed on plan files) */
const PLAN_MODE_PATH_TOOLS = new Set(["write", "edit"]);

function isPlanFilePath(cwd: string, filePath: string, planFilePath: string | null): boolean {
  const planDir = resolve(cwd, ".pi", "plans");
  const resolved = filePath.startsWith("/") ? filePath : resolve(cwd, filePath);

  // Allow any file under .pi/plans/
  if (resolved.startsWith(planDir + "/") || resolved === planDir) return true;

  // Also allow the specific plan file (even if somehow outside plan dir)
  if (planFilePath && resolved === resolve(planFilePath)) return true;

  return false;
}

// ── Main extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const state: PlanState = createPlanState();

  // ── Restore persisted state ──────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    restoreState(ctx, state);
  });

  // ── Inject mode reminder on transitions ──────────────────────────────

  pi.on("before_agent_start", async (event, ctx) => {
    // Only inject when the mode has changed since the last assistant message.
    // This mirrors OpenCode's logic: inject PLANNING_MODE only when plan first
    // takes control, and BUILD_SWITCH only when build resumes after plan.
    if (state.mode === state.lastAssistantMode) return;

    state.lastAssistantMode = state.mode;
    persistState(pi, state);

    if (state.mode === "plan") {
      // Ensure we have a plan file. If entering via plan_enter, it's already set.
      // If entering via /plan command with a topic, it's also set.
      // If somehow missing, create one now.
      if (!state.planFilePath) {
        state.planFilePath = createPlanFile(ctx.cwd);
      }
      persistState(pi, state);

      const reminder = planModeReminder(state.planFilePath);

      return {
        // Inject the plan mode reminder as a custom message shown to the LLM.
        // display: true so the user sees the mode transition in chat.
        message: {
          customType: "plan-mode-reminder",
          content: reminder,
          display: true,
        },
      };
    }

    // Transitioning to build mode (from plan)
    const reminder = buildSwitchReminder();

    return {
      message: {
        customType: "build-switch-reminder",
        content: reminder,
        display: true,
      },
    };
  });

  // ── Block disallowed tools in plan mode ───────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (state.mode !== "plan") return;

    // Always allow plan tools and read-only tools
    if (PLAN_MODE_ALLOWED_TOOLS.has(event.toolName)) return;

    // Path-conditional tools (write, edit) — only on plan files
    if (PLAN_MODE_PATH_TOOLS.has(event.toolName)) {
      const filePath =
        (event.input as Record<string, unknown> | undefined)?.path ||
        (event.input as Record<string, unknown> | undefined)?.filePath;

      if (typeof filePath === "string" && isPlanFilePath(ctx.cwd, filePath, state.planFilePath)) {
        return; // Allowed on plan files
      }

      return {
        block: true,
        reason: `In plan mode, ${event.toolName} is only allowed on plan files in .pi/plans/. Current plan file: ${state.planFilePath || "(none)"}`,
      };
    }

    // Everything else (bash, apply_patch, custom tools, etc.) is blocked
    return {
      block: true,
      reason: `"${event.toolName}" is not available in plan mode. Use read-only tools (read, grep, find, ls, web_search, web_fetch) or ask_user_question.`,
    };
  });

  // ── Persist state on shutdown ─────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    persistState(pi, state);
  });

  // ── Register tools ────────────────────────────────────────────────────

  const persist: PersistFn = () => persistState(pi, state);
  registerPlanEnterTool(pi, state, persist);
  registerPlanExitTool(pi, state, persist);

  // ── /plan command ─────────────────────────────────────────────────────

  pi.registerCommand("plan", {
    description: "Enter plan mode (read-only exploration + plan file authoring)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Plan mode is only available in interactive mode.", "error");
        return;
      }

      if (state.mode === "plan") {
        ctx.ui.notify(
          `Already in plan mode. Plan file: ${state.planFilePath ?? "(none)"}`,
          "warning",
        );
        return;
      }

      const topic = args?.trim() || undefined;
      state.planFilePath = createPlanFile(ctx.cwd, topic);
      state.mode = "plan";
      // Keep lastAssistantMode as-is so before_agent_start detects the transition
      persistState(pi, state);

      ctx.ui.notify(
        `Plan mode activated. Plan file: ${state.planFilePath}\nType your planning request — the LLM will explore and design without making changes.`,
        "info",
      );
    },
  });
}
