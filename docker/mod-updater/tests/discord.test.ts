import { describe, expect, test } from "bun:test";
import { MAX_MESSAGE_LEN, packBlocks } from "../lib/discord";

describe("packBlocks", () => {
	test("combines blocks that all fit into one message", () => {
		const blocks = ["## ✅ Updated", "• ModA  1.0", "• ModB  2.0"];
		const out = packBlocks(blocks, 100);
		expect(out).toHaveLength(1);
		expect(out[0]).toBe("## ✅ Updated\n• ModA  1.0\n• ModB  2.0");
	});

	test("splits only at block boundaries, never mid-block", () => {
		const blocks = ["• aaaa", "• bbbb", "• cccc", "• dddd"];
		// limit fits ~2 bullets per message
		const out = packBlocks(blocks, 14);
		for (const msg of out) {
			expect(msg.length).toBeLessThanOrEqual(14);
			// every line is a complete bullet
			for (const line of msg.split("\n")) {
				expect(line.startsWith("• ")).toBe(true);
			}
		}
		// all entries preserved, in order
		expect(out.join("\n").split("\n")).toEqual(blocks);
	});

	test("a header is never the last line of a message", () => {
		const blocks = ["## Section A", "• entry-A", "## Section B", "• entry-B"];
		// Tune limit so 'Section B' would fit at the tail of msg1 but its entry wouldn't.
		const out = packBlocks(blocks, 24);
		for (const msg of out) {
			const lines = msg.split("\n");
			const last = lines[lines.length - 1];
			expect(last.startsWith("## ")).toBe(false);
		}
	});

	test("header leads its section's first entry", () => {
		const blocks = ["## Header", "• first", "• second"];
		const out = packBlocks(blocks, 18);
		// wherever '## Header' appears, the next line is its first entry
		const withHeader = out.find((m) => m.includes("## Header"))!;
		const lines = withHeader.split("\n");
		const hi = lines.indexOf("## Header");
		expect(lines[hi + 1]).toBe("• first");
	});

	test("hard-splits a single oversized block on line boundaries", () => {
		const changelog = "**Mod** 1.0 → 2.0\n" + Array.from({ length: 50 }, (_v, i) => `> line ${i}`).join("\n");
		const out = packBlocks(["## ✅ Updated", changelog], 60);
		for (const msg of out) {
			expect(msg.length).toBeLessThanOrEqual(60);
		}
		// content survives (every "> line N" present somewhere)
		const joined = out.join("\n");
		for (let i = 0; i < 50; i++) expect(joined).toContain(`> line ${i}`);
	});

	test("hard-cuts a single line longer than the limit", () => {
		const huge = "X".repeat(250);
		const out = packBlocks([huge], 100);
		expect(out.length).toBeGreaterThan(1);
		for (const msg of out) expect(msg.length).toBeLessThanOrEqual(100);
		expect(out.join("")).toBe(huge);
	});

	test("uses • bullets, not markdown - lists", () => {
		const blocks = ["## ✅ Newly installed", "• ModA (`a`)  1.0"];
		const out = packBlocks(blocks);
		expect(out[0]).toContain("• ");
		expect(out[0]).not.toMatch(/^- /m);
	});

	test("default limit stays within Discord's 2000 cap", () => {
		expect(MAX_MESSAGE_LEN).toBeLessThanOrEqual(2000);
		const many = Array.from({ length: 200 }, (_v, i) => `• mod-${i} (\`${i}\`)  1.0.0`);
		const out = packBlocks(["## ✅ Newly installed", ...many]);
		for (const msg of out) expect(msg.length).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
		// nothing dropped
		for (let i = 0; i < 200; i++) expect(out.join("\n")).toContain(`mod-${i}`);
	});
});
