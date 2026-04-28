export interface VersionParts {
	major: number;
	minor: number;
	patch: number;
	extra: string | null;
}

export function splitVersion(version: string): VersionParts {
	const [base = "", ...extraParts] = version.split("-");
	const extra = extraParts.join("-");

	const [major = "0", minor = "0", patch = "0"] = base.split(".");

	return {
		major: parseInt(major, 10) || 0,
		minor: parseInt(minor, 10) || 0,
		patch: parseInt(patch, 10) || 0,
		extra: extra || null,
	};
}

export function compareVersions(a: string, b: string): number {
	const pa = splitVersion(a);
	const pb = splitVersion(b);

	if (pa.major !== pb.major) return pa.major - pb.major;
	if (pa.minor !== pb.minor) return pa.minor - pb.minor;
	if (pa.patch !== pb.patch) return pa.patch - pb.patch;
	return 0;
}

export function matchesExactly(candidate: string, target: string): boolean {
	const c = splitVersion(candidate);
	const t = splitVersion(target);
	return c.major === t.major && c.minor === t.minor && c.patch === t.patch;
}

export function matchesMinor(candidate: string, target: string): boolean {
	const c = splitVersion(candidate);
	const t = splitVersion(target);
	return c.major === t.major && c.minor === t.minor;
}

export function isVersionBelow(candidate: string, target: string): boolean {
	return compareVersions(candidate, target) < 0;
}

export function expandVersionRange(startVersion: string, endVersion: string): string[] {
	const start = splitVersion(startVersion);
	const end = splitVersion(endVersion);

	if (start.major === end.major && start.minor === end.minor) {
		const versions: string[] = [];
		for (let patch = start.patch; patch <= end.patch; patch++) {
			versions.push(`${start.major}.${start.minor}.${patch}`);
		}
		return versions;
	}

	return [startVersion, endVersion];
}
