import * as cheerio from "cheerio";
import { NetworkError, ScraperError } from "./errors";
import { MOD_DB_BASE } from "./paths";
import { expandVersionRange } from "./version";

export interface ModPageVersion {
	version: string;
	gameVersions: string[];
	releaseDate: string;
	changelog: string;
	downloadUrl: string | null;
}

export interface ModPage {
	title: string;
	versions: ModPageVersion[];
}

export async function fetchModPage(url: string): Promise<ModPage> {
	let response: Response;
	try {
		response = await fetch(url);
	} catch (err) {
		throw new NetworkError(`Failed to fetch ${url}: ${(err as Error).message}`);
	}

	if (!response.ok) {
		throw new NetworkError(`Fetch ${url} returned ${response.status} ${response.statusText}`);
	}

	const html = await response.text();
	return parseModPage(html, url);
}

export function parseModPage(html: string, sourceUrl: string): ModPage {
	const $ = cheerio.load(html);

	const title = $("h2 > span").eq(1).text().replace(/\s+/gs, " ").trim();
	if (!title) {
		throw new ScraperError(`Could not extract mod title from ${sourceUrl}`);
	}

	const $table = $("table.release-table");
	if (!$table.length) {
		throw new ScraperError(`No release-table found on ${sourceUrl}`);
	}

	const infoRows: cheerio.Cheerio<any>[] = [];
	const changelogRows: cheerio.Cheerio<any>[] = [];

	$table.find("tbody tr").each((_i, row) => {
		const $row = $(row);
		if ($row.attr("data-assetid")) {
			infoRows.push($row);
		} else if ($row.find(".release-changelog").length > 0) {
			changelogRows.push($row);
		}
	});

	const versions: ModPageVersion[] = [];

	for (let i = 0; i < infoRows.length; i++) {
		const $infoRow = infoRows[i];
		const $changelogRow = changelogRows[i];

		const version = $infoRow.find("td").first().text().trim().replace(/^v/, "");
		if (!version) continue;

		const gameVersions: string[] = [];

		$infoRow.find("a.tag[rel='tag']").each((_j, link) => {
			const v = $(link).text().trim();
			if (v) gameVersions.push(v);
		});

		$infoRow.find("span.tag").each((_j, span) => {
			const txt = $(span).text().trim();
			if (!txt) return;
			if (txt.includes(" - ")) {
				const [start = "", end = ""] = txt.split(" - ").map((s) => s.trim());
				if (start && end) gameVersions.push(...expandVersionRange(start, end));
				else if (start) gameVersions.push(start);
			} else {
				gameVersions.push(txt);
			}
		});

		const releaseDate = $infoRow.find("span[title]").first().text().trim();

		const downloadHref = $infoRow.find("a.mod-dl").attr("href");
		const downloadUrl = downloadHref ? `${MOD_DB_BASE}${downloadHref}` : null;

		let changelog = "";
		if ($changelogRow && $changelogRow.length > 0) {
			const $content = $changelogRow.find(".release-changelog");
			if ($content.length > 0) {
				changelog = $content
					.text()
					.trim()
					.replace(new RegExp(`^${escapeRegex(version)}\\s*`), "")
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line)
					.join("\n")
					.replace(/-----BEGIN PGP SIGNATURE-----[\s\S]*?-----END PGP SIGNATURE-----/g, "")
					.trim();
			}
		}

		versions.push({ version, gameVersions, releaseDate, changelog, downloadUrl });
	}

	if (!versions.length) {
		throw new ScraperError(`No versions found on ${sourceUrl}`);
	}

	return { title, versions };
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
