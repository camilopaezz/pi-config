/**
 * Colored Footer Extension
 *
 * Replaces pi's default footer with a colored custom footer that shows
 * the working directory, git branch, current model, thinking level, and token/cost stats.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

function trimHome(cwd: string): string {
	const home = homedir();
	if (cwd === home) return "~";
	if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
	return cwd;
}

/** Map thinking level to the corresponding theme color token. */
function thinkingColor(level: string): string {
	switch (level) {
		case "off": return "thinkingOff";
		case "minimal": return "thinkingMinimal";
		case "low": return "thinkingLow";
		case "medium": return "thinkingMedium";
		case "high": return "thinkingHigh";
		case "xhigh": return "thinkingXhigh";
		default: return "muted";
	}
}

export default function (pi: ExtensionAPI) {
	let enabled = true;

	function setFooter(ctx: ExtensionContext) {
		if (!enabled) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					let input = 0;
					let output = 0;
					let cost = 0;

					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							input += m.usage.input;
							output += m.usage.output;
							cost += m.usage.cost.total;
						}
					}

					const branch = footerData.getGitBranch();
					const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

					const modelId = ctx.model?.id || "no-model";
					const thinking = pi.getThinkingLevel();

					const left = [
						theme.fg("accent", "▌"),
						" ",
						theme.fg("text", trimHome(ctx.cwd)),
						branch ? ` ${theme.fg("warning", `(${branch})`)}` : "",
						"  ",
						theme.fg("muted", modelId),
						"  ",
						theme.fg(thinkingColor(thinking), thinking),
					].join("");

					const tpsStatus = footerData?.getExtensionStatuses?.()?.get("tps");

					const rightParts = [
						`${theme.fg("success", `↑${fmt(input)}`)} ${theme.fg("mdLink", `↓${fmt(output)}`)}`,
					];
					if (tpsStatus) {
						rightParts.push(" ", tpsStatus);
					}
					rightParts.push(` ${theme.fg("error", `$${cost.toFixed(3)}`)}`);
					rightParts.push(`  ${theme.fg("dim", ctx.model?.provider || "")}`);

					const right = rightParts.join("");

					const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
					return [truncateToWidth(left + pad + right, width)];
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		setFooter(ctx);
	});

	pi.registerCommand("colored-footer", {
		description: "Toggle the colored custom footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				setFooter(ctx);
				ctx.ui.notify("Colored footer enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Default footer restored", "info");
			}
		},
	});
}
