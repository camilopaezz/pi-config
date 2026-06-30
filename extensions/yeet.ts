/**
 * /yeet — Add, commit, and push changes via an isolated subprocess.
 *
 * Spawns a cheap-model pi subprocess with --no-session so the git conversation
 * never enters the parent session context. The parent sees only a brief result.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ponytail: hardcoded cheap model, switch to bedrock:nova-micro or gpt-4o-mini to avoid thinking overhead
const YEET_MODEL = "deepseek/deepseek-v4-flash";

const YEET_SYSTEM_PROMPT = `You are a git commit-and-push bot. Work autonomously, do not ask questions.

Steps:
1. Run \`git add -A\` to stage all changes.
2. Run \`git diff --cached --stat\` and \`git diff --cached\` to inspect what changed.
3. Write a concise, specific commit message that accurately summarizes the diff.
4. Run \`git commit -m "<message>"\` with that message.
5. Run \`git push\` to push to the current branch's remote.
   - If the branch has no upstream, run \`git push --set-upstream origin <branch>\`.
   - If the repository has no remotes, skip push and say so.
6. Report the result: commit hash, remote URL, and a PR creation URL if not on main.

Convert SSH remote URLs like \`git@github.com:owner/repo.git\` to HTTPS when printing URLs.

If there are no changes to commit, report that and stop — do not make an empty commit.

Keep the commit message under 72 characters for the summary line.`;

// ── pi process discovery (cribbed from subagent example) ────────────────────

function getPiCommand(): { command: string; args: string[] } {
	const script = process.argv[1];
	const execPath = process.execPath;

	if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
		return { command: execPath, args: [script] };
	}

	const execName = path.basename(execPath).toLowerCase();
	if (/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: "pi", args: [] };
	}

	return { command: execPath, args: [] };
}

// ── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerCommand("yeet", {
		description: "Add, commit, and push changes via an isolated cheap-model subprocess",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy — wait for it to finish first.", "warning");
				return;
			}

			// ── prepare temp system prompt ──────────────────────────────────

			const task = args?.trim()
				? `${YEET_SYSTEM_PROMPT}\n\nAdditional user instructions:\n${args.trim()}`
				: YEET_SYSTEM_PROMPT;

			const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-yeet-"));
			const promptFile = path.join(tmpDir, "prompt.md");
			await fs.promises.writeFile(promptFile, task, { encoding: "utf-8", mode: 0o600 });

			ctx.ui.notify("Yeeting with cheap model…", "info");

			try {
				// ── spawn child pi ──────────────────────────────────────────

				const { command, args: baseArgs } = getPiCommand();
				const childArgs = [
					...baseArgs,
					"--mode", "json",
					"-p",
					"--no-session",
					"--model", YEET_MODEL,
					"--thinking", "minimal",
					"--tools", "bash",
					"--append-system-prompt", promptFile,
					"Commit and push all changes.",
				];

				const proc = spawn(command, childArgs, {
					cwd: ctx.cwd,
					stdio: ["ignore", "pipe", "pipe"],
				});

				let buffer = "";
				let finalText = "";
				let stderr = "";

				proc.stdout.on("data", (data: Buffer) => {
					buffer += data.toString();
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) {
						if (!line.trim()) continue;
						try {
							const event = JSON.parse(line);
							if (event.type === "message_end" && event.message?.role === "assistant") {
								for (const part of event.message.content) {
									if (part.type === "text") finalText = part.text;
								}
							}
						} catch {
							/* malformed line, skip */
						}
					}
				});

				proc.stderr.on("data", (data: Buffer) => {
					stderr += data.toString();
				});

				const exitCode = await new Promise<number>((resolve) => {
					proc.on("close", (code) => {
						// flush remaining buffer
						if (buffer.trim()) {
							try {
								const event = JSON.parse(buffer.trim());
								if (event.type === "message_end" && event.message?.role === "assistant") {
									for (const part of event.message.content) {
										if (part.type === "text") finalText = part.text;
									}
								}
							} catch {
								/* skip */
							}
						}
						resolve(code ?? 1);
					});
					proc.on("error", () => resolve(1));
				});

				// ── report result ───────────────────────────────────────────

				if (exitCode !== 0) {
					ctx.ui.notify(`Yeet failed (exit ${exitCode})`, "error");
					pi.sendMessage({
						customType: "yeet",
						content: `**Yeet failed** (exit ${exitCode})\n\n${stderr || "unknown error"}`,
						display: true,
					});
				} else if (stderr && !finalText) {
					ctx.ui.notify("Yeet failed — model error", "error");
					pi.sendMessage({
						customType: "yeet",
						content: `**Yeet failed**\n\n${stderr.trim()}`,
						display: true,
					});
				} else if (!finalText) {
					ctx.ui.notify("Yeet: nothing to commit or model returned empty", "warning");
					pi.sendMessage({
						customType: "yeet",
						content: `**Yeet: nothing to do**\n\ncmd: ${command} ${childArgs.slice(baseArgs.length).join(" ")}\nstderr: ${stderr || "(none)"}`,
						display: true,
					});
				} else {
					ctx.ui.notify("✓ Yeet complete", "info");
					pi.sendMessage({
						customType: "yeet",
						content: finalText,
						display: true,
					});
				}
			} finally {
				try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
				try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
			}
		},
	});
}
