import { beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

describe("ExtensionContext.getUIPrompt", () => {
	let runner: ExtensionRunner;
	beforeEach(async () => {
		runner = new ExtensionRunner(
			[],
			createExtensionRuntime(),
			process.cwd(),
			SessionManager.inMemory(),
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
		);
	});

	it("returns no prompt without dialog-capable UI", async () => {
		const ctx = runner.createContext();
		expect(ctx.getUIPrompt()).toBeUndefined();
		await ctx.ui.confirm("Ignored", "No UI");
		expect(ctx.getUIPrompt()).toBeUndefined();
	});

	it.each(["select", "confirm", "input", "editor", "custom"] as const)(
		"reads %s prompts from Pi without recording events",
		async (kind) => {
			const { promise, resolve } = Promise.withResolvers<never>();
			runner.setUIContext({ ...runner.getUIContext(), [kind]: () => promise }, "tui");
			const ctx = runner.createContext();
			const pending =
				kind === "select"
					? ctx.ui.select("Question", ["Yes"])
					: kind === "confirm"
						? ctx.ui.confirm("Question", "Continue?")
						: kind === "input"
							? ctx.ui.input("Question")
							: kind === "editor"
								? ctx.ui.editor("Question")
								: ctx.ui.custom(() => ({ render: () => [], invalidate: () => {} }));
			expect(ctx.getUIPrompt()).toEqual({ kind, title: kind === "custom" ? undefined : "Question" });
			// Another context, e.g. a reconnect handler, sees the same current state.
			expect(runner.createCommandContext().getUIPrompt()).toEqual(ctx.getUIPrompt());
			const snapshot = ctx.getUIPrompt()!;
			Object.assign(snapshot, { title: "Changed by consumer" });
			expect(ctx.getUIPrompt()?.title).not.toBe("Changed by consumer");
			resolve(undefined as never);
			await pending;
			expect(ctx.getUIPrompt()).toBeUndefined();
		},
	);

	it("keeps the outer waiting span until every overlapping prompt finishes", async () => {
		const first = Promise.withResolvers<boolean>();
		const second = Promise.withResolvers<string | undefined>();
		runner.setUIContext(
			{ ...runner.getUIContext(), confirm: () => first.promise, input: () => second.promise },
			"tui",
		);
		const ctx = runner.createContext();
		const a = ctx.ui.confirm("Approval", "Continue?");
		const b = ctx.ui.input("Name");
		first.resolve(false);
		await a;
		expect(ctx.getUIPrompt()?.kind).toBe("confirm");
		second.resolve(undefined);
		await b;
		expect(ctx.getUIPrompt()).toBeUndefined();
	});

	it.each([false, true])("clears a rejected prompt (synchronous=%s)", async (sync) => {
		runner.setUIContext(
			{
				...runner.getUIContext(),
				confirm: () => {
					if (sync) throw new Error("failed");
					return Promise.reject(new Error("failed"));
				},
			},
			"tui",
		);
		const ctx = runner.createContext();
		await expect(async () => ctx.ui.confirm("Approval", "Continue?")).rejects.toThrow("failed");
		expect(ctx.getUIPrompt()).toBeUndefined();
	});

	it("reads the replacement runtime without inheriting the old waiting span", async () => {
		const oldPrompt = Promise.withResolvers<boolean>();
		runner.setUIContext({ ...runner.getUIContext(), confirm: () => oldPrompt.promise }, "tui");
		const oldContext = runner.createContext();
		const pending = oldContext.ui.confirm("Old dialog", "Continue?");
		runner.invalidate();
		const replacement = new ExtensionRunner(
			[],
			createExtensionRuntime(),
			process.cwd(),
			SessionManager.inMemory(),
			runner.getModelRegistry(),
		);
		const newContext = replacement.createContext();
		expect(newContext.getUIPrompt()).toBeUndefined();
		const newPrompt = Promise.withResolvers<boolean>();
		replacement.setUIContext({ ...replacement.getUIContext(), confirm: () => newPrompt.promise }, "tui");
		const next = newContext.ui.confirm("New dialog", "Continue?");
		oldPrompt.resolve(false);
		await pending;
		expect(newContext.getUIPrompt()).toEqual({ kind: "confirm", title: "New dialog" });
		newPrompt.resolve(true);
		await next;
		expect(newContext.getUIPrompt()).toBeUndefined();
	});

	it("rejects reads from a runtime invalidated by reload or session replacement", () => {
		const ctx = runner.createContext();
		runner.invalidate();
		expect(() => ctx.getUIPrompt()).toThrow("stale");
	});
});
