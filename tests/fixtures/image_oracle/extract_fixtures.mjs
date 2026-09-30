// Extract base64 fixtures verbatim from the upstream test sources so the
// oracle uses byte-exact inputs. Writes fixtures.json next to this script.
import { readFileSync, writeFileSync } from "node:fs";

const testDir = "C:/Users/13063/Desktop/code/agent work/pi/packages/coding-agent/test";
const processing = readFileSync(`${testDir}/image-processing.test.ts`, "utf8");

function extract(name, source) {
	const re = new RegExp(`const ${name} =\\s*"(\\S+)"`);
	const match = source.match(re);
	if (!match) throw new Error(`fixture ${name} not found`);
	return match[1];
}

const fixtures = {
	TINY_PNG: extract("TINY_PNG", processing),
	TINY_JPEG: extract("TINY_JPEG", processing),
	TINY_JPEG_2X1: extract("TINY_JPEG_2X1", processing),
	MEDIUM_PNG_100x100: extract("MEDIUM_PNG_100x100", processing),
	LARGE_PNG_200x200: extract("LARGE_PNG_200x200", processing),
};

// 1x1 red 24bpp BMP, built exactly as upstream image-process.test.ts does.
const buffer = Buffer.alloc(58);
buffer.write("BM", 0, "ascii");
buffer.writeUInt32LE(buffer.length, 2);
buffer.writeUInt32LE(54, 10);
buffer.writeUInt32LE(40, 14);
buffer.writeInt32LE(1, 18);
buffer.writeInt32LE(1, 22);
buffer.writeUInt16LE(1, 26);
buffer.writeUInt16LE(24, 28);
buffer.writeUInt32LE(0, 30);
buffer.writeUInt32LE(4, 34);
buffer[56] = 0xff;
fixtures.BMP_1x1 = buffer.toString("base64");

// JPEG 2x1 with an XMP APP1 segment before the EXIF APP1 (orientation 6),
// as built by upstream jpegWithXmpBeforeOrientation().
function app1(payload) {
	const segment = Buffer.alloc(payload.length + 4);
	segment[0] = 0xff;
	segment[1] = 0xe1;
	segment.writeUInt16BE(payload.length + 2, 2);
	payload.copy(segment, 4);
	return segment;
}
const jpeg = Buffer.from(fixtures.TINY_JPEG_2X1, "base64");
const xmp = app1(Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"/>'));
const orientation6 = app1(
	Buffer.concat([
		Buffer.from("Exif\0\0"),
		Buffer.from("49492a0008000000010012010300010000000600000000000000", "hex"),
	]),
);
fixtures.JPEG_2X1_XMP_THEN_EXIF6 = Buffer.concat([jpeg.subarray(0, 2), xmp, orientation6, jpeg.subarray(2)]).toString("base64");

writeFileSync(new URL("./fixtures.json", import.meta.url), JSON.stringify(fixtures, null, 1));
console.log("fixtures written:", Object.keys(fixtures).join(", "));
