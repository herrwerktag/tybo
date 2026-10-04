// The core stays usable outside the browser (e.g. against a database), so it may not rely on the browser's
// type library. The few platform globals it uses are typed here instead.
/** The pieces of the platform's WebCrypto the core uses: secure randomness for ids. */
interface Crypto {
	getRandomValues<T extends ArrayBufferView>(array: T): T;
	randomUUID(): `${string}-${string}-${string}-${string}-${string}`;
}

declare var crypto: Crypto;
