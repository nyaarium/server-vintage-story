export const log = {
	info(msg: string): void {
		console.log(msg);
	},
	ok(msg: string): void {
		console.log(`✓ ${msg}`);
	},
	warn(msg: string): void {
		console.log(`⚠  ${msg}`);
	},
	err(msg: string): void {
		console.error(`✗ ${msg}`);
	},
	section(title: string): void {
		console.log(`\n${title}`);
	},
	blank(): void {
		console.log("");
	},
};
