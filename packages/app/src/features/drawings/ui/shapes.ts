import { el, svgEl } from "../../../shared/ui/index.js";
import { isArea, isImage, type BoxDrawing, type Drawing } from "../core.js";

/** Boxes are filled with a light tint of their color; outlines and text use a darker shade. */
export const fillFor = (color: string) => `color-mix(in srgb, ${color} 40%, white)`;
export const strokeFor = (color: string) => `color-mix(in srgb, ${color} 55%, black)`;

/** The SVG elements showing a drawing, without any handlers. Text is left out with `withText: false` (while it's
 * being edited). */
export function drawingShape(d: Drawing, withText = true): SVGElement[] {
	if (isImage(d)) {
		return [svgEl("image", { class: "drawing-image", href: d.src, x: d.x, y: d.y, width: d.width, height: d.height, preserveAspectRatio: "none" })];
	}
	const area = isArea(d);
	const shape = svgEl("rect", { x: d.x, y: d.y, width: d.width, height: d.height, rx: area ? 0 : 6 });
	shape.classList.add(area ? "drawing-area" : "drawing-shape");
	shape.style.fill = fillFor(d.color);
	shape.style.stroke = strokeFor(d.color);
	return d.text && withText ? [shape, textNode(d)] : [shape];
}

/** Text in a text box is centered; an area's name starts at the top left (as its title). */
export function textPlacement(box: BoxDrawing): string {
	return box.kind === "area" ? "area-name" : "centered";
}

function textNode(box: BoxDrawing): SVGForeignObjectElement {
	const label = el(
		"div",
		{ className: `drawing-label size-${box.textSize} ${textPlacement(box)}` },
		box.text,
	);
	label.style.color = strokeFor(box.color);
	return svgEl("foreignObject", { x: box.x, y: box.y, width: box.width, height: box.height }, label);
}
