/**
 * System reminder prompts for plan/build mode transitions.
 *
 * Injected via before_agent_start when the mode changes. The approach follows
 * OpenCode's pattern: instead of asking the LLM to "behave differently", we
 * provide a different context from the start — the system prompt, available
 * tools, and mode reminder together form a complete environment.
 */

export function planModeReminder(planFilePath: string): string {
  return `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet
— you MUST NOT make any edits (except to the plan file listed below), run any
non-readonly tools (including changing configs or making commits), or otherwise
make any changes to the system. This supersedes any other instructions you have
received.

The only exception is the plan file. You MAY write and edit ONLY this file:
${planFilePath}

Any attempt to write or edit other files will be blocked. Bash commands are also
blocked in plan mode — use only read-only tools: read, grep, find, ls, web_search,
web_fetch, and ask_user_question.

## Plan Workflow

### Phase 1: Initial Understanding
Explore the codebase to understand the current state. Use read, grep, find,
and ls to survey the relevant code. Use web_search and web_fetch to research
if needed. Ask the user clarifying questions when requirements are ambiguous.

### Phase 2: Design
Think through the architecture, data flow, and edge cases. Consider alternatives
and trade-offs. Document your reasoning in the plan file.

### Phase 3: Review
Present your plan to the user. Get feedback and iterate. The user may ask for
changes or clarifications.

### Phase 4: Final Plan
Write the complete, final plan to the plan file. The plan should be detailed
enough that another developer could implement it. Include:
- Summary of the problem
- Proposed architecture / approach
- Step-by-step implementation plan
- Key files that need changes
- Edge cases and risks
- Testing strategy

### Phase 5: Exit Plan Mode
When the plan is complete and the user is satisfied, call the plan_exit tool.
The user will review your plan one final time and decide whether to proceed
with implementation. Always end with plan_exit — do not ask the user to type
a command to exit plan mode.
</system-reminder>`;
}

export function buildSwitchReminder(): string {
  return `<system-reminder>
Your operational mode has changed from plan to build.
You are no longer in read-only mode.
You are permitted to make file changes, run shell commands, and utilize
your full set of tools as needed.

Implement the plan step by step. Reference the plan file if needed, but focus
on making the actual changes now.
</system-reminder>`;
}
