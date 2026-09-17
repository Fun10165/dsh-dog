import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function probe(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const out: Record<string, unknown> = {};
		const safe = (fn: () => unknown) => {
			try {
				return fn();
			} catch (e) {
				return `ERR: ${String(e).slice(0, 160)}`;
			}
		};
		out.piProto = Object.getOwnPropertyNames(Object.getPrototypeOf(pi));
		out.ctxProto = Object.getOwnPropertyNames(Object.getPrototypeOf(ctx));
		out.ctxKeys = Object.keys(ctx);
		out.hasUI = (ctx as { hasUI?: unknown }).hasUI;
		const ui = (ctx as { ui?: object }).ui;
		out.ui = safe(() => (ui ? Object.getOwnPropertyNames(Object.getPrototypeOf(ui)) : null));
		out.sessionManager = safe(() => {
			const sm = (ctx as { sessionManager?: object }).sessionManager;
			return sm ? Object.getOwnPropertyNames(Object.getPrototypeOf(sm)) : null;
		});
		out.models = safe(() => {
			const m = (ctx as { models?: object }).models;
			return m ? Object.getOwnPropertyNames(Object.getPrototypeOf(m)) : null;
		});
		for (const spec of [
			"@oh-my-pi/pi-tui",
			"@oh-my-pi/pi-coding-agent",
			"@oh-my-pi/pi-agent-core",
			"@oh-my-pi/pi-utils",
		]) {
			try {
				const mod = (await import(spec)) as Record<string, unknown>;
				out[`import:${spec}`] = Object.keys(mod).slice(0, 45);
			} catch (e) {
				out[`import:${spec}`] = `ERR: ${String(e).slice(0, 180)}`;
			}
		}
		out.execType = typeof (pi as { exec?: unknown }).exec;
		out.uiCustom = safe(() => typeof (ui as { custom?: unknown })?.custom);
		out.piKeys = Object.keys(pi).slice(0, 40);
		await Bun.write("/tmp/omp-probe/result.json", JSON.stringify(out, null, 2));
	});
}
