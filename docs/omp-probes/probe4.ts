import { Container, Text } from "@oh-my-pi/pi-tui";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { formatNumber } from "@oh-my-pi/pi-utils";

export default function probe4(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const out: Record<string, unknown> = {
			textCtor: typeof Text,
			containerCtor: typeof Container,
			formatNumber: typeof formatNumber,
			sample: formatNumber(1234567),
			canConstruct: (() => {
				try {
					const c = new Container();
					const t = new Text("hello", 0, 0);
					c.addChild(t);
					return "ok";
				} catch (e) {
					return `ERR: ${String(e).slice(0, 120)}`;
				}
			})(),
			zodObject: typeof pi.zod.object,
			arktype: typeof pi.arktype,
			cwd: ctx.cwd,
		};
		await Bun.write("/tmp/omp-probe/result4.json", JSON.stringify(out, null, 2));
	});
}
