import { el } from "../../../shared/ui/index.js";

/** Pictures larger than this (in pixels, on the longer side) are scaled down before they're stored. */
const MAX_STORED_IMAGE_PIXELS = 1600;

/**
 * An image file as a data URL with its size in pixels, or null when the browser can't read it as an image. Large
 * pictures are scaled down to MAX_STORED_IMAGE_PIXELS first, so the board's data stays small enough to load.
 */
export async function readImage(file: File): Promise<{ src: string; width: number; height: number } | null> {
	const url = URL.createObjectURL(file);
	try {
		const image = new Image();
		image.src = url;
		await image.decode();
		const { naturalWidth: width, naturalHeight: height } = image;
		if (width === 0 || height === 0) return null;
		const scale = Math.min(1, MAX_STORED_IMAGE_PIXELS / Math.max(width, height));
		if (scale === 1) return { src: await dataUrl(file), width, height };
		const canvas = el("canvas", { width: Math.round(width * scale), height: Math.round(height * scale) });
		canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
		// WebP keeps transparency at a fraction of PNG's size; browsers that can't write it fall back to PNG.
		return { src: canvas.toDataURL("image/webp", 0.85), width: canvas.width, height: canvas.height };
	} catch {
		return null;
	} finally {
		URL.revokeObjectURL(url);
	}
}

function dataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}
