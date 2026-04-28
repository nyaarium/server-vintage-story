import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parseModPage } from "../lib/scraper";

const FIXTURE_DIR = path.join(import.meta.dir, "fixtures");

function loadFixture(name: string): string {
	return fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

describe("parseModPage — butchering.html fixture", () => {
	const html = loadFixture("butchering.html");
	const page = parseModPage(html, "https://mods.vintagestory.at/show/mod/7966");

	test("extracts title from h2 > span", () => {
		expect(page.title).toBe("Butchering");
	});

	test("finds all version rows (no silent dropping)", () => {
		expect(page.versions.length).toBeGreaterThan(50);
	});

	test("first version has expected shape", () => {
		const v = page.versions[0];
		expect(v.version).toMatch(/^\d+\.\d+\.\d+/);
		expect(v.gameVersions.length).toBeGreaterThan(0);
		expect(v.gameVersions.every((gv) => /^\d+\.\d+(\.\d+)?/.test(gv))).toBe(true);
		expect(v.downloadUrl).toMatch(/^https:\/\/mods\.vintagestory\.at\/download\//);
	});

	test("every version has a downloadUrl", () => {
		for (const v of page.versions) {
			expect(v.downloadUrl).not.toBeNull();
		}
	});

	test("no version has empty gameVersions", () => {
		for (const v of page.versions) {
			expect(v.gameVersions.length).toBeGreaterThan(0);
		}
	});

	test("every version string is non-empty", () => {
		for (const v of page.versions) {
			expect(v.version.length).toBeGreaterThan(0);
		}
	});

	test("release dates are captured when present", () => {
		const withDates = page.versions.filter((v) => v.releaseDate);
		expect(withDates.length).toBeGreaterThan(0);
	});

	test("download URLs are absolute and properly formed", () => {
		for (const v of page.versions) {
			if (!v.downloadUrl) continue;
			expect(() => new URL(v.downloadUrl!)).not.toThrow();
		}
	});
});

describe("parseModPage — error paths", () => {
	test("throws ScraperError when title is missing", () => {
		expect(() => parseModPage("<html><body>no title here</body></html>", "about:blank")).toThrow(/title/i);
	});

	test("throws ScraperError when no release-table is found", () => {
		const html = `<html><body><h2><span>x</span><span>My Mod</span></h2></body></html>`;
		expect(() => parseModPage(html, "about:blank")).toThrow(/release-table/i);
	});

	test("throws ScraperError when release-table has no version rows", () => {
		const html = `
			<html><body>
				<h2><span>x</span><span>My Mod</span></h2>
				<table class="release-table"><tbody></tbody></table>
			</body></html>
		`;
		expect(() => parseModPage(html, "about:blank")).toThrow(/No versions/i);
	});
});

describe("parseModPage — version range expansion from span.tag", () => {
	test("expands a same-minor patch range into individual versions", () => {
		const html = `
			<html><body>
				<h2><span>x</span><span>Range Mod</span></h2>
				<table class="release-table"><tbody>
					<tr data-assetid="1">
						<td>1.0.0</td>
						<td>slug</td>
						<td><span class="tag">1.20.6 - 1.20.9</span></td>
						<td>0</td>
						<td><span title="date">date</span></td>
						<td>show</td>
						<td><a class="mod-dl" href="/download/x.zip">x.zip</a></td>
					</tr>
				</tbody></table>
			</body></html>
		`;
		const page = parseModPage(html, "about:blank");
		expect(page.versions).toHaveLength(1);
		expect(page.versions[0].gameVersions).toEqual(["1.20.6", "1.20.7", "1.20.8", "1.20.9"]);
	});

	test("mixes single tag links and span ranges", () => {
		const html = `
			<html><body>
				<h2><span>x</span><span>Mixed</span></h2>
				<table class="release-table"><tbody>
					<tr data-assetid="1">
						<td>1.0.0</td>
						<td>slug</td>
						<td>
							<a class="tag" rel="tag">1.22.0</a>
							<span class="tag">1.21.0 - 1.21.2</span>
						</td>
						<td>0</td>
						<td><span title="date">date</span></td>
						<td>show</td>
						<td><a class="mod-dl" href="/download/x.zip">x.zip</a></td>
					</tr>
				</tbody></table>
			</body></html>
		`;
		const page = parseModPage(html, "about:blank");
		expect(page.versions[0].gameVersions).toEqual(["1.22.0", "1.21.0", "1.21.1", "1.21.2"]);
	});
});

describe("parseModPage — changelog extraction", () => {
	test("strips PGP signature blocks", () => {
		const html = `
			<html><body>
				<h2><span>x</span><span>PGP Mod</span></h2>
				<table class="release-table"><tbody>
					<tr data-assetid="1">
						<td>1.0.0</td>
						<td>slug</td>
						<td><a class="tag" rel="tag">1.22.0</a></td>
						<td>0</td>
						<td><span title="date">date</span></td>
						<td>show</td>
						<td><a class="mod-dl" href="/download/x.zip">x.zip</a></td>
					</tr>
					<tr>
						<td colspan="7">
							<div class="release-changelog">
								Real change text.
								-----BEGIN PGP SIGNATURE-----
								abc123
								-----END PGP SIGNATURE-----
							</div>
						</td>
					</tr>
				</tbody></table>
			</body></html>
		`;
		const page = parseModPage(html, "about:blank");
		expect(page.versions[0].changelog).toContain("Real change text");
		expect(page.versions[0].changelog).not.toContain("PGP SIGNATURE");
		expect(page.versions[0].changelog).not.toContain("abc123");
	});

	test("strips leading version number from changelog", () => {
		const html = `
			<html><body>
				<h2><span>x</span><span>VHeader Mod</span></h2>
				<table class="release-table"><tbody>
					<tr data-assetid="1">
						<td>1.5.0</td>
						<td>slug</td>
						<td><a class="tag" rel="tag">1.22.0</a></td>
						<td>0</td>
						<td><span title="date">date</span></td>
						<td>show</td>
						<td><a class="mod-dl" href="/download/x.zip">x.zip</a></td>
					</tr>
					<tr>
						<td colspan="7">
							<div class="release-changelog">1.5.0 Added new feature</div>
						</td>
					</tr>
				</tbody></table>
			</body></html>
		`;
		const page = parseModPage(html, "about:blank");
		expect(page.versions[0].changelog).toBe("Added new feature");
	});
});
