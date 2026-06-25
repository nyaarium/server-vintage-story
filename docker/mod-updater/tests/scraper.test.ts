import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parseModPage } from "../lib/scraper";

const FIXTURE_DIR = path.join(import.meta.dir, "fixtures");

function loadFixture(name: string): string {
	return fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

describe("parseModPage - butchering.html fixture", () => {
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

describe("parseModPage - error paths", () => {
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

describe("parseModPage - version range expansion from span.tag", () => {
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

describe("parseModPage - retracted releases", () => {
	// Models the real mods.vintagestory.at markup: a retracted release renders as a
	// <tr class="retracted"> with no a.mod-dl, followed by its changelog row.
	const html = `
		<html><body>
			<h2><span>x</span><span>Caninae</span></h2>
			<table class="release-table"><tbody>
				<tr data-assetid="56949" class="retracted">
					<td>1.1.7</td>
					<td>caninae</td>
					<td><div class="tags"><a class="tag" rel="tag" href="/list/mod?gv[]=1.22.3">1.22.3</a></div></td>
					<td>0</td>
					<td><span title="Jun 24th 2026">10 hours ago</span></td>
					<td><label class="cl-trigger">Show</label></td>
					<td colspan="2">Release Retracted</td>
				</tr>
				<tr>
					<td colspan="8"><div class="release-changelog"><h4>Retraction Reason:</h4><p>Duplicate upload</p></div></td>
				</tr>
				<tr data-assetid="56948">
					<td>1.1.6</td>
					<td>caninae</td>
					<td><a class="tag" rel="tag">1.22.3</a></td>
					<td>243</td>
					<td><span title="Jun 24th 2026">10 hours ago</span></td>
					<td>show</td>
					<td><a class="mod-dl" href="/download/102972/FotSA-Caninae-v1.1.6.zip">FotSA-Caninae-v1.1.6.zip</a></td>
				</tr>
				<tr>
					<td colspan="7"><div class="release-changelog">1.1.6 Updated for 1.22.3</div></td>
				</tr>
			</tbody></table>
		</body></html>
	`;

	test("omits the retracted version entirely", () => {
		const page = parseModPage(html, "about:blank");
		expect(page.versions.map((v) => v.version)).toEqual(["1.1.6"]);
	});

	test("the newest emitted version is the real (downloadable) one", () => {
		const page = parseModPage(html, "about:blank");
		const top = page.versions[0];
		expect(top.version).toBe("1.1.6");
		expect(top.downloadUrl).toBe("https://mods.vintagestory.at/download/102972/FotSA-Caninae-v1.1.6.zip");
		expect(top.gameVersions).toContain("1.22.3");
	});

	test("changelog pairing stays aligned (no retraction text leaks into 1.1.6)", () => {
		const page = parseModPage(html, "about:blank");
		expect(page.versions[0].changelog).toBe("Updated for 1.22.3");
		expect(page.versions[0].changelog).not.toContain("Retraction");
	});

	test("every emitted version still has a downloadUrl", () => {
		const page = parseModPage(html, "about:blank");
		for (const v of page.versions) expect(v.downloadUrl).not.toBeNull();
	});
});

describe("parseModPage - changelog extraction", () => {
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
