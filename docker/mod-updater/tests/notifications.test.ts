import { describe, expect, test } from "bun:test";
import { buildOutdatedBlocks, type OutdatedSummary } from "../commands/outdated";
import { buildUpdateBlocks, type RunSummary } from "../commands/update";
import { buildErrorBlocks, MAX_MESSAGE_LEN, modLabel, packBlocks } from "../lib/discord";

type Kind = "exact" | "below" | "any" | "pinned";
const change = (id: string, title: string, from: string | null, to: string, matchKind: Kind = "exact") => ({
	id,
	title,
	from,
	to,
	matchKind,
});

// Fill every field with an empty default so each test only states what it exercises;
// adding a summary field later does not churn every literal.
const mkRun = (o: Partial<RunSummary> = {}): RunSummary => ({
	installed: [],
	reEnabled: [],
	updated: [],
	unchanged: [],
	autoAdded: [],
	autoRemoved: [],
	warnings: [],
	deletedZips: [],
	newlyDisabled: [],
	...o,
});

const mkOutdated = (o: Partial<OutdatedSummary> = {}): OutdatedSummary => ({
	wouldInstall: [],
	wouldReEnable: [],
	wouldUpdate: [],
	unchanged: [],
	wouldAutoRemove: [],
	wouldDisable: [],
	wouldOrphanPrune: [],
	warnings: [],
	hasChanges: false,
	...o,
});

describe("buildUpdateBlocks", () => {
	test("emits headers + bullets for updated / installed / deleted", () => {
		const blocks = buildUpdateBlocks(
			mkRun({
				installed: [{ id: "a", title: "Mod A", version: "1.0.0" }],
				updated: [{ id: "b", title: "Mod B", from: "1.0.0", to: "1.1.0", changelog: "Fixed stuff" }],
				deletedZips: ["oldmod"],
			}),
		);
		expect(blocks).toContain("## Updated");
		expect(blocks).toContain("## Newly installed");
		expect(blocks).toContain("## 🗑️ Deleted");
		expect(blocks.some((b) => b.startsWith("• Mod A"))).toBe(true);
		const bBlock = blocks.find((b) => b.includes("Mod B"))!;
		expect(bBlock).toContain("1.0.0 → 1.1.0");
		expect(bBlock).toContain("> Fixed stuff"); // changelog stays attached to its entry block
		expect(blocks.every((b) => !b.startsWith("- "))).toBe(true); // never markdown "- "
	});

	test("emits re-enabled and disabled sections", () => {
		const blocks = buildUpdateBlocks(
			mkRun({
				reEnabled: [{ id: "realsmoke", title: "Real Smoke", version: "1.2.1" }],
				newlyDisabled: [{ id: "smithingplus", title: "Smithing Plus", version: "1.9.0-rc.1" }],
			}),
		);
		expect(blocks).toContain("## Re-enabled (newer version)");
		expect(blocks.some((b) => b.startsWith("• Real Smoke") && b.includes("1.2.1"))).toBe(true);
		expect(blocks).toContain("## 🗑️ Disabled");
		expect(blocks.some((b) => b.startsWith("• Smithing Plus") && b.includes("disabled at 1.9.0-rc.1"))).toBe(true);
	});

	test("omits empty sections (silent summary)", () => {
		expect(buildUpdateBlocks(mkRun())).toEqual([]);
	});

	test("packs within Discord limit at 200-install scale", () => {
		const installed = Array.from({ length: 200 }, (_v, i) => ({ id: `m${i}`, title: `Mod ${i}`, version: "1.0.0" }));
		const blocks = buildUpdateBlocks(mkRun({ installed }));
		const msgs = packBlocks(["## Vintage Story - Mod Update", ...blocks]);
		for (const m of msgs) expect(m.length).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
		for (let i = 0; i < 200; i++) expect(msgs.join("\n")).toContain(`Mod ${i}`);
	});
});

describe("buildOutdatedBlocks", () => {
	test("emits update / install / remove / orphan sections with • bullets", () => {
		const blocks = buildOutdatedBlocks(
			mkOutdated({
				wouldUpdate: [change("b", "Mod B", "1.0.0", "1.1.0")],
				wouldInstall: [change("a", "Mod A", null, "2.0.0", "below")],
				wouldAutoRemove: ["deadlib"],
				wouldOrphanPrune: ["orphan"],
				hasChanges: true,
			}),
		);
		expect(blocks).toContain("## Updates available");
		expect(blocks).toContain("## Would install");
		expect(blocks).toContain("## Would remove (unused deps)");
		expect(blocks).toContain("## 🗑️ Would delete orphan zips");
		expect(blocks.some((b) => b.startsWith("• **Mod B**") && b.includes("1.0.0 → 1.1.0"))).toBe(true);
		expect(blocks.some((b) => b.includes("Mod A") && b.includes("_(below)_"))).toBe(true); // matchKind tag
		expect(blocks).toContain("• orphan.zip");
		expect(blocks.every((b) => !b.startsWith("- "))).toBe(true);
	});

	test("emits would-re-enable and would-disable sections", () => {
		const blocks = buildOutdatedBlocks(
			mkOutdated({
				wouldReEnable: [change("realsmoke", "Real Smoke", null, "1.2.1")],
				wouldDisable: [{ id: "smithingplus", title: "Smithing Plus", version: "1.9.0-rc.1" }],
				hasChanges: true,
			}),
		);
		expect(blocks).toContain("## Would re-enable (newer version)");
		expect(blocks.some((b) => b.startsWith("• Real Smoke") && b.includes("1.2.1"))).toBe(true);
		expect(blocks).toContain("## 🗑️ Would disable");
		expect(blocks.some((b) => b.startsWith("• Smithing Plus") && b.includes("disabled at 1.9.0-rc.1"))).toBe(true);
	});

	test("surfaces fetch failures, collapses below-current into a count", () => {
		const blocks = buildOutdatedBlocks(
			mkOutdated({
				wouldUpdate: [change("b", "Mod B", "1.0.0", "1.1.0")],
				warnings: [
					{ id: "x", message: "fetch/resolve failed: NetworkError: 404 Not Found" },
					{ id: "y", message: "No 1.22.0 version available; using best-below-current" },
					{ id: "z", message: "No 1.22.0 version available; using best-below-current" },
				],
				hasChanges: true,
			}),
		);
		expect(blocks).toContain("## ⚠️ Failed to check");
		expect(blocks.some((b) => b.startsWith("• x:") && b.includes("404"))).toBe(true);
		expect(blocks.some((b) => b.includes("2 mod(s) on below-current fallback"))).toBe(true);
		expect(blocks.some((b) => b.startsWith("• y"))).toBe(false); // not listed individually
	});

	test("packs within Discord limit at 200-install scale", () => {
		const wouldInstall = Array.from({ length: 200 }, (_v, i) => change(`m${i}`, `Mod ${i}`, null, "1.0.0"));
		const blocks = buildOutdatedBlocks(mkOutdated({ wouldInstall, hasChanges: true }));
		const msgs = packBlocks(["## Vintage Story - Updates Available", ...blocks]);
		for (const m of msgs) expect(m.length).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
		for (let i = 0; i < 200; i++) expect(msgs.join("\n")).toContain(`Mod ${i}`);
	});
});

describe("buildErrorBlocks", () => {
	test("header + command + reason", () => {
		const blocks = buildErrorBlocks("update", "NetworkError [xlib]: 404 Not Found");
		expect(blocks[0]).toBe("## ⚠️ Error");
		expect(blocks[1]).toContain("`update` failed:");
		expect(blocks[1]).toContain("404 Not Found");
	});

	test("labels a missing command", () => {
		const blocks = buildErrorBlocks("", "boom");
		expect(blocks[1]).toContain("(no command)");
	});

	test("packs a huge reason within the Discord limit", () => {
		const blocks = buildErrorBlocks("update", "x".repeat(5000));
		const msgs = packBlocks(["# Vintage Story - Mod Updater Error", ...blocks]);
		for (const m of msgs) expect(m.length).toBeLessThanOrEqual(MAX_MESSAGE_LEN);
	});
});

describe("modLabel + title resolution", () => {
	test("modLabel shows title with id when known, bare id otherwise", () => {
		expect(modLabel("34209", "Butchering Strong Bone Converter")).toBe("Butchering Strong Bone Converter (`34209`)");
		expect(modLabel("orphanmod")).toBe("orphanmod");
		expect(modLabel("samename", "samename")).toBe("samename");
	});

	test("buildUpdateBlocks Deleted uses display names via titleOf", () => {
		const titleOf = (id: string) =>
			({ "34183": "XSkills Catchable FotSA Patch", casuariidae: "Fauna of the Stone Age: Casuariidae Plus" })[id];
		const blocks = buildUpdateBlocks(mkRun({ deletedZips: ["casuariidae", "34183", "trueorphan"] }), titleOf);
		expect(blocks).toContain("• XSkills Catchable FotSA Patch (`34183`)");
		expect(blocks).toContain("• Fauna of the Stone Age: Casuariidae Plus (`casuariidae`)");
		expect(blocks).toContain("• trueorphan"); // no title -> bare id
	});

	test("buildOutdatedBlocks remove/orphan sections use titles, true orphan keeps .zip", () => {
		const titleOf = (id: string) => (id === "deadlib" ? "Some Dead Lib" : undefined);
		const blocks = buildOutdatedBlocks(
			mkOutdated({ wouldAutoRemove: ["deadlib"], wouldOrphanPrune: ["leftover"], hasChanges: true }),
			titleOf,
		);
		expect(blocks).toContain("• Some Dead Lib (`deadlib`)");
		expect(blocks).toContain("• leftover.zip"); // unknown -> filename
	});
});
