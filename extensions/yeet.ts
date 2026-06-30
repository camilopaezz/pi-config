import type { Model } from "@earendil-works/pi-ai";
import { DynamicBorder, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

const YEET_PROMPT = `Commit and push the current repository changes.

Steps:
1. Add all unstaged changes with \`git add -A\`.
2. Inspect the staged changes and write a concise commit message that accurately summarizes them.
3. Commit the changes with that message.
4. Push the commit to the current branch's remote.
 - If the current branch does not have an upstream remote branch, create one by pushing with upstream tracking.
 - If this repository has no git remotes configured, do not push.
5. After pushing, output the remote URL for what was pushed if the repository has a remote.
 - If the current branch is \`main\`, output the normal remote repository URL.
 - If the current branch is not \`main\`, output a URL to create a pull request from the pushed branch into \`main\`.
 - Convert SSH git remotes like \`git@github.com:owner/repo.git\` to HTTPS URLs when printing.

Keep the commit message concise.`;

export default function (pi: ExtensionAPI) {
	let yeetModel: Model<any> | null = null;

	pi.registerCommand("yeet-model", {
		description: "Set the model used by /yeet",
		handler: async (_args, ctx) => {
			const models = ctx.modelRegistry.getAvailable();
			if (models.length === 0) {
				ctx.ui.notify("No available models found", "error");
				return;
			}

			const items: SelectItem[] = models.map((m) => ({
				value: `${m.provider}/${m.id}`,
				label: `${m.provider}/${m.id}`,
			}));

			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const container = new Container();

				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Select yeet model")), 1, 0));

				const selectList = new SelectList(items, Math.min(items.length, 10), {
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				});
				selectList.onSelect = (item) => done(item.value);
				selectList.onCancel = () => done(null);
				container.addChild(selectList);

				container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				return {
					render: (w) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data) => { selectList.handleInput(data); tui.requestRender(); },
				};
			});

			if (result === null) return;

			const model = models.find((m) => `${m.provider}/${m.id}` === result);
			if (model) {
				yeetModel = model;
				ctx.ui.notify(`Yeet model set to ${result}`, "info");
			}
		},
	});

	pi.registerCommand("yeet", {
		description: "Add, commit, and push the current repo changes (runs in a worker subagent)",
		handler: async (args, ctx) => {
			if (!yeetModel) {
				ctx.ui.notify("No yeet model configured. Run /yeet-model first.", "error");
				return;
			}

			const extra = args?.trim() ? `\n\nAdditional instructions from the user:\n${args.trim()}` : "";

			const prompt = [
				`Delegate the following task to a worker subagent with model \`${yeetModel.provider}/${yeetModel.id}\` in fresh context.`,
				"Pass the task exactly as-is — do not add or modify the instructions.",
				"When the worker finishes, briefly report what happened (commits made, branch pushed, remote URL).",
				"",
				"Task:",
				"---",
				YEET_PROMPT + extra,
				"---",
			].join("\n");

			if (ctx.isIdle()) {
				pi.sendUserMessage(prompt);
			} else {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				ctx.ui.notify("Queued /yeet as a follow-up", "info");
			}
		},
	});
}
