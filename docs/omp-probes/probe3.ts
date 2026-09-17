import { Container, Text } from "@oh-my-pi/pi-tui";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { type } from "@oh-my-pi/omptype";

export default function probe3(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const out: Record<string, unknown> = {
			textCtor: typeof Text,
			containerCtor: typeof Container,
			formatNumber: typeof formatNumber,
			omptype: typeof type,
			sample: formatNumber(1234567),
			canConstruct: (() => {
				try {
					const c = new Container();
					const t = new Text("hello", 0, 0);
					c.addChild(t);
					return `ok:${c.children?.length ?? "?"}`;
				} catch (e) {
					return `ERR: ${String(e).slice(0, 120)}`;
				}
			})(),
			zodObject: typeof pi.zod.object,
			cwd: ctx.cwd,
		};
		await Bun.write("/tmp/omp-probe/result3.json", JSON.stringify(out, null, 2));
	});
}
