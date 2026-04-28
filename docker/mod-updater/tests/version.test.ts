import { describe, expect, test } from "bun:test";
import {
	compareVersions,
	expandVersionRange,
	isVersionBelow,
	matchesExactly,
	matchesMinor,
	splitVersion,
} from "../lib/version";

describe("splitVersion", () => {
	test("standard three-part version", () => {
		expect(splitVersion("1.22.0")).toEqual({ major: 1, minor: 22, patch: 0, extra: null });
	});

	test("version with -pre suffix", () => {
		expect(splitVersion("1.22.0-pre.1")).toEqual({
			major: 1,
			minor: 22,
			patch: 0,
			extra: "pre.1",
		});
	});

	test("version with -dev suffix containing hyphen", () => {
		expect(splitVersion("2.0.0-dev-12")).toEqual({
			major: 2,
			minor: 0,
			patch: 0,
			extra: "dev-12",
		});
	});

	test("partial version defaults missing parts to zero", () => {
		expect(splitVersion("1")).toEqual({ major: 1, minor: 0, patch: 0, extra: null });
		expect(splitVersion("1.2")).toEqual({ major: 1, minor: 2, patch: 0, extra: null });
	});

	test("non-numeric parts become zero", () => {
		expect(splitVersion("a.b.c")).toEqual({ major: 0, minor: 0, patch: 0, extra: null });
	});
});

describe("compareVersions", () => {
	test("returns zero for equal versions", () => {
		expect(compareVersions("1.22.0", "1.22.0")).toBe(0);
	});

	test("returns positive when a > b by major", () => {
		expect(compareVersions("2.0.0", "1.22.0")).toBeGreaterThan(0);
	});

	test("returns negative when a < b by minor", () => {
		expect(compareVersions("1.21.9", "1.22.0")).toBeLessThan(0);
	});

	test("compares patch when major.minor equal", () => {
		expect(compareVersions("1.22.0", "1.22.3")).toBeLessThan(0);
		expect(compareVersions("1.22.5", "1.22.3")).toBeGreaterThan(0);
	});

	test("ignores extra suffix (pre/dev tags)", () => {
		expect(compareVersions("1.22.0-pre.1", "1.22.0")).toBe(0);
	});

	test("sorts array newest-first with negation", () => {
		const arr = ["1.5.0", "1.6.2", "1.5.1", "2.0.0", "1.0.0"];
		arr.sort((a, b) => -compareVersions(a, b));
		expect(arr).toEqual(["2.0.0", "1.6.2", "1.5.1", "1.5.0", "1.0.0"]);
	});
});

describe("matchesExactly", () => {
	test("true when major.minor.patch match", () => {
		expect(matchesExactly("1.22.0", "1.22.0")).toBe(true);
	});

	test("false on patch mismatch", () => {
		expect(matchesExactly("1.22.1", "1.22.0")).toBe(false);
	});

	test("ignores extra suffix", () => {
		expect(matchesExactly("1.22.0-pre.1", "1.22.0")).toBe(true);
	});
});

describe("matchesMinor", () => {
	test("true when major.minor match, patch differs", () => {
		expect(matchesMinor("1.22.5", "1.22.0")).toBe(true);
	});

	test("false when minor differs", () => {
		expect(matchesMinor("1.21.0", "1.22.0")).toBe(false);
	});

	test("false when major differs", () => {
		expect(matchesMinor("2.22.0", "1.22.0")).toBe(false);
	});
});

describe("isVersionBelow", () => {
	test("true when candidate major is lower", () => {
		expect(isVersionBelow("0.9.9", "1.22.0")).toBe(true);
	});

	test("true when candidate minor is lower", () => {
		expect(isVersionBelow("1.20.12", "1.22.0")).toBe(true);
	});

	test("true when candidate patch is lower", () => {
		expect(isVersionBelow("1.22.0", "1.22.1")).toBe(true);
	});

	test("false when candidate equals target", () => {
		expect(isVersionBelow("1.22.0", "1.22.0")).toBe(false);
	});

	test("false when candidate is above", () => {
		expect(isVersionBelow("1.23.0", "1.22.0")).toBe(false);
	});
});

describe("expandVersionRange", () => {
	test("expands a patch-only range into all versions", () => {
		expect(expandVersionRange("1.20.6", "1.20.9")).toEqual([
			"1.20.6",
			"1.20.7",
			"1.20.8",
			"1.20.9",
		]);
	});

	test("single-version range returns just that version", () => {
		expect(expandVersionRange("1.20.6", "1.20.6")).toEqual(["1.20.6"]);
	});

	test("cross-minor range returns only endpoints", () => {
		expect(expandVersionRange("1.19.8", "1.20.2")).toEqual(["1.19.8", "1.20.2"]);
	});

	test("cross-major range returns only endpoints", () => {
		expect(expandVersionRange("1.22.0", "2.0.0")).toEqual(["1.22.0", "2.0.0"]);
	});
});
