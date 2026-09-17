import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function probe2(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const out: Record<string, unknown> = {};
		const inspect = (label: string, value: unknown) => {
			const v = value as Record<string, unknown> | undefined;
			if (v == null) {
				out[label] = null;
				return;
			}
			const proto = Object.getPrototypeOf(v);
			out[label] = {
				ownKeys: Object.keys(v).slice(0, 60),
				protoKeys: proto ? Object.getOwnPropertyNames(proto).slice(0, 60) : null,
				type: typeof v,
			};
		};
		const candidate = pi as unknown as Record<string, unknown>;
		inspect("pi.pi", candidate.pi);
		inspect("pi.runtime", candidate.runtime);
		inspect("pi.events", candidate.events);
		inspect("pi.extension", candidate.extension);
		inspect("pi.logger", candidate.logger);
		out.zodHasObject = typeof (candidate.zod as Record<string, unknown> | undefined)?.object;
		out.arktypeType = typeof candidate.arktype;
		// pi.pi may expose the package's exports map; probe a few plausible members.
		const pkg = candidate.pi as Record<string, unknown> | undefined;
		if (pkg && typeof pkg === "object") {
			out.piExportTypes = Object.fromEntries(
				Object.keys(pkg)
					.slice(0, 40)
					.map(k => [k, typeof pkg[k]]),
			);
			for (const key of ["tui", "components", "theme", "Container", "Text", "session", "tools"]) {
				const val = pkg[key];
				out[`pi.${key}`] = val === undefined ? "undefined" : typeof val;
			}
		}
		await Bun.write("/tmp/omp-probe/result2.json", JSON.stringify(out, null, 2));
	});
}
