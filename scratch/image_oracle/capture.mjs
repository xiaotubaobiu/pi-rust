// Oracle capture for W3.2 residual: utils image auto-resize surface.
// Runs the REAL upstream TS sources (copied to upstream/ unchanged) under node
// with the real @silvia-odwyer/photon-node wasm backend, and dumps every
// deterministic observable as JSON for the Rust-side tests.
import { readFileSync } from "node:fs";
import { applyExifOrientation } from "./upstream/exif-orientation.ts";
import { convertToPng, convertImageBytesToPng } from "./upstream/image-convert.ts";
import { processImage } from "./upstream/image-process.ts";
import { resizeImageInProcess } from "./upstream/image-resize-core.ts";
import { formatDimensionNote, resizeImage } from "./upstream/image-resize.ts";

const photon = await (await import("./upstream/photon.ts")).loadPhoton();
if (!photon) throw new Error("photon failed to load; oracle would be useless");

const F = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));
const out = { photonLoaded: true, fixtures: F };

// ---------------------------------------------------------------------------
// A. EXIF orientation transform matrix (pure parsing + pixel permutation).
// ---------------------------------------------------------------------------
// Distinct 2x3 RGBA grid: pixel p = y*w+x -> [3p+16, 3p+32, 3p+48, 255].
function grid(w, h) {
	const px = new Uint8Array(w * h * 4);
	for (let p = 0; p < w * h; p++) {
		px[p * 4] = 16 + 3 * p;
		px[p * 4 + 1] = 32 + 3 * p;
		px[p * 4 + 2] = 48 + 3 * p;
		px[p * 4 + 3] = 255;
	}
	return px;
}

function app1(payload) {
	const seg = Buffer.alloc(payload.length + 4);
	seg[0] = 0xff;
	seg[1] = 0xe1;
	seg.writeUInt16BE(payload.length + 2, 2);
	payload.copy(seg, 4);
	return seg;
}

// TIFF body declaring tag 0x0112 = `value`, byte order II/MM.
function tiff(order, value, { withExifPrefix = true, entryCount = null, ifdOffset = 8, extraEntry = false } = {}) {
	const le = order === "II";
	const prefix = withExifPrefix ? Buffer.from("Exif\0\0", "ascii") : Buffer.alloc(0);
	const entries = [];
	if (extraEntry) {
		const make = Buffer.alloc(12);
		make[0] = 0x01;
		make[1] = 0x0f; // tag 0x010f (Make) in the active byte order
		make[3] = 0x02; // type ASCII
		entries.push(make);
	}
	const entry = Buffer.alloc(12);
	if (le) {
		entry[0] = 0x12;
		entry[1] = 0x01; // tag 0x0112 little-endian
		entry[2] = 0x03;
		entry[4] = 0x01; // count 1
		entry.writeUInt16LE(value, 8);
	} else {
		entry[0] = 0x01;
		entry[1] = 0x12; // tag 0x0112 big-endian
		entry[3] = 0x03;
		entry[5] = 0x01;
		entry.writeUInt16BE(value, 8);
	}
	entries.push(entry);
	const count = entryCount ?? entries.length;
	const body = Buffer.concat([
		Buffer.from(order, "ascii"),
		le ? Buffer.from([0x2a, 0x00]) : Buffer.from([0x00, 0x2a]),
		le
		? Buffer.from([ifdOffset & 0xff, (ifdOffset >> 8) & 0xff, 0, 0])
		: Buffer.from([0, 0, (ifdOffset >> 8) & 0xff, ifdOffset & 0xff]),
		le ? Buffer.from([count & 0xff, (count >> 8) & 0xff]) : Buffer.from([(count >> 8) & 0xff, count & 0xff]),
		...entries,
		Buffer.from([0x00, 0x00, 0x00, 0x00]),
	]);
	return Buffer.concat([prefix, body]);
}

function jpegWithSegments(segments) {
	return Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, Buffer.from([0x00])]);
}

// RIFF WebP shell with arbitrary chunks; odd sizes get the RIFF pad byte.
function webpWithChunks(chunks) {
	const parts = [];
	for (const [id, data] of chunks) {
		const head = Buffer.alloc(8);
		head.write(id, 0, "ascii");
		head.writeUInt32LE(data.length, 4);
		parts.push(head, data);
		if (data.length % 2 === 1) parts.push(Buffer.from([0x00]));
	}
	const body = Buffer.concat(parts);
	const riff = Buffer.alloc(12);
	riff.write("RIFF", 0, "ascii");
	riff.writeUInt32LE(body.length, 4);
	riff.write("WEBP", 8, "ascii");
	return Buffer.concat([riff, body]);
}

function observe(name, bytes) {
	console.error(`observe ${name}`);
	const img = new photon.PhotonImage(grid(2, 3), 2, 3);
	const before = Buffer.from(img.get_raw_pixels()).toString("hex");
	const result = applyExifOrientation(photon, img, bytes);
	const same = result === img;
	const rec = {
		sameObject: same,
		width: result.get_width(),
		height: result.get_height(),
		pixels: Buffer.from(result.get_raw_pixels()).toString("hex"),
		before,
	};
	result.free();
	if (!same) img.free();
	out.exif[name] = rec;
}

out.exif = {};
for (let o = 1; o <= 8; o++) observe(`jpeg_le_${o}`, jpegWithSegments([app1(tiff("II", o))]));
observe("jpeg_be_6", jpegWithSegments([app1(tiff("MM", 6))]));
observe("jpeg_be_2", jpegWithSegments([app1(tiff("MM", 2))]));
// Orientation as the SECOND IFD entry (loop iteration).
observe("jpeg_le_8_extra_entry", jpegWithSegments([app1(tiff("II", 8, { extraEntry: true }))]));
// Truncated TIFF header: fewer than 8 bytes after tiffStart.
observe("jpeg_truncated_tiff", jpegWithSegments([app1(Buffer.from("Exif\0\0II\x2a\x00\x08\x00"))]));
// IFD offset far beyond the buffer.
observe("jpeg_ifd_beyond_len", jpegWithSegments([app1(tiff("II", 6, { withExifPrefix: false, ifdOffset: 0x7fff }))]));
// entryCount larger than the remaining buffer.
observe("jpeg_entry_beyond_len", jpegWithSegments([app1(tiff("II", 4, { entryCount: 200 }))]));
// XMP APP1 before the EXIF APP1.
const xmp = app1(Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"/>'));
observe("jpeg_xmp_then_exif_6", jpegWithSegments([xmp, app1(tiff("II", 6))]));
observe("jpeg_app1_xmp_only", jpegWithSegments([xmp]));
// Out-of-range and degenerate values fall back to 1.
observe("jpeg_le_9", jpegWithSegments([app1(tiff("II", 9))]));
observe("jpeg_le_0", jpegWithSegments([app1(tiff("II", 0))]));
// Run of 0xff bytes before the first real marker (0xff-continue branch).
observe("jpeg_ff_run_before_app1_3", jpegWithSegments([Buffer.from([0xff, 0xff]), Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), app1(tiff("II", 3))]));
// No markers at all after SOI.
observe("jpeg_no_markers", Buffer.from([0xff, 0xd8, 0x01, 0x02]));
// APP1 segment shorter than the Exif prefix window.
observe("jpeg_app1_short", jpegWithSegments([Buffer.from([0xff, 0xe1, 0x00, 0x02, 0xaa, 0xbb])]));
// WebP with prefixed EXIF chunk.
observe("webp_exif_prefix_6", webpWithChunks([["VP8 ", Buffer.from([1, 2, 3])], ["EXIF", tiff("II", 6)]]));
observe("webp_exif_prefix_8", webpWithChunks([["EXIF", tiff("II", 8)]]));
// WebP EXIF chunk without the Exif\0\0 prefix.
observe("webp_no_prefix_5", webpWithChunks([["EXIF", tiff("II", 5, { withExifPrefix: false })]]));
// Odd-size chunk before EXIF exercises the even-padding walk.
observe("webp_odd_padding_7", webpWithChunks([["ODDC", Buffer.from([9, 9, 9])], ["EXIF", tiff("II", 7)]]));
// EXIF chunk whose declared size runs beyond the buffer.
const badExif = Buffer.alloc(8);
badExif.write("EXIFXX", 0, "ascii");
badExif.writeUInt32LE(0x7fffffff, 4);
observe("webp_exif_chunk_beyond", webpWithChunks([["EXIF", badExif]]));
// WebP without any EXIF chunk.
observe("webp_no_exif", webpWithChunks([["VP8 ", Buffer.from([1, 2, 3])]]));
// PNG and empty bytes -> orientation 1.
observe("png_no_exif", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
observe("empty", Buffer.alloc(0));

// ---------------------------------------------------------------------------
// B. convert / resize / process decision surfaces.
// ---------------------------------------------------------------------------
const TINY_PNG_B64 = F.TINY_PNG;

function summarize(result) {
	if (result === null) return null;
	const summary = { ...result, dataWasPassthroughOfInput: undefined };
	if (typeof summary.data === "string") {
		const bytes = Buffer.from(summary.data, "base64");
		summary.dataWasPassthroughOfInput = summary.data === TINY_PNG_B64;
		summary.dataMagic = bytes.subarray(0, 8).toString("hex");
		summary.dataByteLength = bytes.length;
		if (summary.data === TINY_PNG_B64) summary.data = "<passthrough TINY_PNG>";
		else summary.data = `<re-encoded ${bytes.length} bytes>`;
	}
	return summary;
}

out.convertToPng = {
	pngPassthrough: await convertToPng(F.TINY_PNG, "image/png"),
	jpegToPng: await convertToPng(F.TINY_JPEG, "image/jpeg"),
	garbage: await convertToPng("aGVsbG8=", "image/x-unknown"),
};

const rawPng = await convertImageBytesToPng(Buffer.from(F.TINY_PNG, "base64"));
out.convertImageBytesToPng = {
	png_identical_to_input: Buffer.from(rawPng).equals(Buffer.from(F.TINY_PNG, "base64")),
	jpeg_magic: Buffer.from(await convertImageBytesToPng(Buffer.from(F.TINY_JPEG, "base64"))).subarray(0, 8).toString("hex"),
	jpeg_xmp_orientation_dims: await (async () => {
		const bytes = Buffer.from(await convertImageBytesToPng(Buffer.from(F.JPEG_2X1_XMP_THEN_EXIF6, "base64")));
		return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
	})(),
	garbage: await convertImageBytesToPng(Buffer.from([1, 2, 3])),
};

out.resizeImage = {
	tiny_within_limits: summarize(await resizeImage(Buffer.from(F.TINY_PNG, "base64"), "image/png", { maxWidth: 100, maxHeight: 100, maxBytes: 1024 * 1024 })),
	medium_dimensions: summarize(await resizeImage(Buffer.from(F.MEDIUM_PNG_100x100, "base64"), "image/png", { maxWidth: 50, maxHeight: 50, maxBytes: 1024 * 1024 })),
	large_byte_limit: summarize(await resizeImage(Buffer.from(F.LARGE_PNG_200x200, "base64"), "image/png", { maxWidth: 2000, maxHeight: 2000, maxBytes: Math.floor(F.LARGE_PNG_200x200.length * 0.9) })),
	large_impossible: summarize(await resizeImage(Buffer.from(F.LARGE_PNG_200x200, "base64"), "image/png", { maxWidth: 2000, maxHeight: 2000, maxBytes: 1 })),
	tiny_jpeg: summarize(await resizeImage(Buffer.from(F.TINY_JPEG, "base64"), "image/jpeg", { maxWidth: 100, maxHeight: 100, maxBytes: 1024 * 1024 })),
	tiny_default_limits: summarize(await resizeImage(Buffer.from(F.TINY_PNG, "base64"), "image/png")),
	garbage_png: summarize(await resizeImage(Buffer.from([1, 2]), "image/png")),
};

out.resizeImageInProcess = {
	dims_40x10_of_100x50ish: summarize(await resizeImageInProcess(Buffer.from(F.MEDIUM_PNG_100x100, "base64"), "image/png", { maxWidth: 40, maxHeight: 10, maxBytes: 1024 * 1024 })),
};

out.formatDimensionNote = {
	notResized: formatDimensionNote({ data: "", mimeType: "image/png", originalWidth: 100, originalHeight: 100, width: 100, height: 100, wasResized: false }),
	resized2000x1000: formatDimensionNote({ data: "", mimeType: "image/png", originalWidth: 2000, originalHeight: 1000, width: 1000, height: 500, wasResized: true }),
	resizedNonIntegralScale: formatDimensionNote({ data: "", mimeType: "image/jpeg", originalWidth: 100, originalHeight: 50, width: 20, height: 10, wasResized: true }),
	resized3x2to2x1: formatDimensionNote({ data: "", mimeType: "image/png", originalWidth: 3, originalHeight: 2, width: 2, height: 1, wasResized: true }),
};

out.processImage = {
	bmp_auto: summarize(await processImage(Buffer.from(F.BMP_1x1, "base64"), "image/bmp")),
	bmp_no_auto: summarize(await processImage(Buffer.from(F.BMP_1x1, "base64"), "image/bmp", { autoResizeImages: false })),
	png_no_auto: summarize(await processImage(Buffer.from(F.TINY_PNG, "base64"), "image/png", { autoResizeImages: false })),
	png_auto: summarize(await processImage(Buffer.from(F.TINY_PNG, "base64"), "image/png")),
	jpg_alias_no_auto: summarize(await processImage(Buffer.from(F.TINY_JPEG, "base64"), " image/JPG; charset=utf8", { autoResizeImages: false })),
	garbage_bmp: summarize(await processImage(Buffer.from([1, 2]), "image/bmp")),
	garbage_png_auto: summarize(await processImage(Buffer.from([1, 2]), "image/png")),
};

process.stdout.write(JSON.stringify(out, null, 1));
