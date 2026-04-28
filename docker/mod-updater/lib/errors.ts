export class ModUpdaterError extends Error {
	constructor(message: string, public modId?: string) {
		super(message);
		this.name = this.constructor.name;
	}
}

export class ConfigError extends ModUpdaterError {}
export class LockfileError extends ModUpdaterError {}
export class NetworkError extends ModUpdaterError {}
export class ScraperError extends ModUpdaterError {}
export class ResolutionError extends ModUpdaterError {}
export class PinFailureError extends ModUpdaterError {}
export class DownloadError extends ModUpdaterError {}

export function isModUpdaterError(err: unknown): err is ModUpdaterError {
	return err instanceof ModUpdaterError;
}
