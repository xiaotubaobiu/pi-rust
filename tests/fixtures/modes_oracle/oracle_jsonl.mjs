/**
 * Byte oracle for `modes/rpc/jsonl.ts` (verbatim copy): the four upstream
 * `rpc-jsonl.test.ts` scenarios. Prints one JSON line per case:
 * `{"name":..., "lines":[...]}` with the exact framed strings.
 */
import { Readable } from "node:stream";
import { attachJsonlLineReader, serializeJsonLine } from "./upstream/rpc/jsonl.ts";

async function collect(chunks) {
	const lines = [];
	const stream = Readable.from(chunks);
	const done = new Promise((resolve) => stream.on("end", resolve));
	attachJsonlLineReader(stream, (line) => lines.push(line));
	await done;
	return lines;
}

const results = [];

// 1. serializes strict JSONL records without escaping Unicode separators
const serialized = serializeJsonLine({ text: "a\u2028b\u2029c" });
results.push({ name: "serialize_unicode_separators", lines: [serialized] });

// 2. splits on LF only and preserves U+2028/U+2029 inside payloads
results.push({
	name: "split_lf_only",
	lines: await collect([serializeJsonLine({ text: "a\u2028b\u2029c" })]),
});

// 3. handles CRLF-delimited input
results.push({ name: "crlf_input", lines: await collect([Buffer.from('{"a":1}\r\n{"b":2}\r\n')]) });

// 4. emits a final line without trailing LF
results.push({ name: "final_line_no_lf", lines: await collect([Buffer.from('{"a":1}')]) });

// 5. multi-byte UTF-8 split across chunk boundaries (StringDecoder path)
const multibyte = Buffer.from('{"t":"héllo wörld"}\n{"t":" again"}\n');
const split = 4;
results.push({
	name: "utf8_chunk_split",
	lines: await collect([multibyte.subarray(0, split), multibyte.subarray(split)]),
});

// 6. empty final remainder emits nothing
results.push({ name: "empty_tail", lines: await collect([Buffer.from('{"a":1}\n')]) });

process.stdout.write(results.map((r) => JSON.stringify(r)).join("\n") + "\n");
