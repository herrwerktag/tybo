/** Crockford base32, as used by ULID (https://github.com/ulid/spec). */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A 26-character ULID: 10 characters of millisecond timestamp, then 16 random characters. */
export function ulid(time = Date.now()): string {
	let timePart = "";
	for (let i = 0, t = time; i < 10; i++) {
		const mod = t % 32;
		timePart = ENCODING[mod] + timePart;
		t = (t - mod) / 32;
	}
	// 256 is a multiple of 32, so each byte maps uniformly onto one character (5 random bits).
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let randomPart = "";
	for (const byte of bytes) randomPart += ENCODING[byte % 32];
	return timePart + randomPart;
}

export function isUlid(value: unknown): value is string {
	return typeof value === "string" && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
}
