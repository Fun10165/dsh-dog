/**
 * Type-level probe for two OMP 18.2.4 extension traps. It is compiled, not run:
 * the `witness*` assignments are deliberate errors whose diagnostics print the
 * types the harness actually infers. Output is kept in `result5.txt`.
 *
 *   # from a scratch dir that can resolve the real @oh-my-pi types:
 *   #   tsconfig.json -> paths: {"@oh-my-pi/*": ["<omp-dog>/dev/typecheck/node_modules/@oh-my-pi/*"]}
 *   <omp-dog>/node_modules/.bin/tsc -p /tmp/omp-zodprobe/tsconfig.json
 *
 * (1) `params` inference with a `pi.zod` schema — §8.4 claims it collapses to
 *     `unknown`, forcing hand-written parameter annotations.
 * (2) the parameter order shipped by the official examples
 *     (examples/extensions/README.md:95: `toolCallId, params, onUpdate, ctx, signal`)
 *     versus the declared contract in src/extensibility/extensions/types.ts:671-677
 *     (`toolCallId, params, signal, onUpdate, ctx`) — §8.1.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function probe(pi: ExtensionAPI) {
	pi.registerTool({
		name: "probe_zod_params",
		label: "Probe Zod Params",
		description: "Reveals the type inferred for execute()'s params from a pi.zod schema.",
		parameters: pi.zod.object({ a: pi.zod.string(), b: pi.zod.number().optional() }),
		async execute(_id, params) {
			// Deliberate error: the diagnostic names the inferred type of `params`.
			const witnessZodParams: 1 = params;
			void witnessZodParams;
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	});

	pi.registerTool({
		name: "probe_execute_order",
		label: "Probe Execute Order",
		description: "Uses the parameter order printed by the official extension examples.",
		parameters: pi.zod.object({ a: pi.zod.string() }),
		async execute(toolCallId, params, onUpdate, ctx, signal) {
			// Deliberate errors: the diagnostics name the declared type of each slot.
			const witnessToolCallId: 1 = toolCallId;
			const witnessParams: 1 = params;
			const witnessOnUpdate: 1 = onUpdate;
			const witnessCtx: 1 = ctx;
			const witnessSignal: 1 = signal;
			void witnessToolCallId;
			void witnessParams;
			void witnessOnUpdate;
			void witnessCtx;
			void witnessSignal;
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	});
}
