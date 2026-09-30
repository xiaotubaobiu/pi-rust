// Oracle capture for the W3.1 utils slice (upstream coding-agent src/utils).
// Runs the actual upstream TypeScript sources under node's type stripping and
// dumps every deterministic output as JSON. The Rust port's tests pin these
// captured values byte-for-byte.
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

register("./loader.mjs", import.meta.url);

const UP = "C:/Users/13063/Desktop/code/agent work/pi/packages/coding-agent/src/utils";
const UPURL = (f) => pathToFileURL(`${UP}/${f}`).href;

const ansi = await import(UPURL("ansi.ts"));
const json = await import(UPURL("json.ts"));
const paths = await import(UPURL("paths.ts"));
const frontmatter = await import(UPURL("frontmatter.ts"));
const git = await import(UPURL("git.ts"));
const mime = await import(UPURL("mime.ts"));
const exif = await import(UPURL("exif-orientation.ts"));
const { default: chalk } = await import("chalk");
const { default: hostedGitInfo } = await import("hosted-git-info");

const out = {};

// ---------------------------------------------------------------- ansi ----
function referenceStripAnsi(value) {
  const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
  const osc = `(?:\\u001B\\][\\s\\S]*?${ST})`;
  const csi = "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";
  return value.replace(new RegExp(`${osc}|${csi}`, "g"), "");
}

function getCompatibilityInputs() {
  const inputs = [
    "plain",
    "a\x1b[31mred\x1b[0mz",
    "a\x1b]8;;https://example.com\x07link\x1b]8;;\x07z",
    "a\x1b]unterminated",
    "a\x1b]funterminated",
    "a\x1bPabc\x1b\\z",
    "a\x1b^abc\x07z",
    "a\x1b_abc\x9cz",
    "a\x90abc\x9cz",
    "a\x9dabc\x9cz",
    "a\x9b31mred",
    "a\x1b(0x",
    "a\x1b*0x",
    "a\x1b+c",
    "a\x1b/0x",
    "a\x1bcok",
    "a\x1b\\ok",
  ];
  const chars = [
    "a", "f", "0", "1", ";", ":", "[", "]", "(", ")", "#", "?", "m", "P", "_",
    "\\", "\x07", "\x1b", "\x9b", "\x9c", "\x90", "\x9d",
  ];
  for (const char of chars) {
    inputs.push(`x\x1b${char}y`);
    inputs.push(`x\x9b${char}y`);
    for (let index = 0; index < chars.length; index += 3) {
      inputs.push(`x\x1b${char}${chars[index]}y`);
    }
  }
  return inputs;
}

const ansiInputs = getCompatibilityInputs();
out.strip_ansi_compat = ansiInputs.map((input) => ({
  input,
  got: ansi.stripAnsi(input),
  reference: referenceStripAnsi(input),
}));
out.strip_ansi_extra = {
  tool_output: ansi.stripAnsi("a\x1b[31mred\x1b[0m\x1b]8;;https://example.com\x07link\x1b]8;;\x07z"),
  bom_and_color: ansi.stripAnsi("\uFEFF\x1b[2mJ\x1b[0m"),
};

// ---------------------------------------------------------------- json ----
const jsonInputs = [
  '{"a":1}', // plain
  '{\n  // comment\n  "a": 1, // trailing\n}',
  '{"a": "http://x", "b": "//not-a-comment"}',
  '{"a": [1, 2,],"b": {"c": 3,}}',
  '{"keep": "comma, inside", "url": "a://b,c"}',
  '[1,2 , ]',
  '{"re": "a\\\\", "s": "x"} // end',
  '{ "a" : 1 }',
  '{"brace": "}", "arr": "]"}',
  ',"\\"quoted\\"": 1}',
  '{"a": "x\\\r\ny"} // after raw-CR escape',
  '{"a": "x\\\\\u2028y"} // after raw-U+2028 escape',
  '[1 /* c */, 2]\t\n ,\t]',
];
out.strip_json_comments = jsonInputs.map((input) => ({ input, got: json.stripJsonComments(input) }));

// --------------------------------------------------------------- paths ----
const realPlatform = process.platform;
const setPlatform = (p) => Object.defineProperty(process, "platform", { value: p, configurable: true });

const HOME = "C:\\Users\\oracle";
const shellPaths = [
  "/c/Users/example/project", "/cygdrive/d/work", "/mnt/e/source", "/c", "/C",
  "C:/Users/example", "C:\\Users\\example", "//server/share/file", "/c/Users\\example",
  "relative/file", "/tmp/file", "/", "//", "", "/x", "/mnt/", "/cygdrive/",
];
out.normalize_windows_shell_path = shellPaths.map((p) => ({ input: p, got: paths.normalizeWindowsShellPath(p) }));

const normalizeCases = [
  { input: "  spaced  ", options: { trim: true } },
  { input: "\u00A0x\u2000-\u200A?", options: { normalizeUnicodeSpaces: true } },
  { input: "@file.txt", options: { stripAtPrefix: true } },
  { input: "@file.txt", options: {} },
  { input: "~", options: { homeDir: HOME } },
  { input: "~/file.txt", options: { homeDir: HOME } },
  { input: "~\\file.txt", options: { homeDir: HOME } },
  { input: "~", options: { homeDir: HOME, expandTilde: false } },
  { input: "~draft.md", options: { homeDir: HOME } },
  { input: "file:///C:/dir/file.txt", options: {} },
  { input: "file:///C:/dir/file%20with%20spaces.txt", options: {} },
  { input: "file:///dir/file.txt", options: {} },
  { input: "file:///C:/bad/%E0%A4%A", options: {} },
  { input: "/c/Users/example", options: { homeDir: HOME } },
  { input: "~/proj", options: { homeDir: "C:\\home\\me" } },
];
out.normalize_path = { platform: realPlatform };
out.normalize_path.win32 = normalizeCases.map((c) => {
  setPlatform("win32");
  try { return { ...c, got: paths.normalizePath(c.input, c.options) }; }
  catch (e) { return { ...c, error: `${e.name}: ${e.message}` }; }
  finally { setPlatform(realPlatform); }
});
out.normalize_path.posix = normalizeCases.map((c) => {
  setPlatform("linux");
  try { return { ...c, got: paths.normalizePath(c.input, c.options) }; }
  catch (e) { return { ...c, error: `${e.name}: ${e.message}` }; }
  finally { setPlatform(realPlatform); }
});

const localCases = ["my-package", "./foo", "file:///tmp/foo", "npm:package", "git://repo",
  "https://example.com", "http://example.com", "ssh://git@host/repo", "github:user/repo",
  "  npm:package  ", "NPM:package", ""];
out.is_local_path = localCases.map((v) => ({ input: v, got: paths.isLocalPath(v) }));

// resolvePath: run on the real (win32) platform.
const resolveCases = [
  ["subdir/file.txt", "C:\\base"],
  ["C:/Users/example", "D:\\work"],
  ["C:\\Users\\example", "D:\\work"],
  ["\\foo\\bar", "C:\\work"],
  ["\\foo\\bar", "D:\\work"],
  ["/mnt/c/Users/example", "D:\\work"],
  ["/c/Users/example", "D:\\work"],
  ["file:///C:/dir/file.txt", "D:\\work"],
  ["file:///dir/file.txt", "D:\\work"],
  ["~/file.txt", "D:\\work"],
  ["~other/file", "D:\\work"],
  ["a/../b/./c.txt", "C:\\base"],
  ["", "C:\\base"],
  ["file:///%E0%A4%A", "C:\\base"],
  ["/C:/Users/13063/dir/SKILL.md", "E:\\project"],
  ["with space/x.txt", "C:\\my dir"],
  ["C:", "D:\\work"],
  ["..\\up.txt", "C:\\base\\sub"],
];
out.resolve_path = resolveCases.map(([input, base]) => {
  try { return { input, base, got: paths.resolvePath(input, base) }; }
  catch (e) { return { input, base, error: `${e.name}: ${e.message}` }; }
});

const relativeCases = [
  ["C:\\base\\sub\\file.txt", "C:\\base"],
  ["C:\\other\\file.txt", "C:\\base"],
  ["C:\\base", "C:\\base"],
  ["C:\\base\\..config\\AGENTS.md", "C:\\base"],
  ["C:\\base\\..\\AGENTS.md", "C:\\base"],
  ["D:\\x", "C:\\base"],
  ["C:\\base\\a\\b.txt", "c:\\base"],
];
out.cwd_relative_path = relativeCases.map(([fp, cwd]) => {
  try { return { fp, cwd, got: paths.getCwdRelativePath(fp, cwd) }; }
  catch (e) { return { fp, cwd, error: `${e.name}: ${e.message}` }; }
});
out.format_relative = relativeCases.map(([fp, cwd]) => {
  try { return { fp, cwd, got: paths.formatPathRelativeToCwdOrAbsolute(fp, cwd) }; }
  catch (e) { return { fp, cwd, error: `${e.name}: ${e.message}` }; }
});

// node path module grid — pins the node_path port for both flavors.
const pathMod = (await import("node:path")).default;
const RESOLVE_GRID = [
  ["C:\\base"], ["C:/base/sub", "file.txt"], ["\\foo\\bar"], ["/mnt/c/x"],
  ["C:\\"], ["C:\\a\\..\\b"], ["/a/../b"], ["C:\\x\\", ".."],
  ["//server/share", "x"], ["\\\\server\\share", "x"], ["C:x"], ["C:.", "y"],
  ["C:", "x"], ["C:x", ".."], ["c:\\A", "B"], ["C:\\a", "b", "c"],
  ["a", "C:\\b"], ["", "C:\\b"], ["C:\\a\\b", "..\\c"], ["\\a", "b"],
  ["/", "x"], ["C:\\a\\", "\\"], ["\\\\?\\C:\\x"], ["\\\\?\\UNC\\server\\share"],
  ["C:\\a\\b\\..\\..\\c"], ["d1/d2"], ["\\\\"], ["\\\\s"], ["\\\\s\\"],
  ["C:\\"], ["Z:\\x\\y\\..\\z"], ["x:", "y"], ["1:\\x"], ["C:\\a b", "c d"],
  ["/c/Users/example"], ["/cygdrive/d"], ["C:\\.\\a\\./b"], ["..", "C:\\a"],
  ["C:\\", "..\\"], ["C:\\a\\b\\c", "d", "..", "e"], ["C:.a"], ["C:\\a\\:", "b"],
  ["/a/b//", "c"], ["nul", "x"], ["C:\\a\\b", "/c/d"], ["\\\\..\\..\\c"],
];
const RELATIVE_GRID = [
  ["C:\\a\\b", "C:\\a\\c"], ["C:\\a\\b", "c:\\a\\c"], ["C:\\a", "D:\\b"],
  ["\\a\\b", "\\a"], ["C:\\a\\b\\c", "C:\\a"], ["C:", "C:\\"], ["C:\\", "C:\\"],
  ["C:\\a\\", "C:\\a"], ["\\\\s\\s\\a", "\\\\s\\s\\b"], ["C:\\a\\..\\b", "C:\\a\\c"],
  ["/a/b", "/a/c"], ["a/b", "a/c"], ["../a", "../a/b"], ["C:\\x", "c:\\x\\y\\..\\z"],
  ["", "C:\\a"], ["C:\\a", "C:\\a"], ["C:\\a\\b", "C:\\"], ["/", "/a"],
  ["a", "a"], ["C:\\a\\b\\c\\d", "C:\\b"],
];
const JOIN_GRID = [
  ["C:"], ["C:\\", "x"], ["", "x"], ["..", "x"], ["C:\\x\\", ".."],
  ["\\\\s\\s", "x"], ["C:x", ".."], ["a\\b", "..\\c"], ["/a//b///"],
  ["C:\\a\\\\b\\..\\c\\"], [".", "a"], ["a", ".", "..", "b"], ["C:\\", "C:\\"],
];
const NORM_GRID = [
  ["C:\\"], ["C:\\x\\"], ["\\\\s\\s\\x"], ["C:x"], ["/a//b///"], ["a\\b\\..\\c"],
  [".", ], ["a\\."], [".."], ["..\\..\\a"], ["/.."], ["a/../../b"], ["C:\\a\\b\\..\\..\\c"],
];
out.node_path = {
  win32: {
    resolve: RESOLVE_GRID.map((args) => pathMod.win32.resolve(...args)),
    isAbsolute: RESOLVE_GRID.map((args) => pathMod.win32.isAbsolute(args[0])),
    relative: RELATIVE_GRID.map(([from, to]) => pathMod.win32.relative(from, to)),
    join: JOIN_GRID.map((args) => pathMod.win32.join(...args)),
    normalize: NORM_GRID.map((p) => pathMod.win32.normalize(p[0])),
  },
  posix: {
    resolve: RESOLVE_GRID.map((args) => pathMod.posix.resolve(...args)),
    isAbsolute: RESOLVE_GRID.map((args) => pathMod.posix.isAbsolute(args[0])),
    relative: RELATIVE_GRID.map(([from, to]) => pathMod.posix.relative(from, to)),
    join: JOIN_GRID.map((args) => pathMod.posix.join(...args)),
    normalize: NORM_GRID.map((p) => pathMod.posix.normalize(p[0])),
  },
};

// ---------------------------------------------------------- frontmatter ----
const fmInputs = [
  "---\nname: \"skill-name\"\ndescription: 'A desc'\nfoo-bar: value\n---\n\nBody text",
  "---\r\nname: test\r\n---\r\nLine one\r\nLine two",
  "---\nfoo: [bar\n---\nBody",
  "---\ndescription: |\n  Line one\n  Line two\n---\n\nBody",
  "Just text\nsecond line",
  "---\nname: test\nBody without terminator",
  "---\n# just a comment\n---\nBody",
  "---\nkey: value\n---\n\nBody\n",
  "\n  No frontmatter body  \n",
  "---\nnum: 42\nflag: true\nnothing: null\nlist: [1, 2]\n---\nBody",
  "---\nempty:\n---\nBody",
  "\uFEFF---\nname: bom\n---\nBom body",
  "---\nname: bomstrip\n---\nBody",
  "---",
  "---\n---",
  "---\nkey: 'quoted # not comment'\n---\n",
];
out.frontmatter = fmInputs.map((input) => {
  try {
    const r = frontmatter.parseFrontmatter(input);
    return { input, frontmatter: r.frontmatter, body: r.body };
  } catch (e) {
    return { input, error: `${e.name}: ${e.message}` };
  }
});
out.strip_frontmatter = fmInputs.map((input) => {
  try { return { input, got: frontmatter.stripFrontmatter(input) }; }
  catch (e) { return { input, error: `${e.name}: ${e.message}` }; }
});

// ------------------------------------------------------------------ git ----
const gitSources = [
  "https://github.com/user/repo",
  "ssh://git@github.com/user/repo",
  "https://github.com/user/repo@v1.0.0",
  "git:git@github.com:user/repo",
  "git:github.com/user/repo",
  "git:git@github.com:user/repo@v1.0.0",
  "git:git@evil.example:../../victim/repo",
  "https://evil.example/..%2F..%2Fvictim/repo",
  "https://evil.example/..%2F..%2Fvictim/repo%",
  "git:git@evil.example:/absolute/repo",
  "git:git@evil.example:user\\repo/name",
  "git:git@evil.example:user/repo\0name",
  "git@github.com:user/repo",
  "github.com/user/repo",
  "user/repo",
  "git:user/repo",
  "git:user/repo.git",
  "https://github.com/user/repo.git",
  "https://gitlab.com/group/sub/repo",
  "git:gitlab.com/group/sub/repo",
  "https://bitbucket.org/user/repo",
  "git:github.com/user/repo#main",
  "https://github.com/user/repo/tree",
  "https://github.com/user/repo/tree/main",
  "git:github.com/user/repo#",
  "  https://github.com/user/repo  ",
  "git:  github.com/user/repo  ",
  "git:github.com:user/repo",
  "https://GitHub.com/User/Repo",
  "git:git@gitlab.com:group/repo@v2",
  "git:GitHub.com:user/repo",
  "git:git@github.com:user/repo#semver:^1.0.0",
  "https://github.com/user/repo#feat/test",
  "git:github.com/user/repo.GIT",
  "https://github.com/user/repo/?q=1",
  "git:https://github.com/user/repo",
];
out.parse_git_url = gitSources.map((source) => ({ source, got: git.parseGitUrl(source) }));
out.hosted_from_url = [
  "github:user/repo", "github:user/repo#v1", "https://github.com/user/repo",
  "git@github.com:user/repo.git", "www.github.com/user/repo", "https://www.github.com/u/p",
].map((u) => {
  const info = hostedGitInfo.fromUrl(u);
  return { u, info: info ? { domain: info.domain, user: info.user, project: info.project, committish: info.committish } : null };
});

// ----------------------------------------------------------------- mime ----
const buf = (arr) => Uint8Array.from(arr);
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ihdr = (len = 13) => [...u32be(len), ..."IHDR".split("").map(c => c.charCodeAt(0))];
const u32be = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u32le = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const pngPlain = buf([...PNG_SIG, ...ihdr(13), ...new Array(13).fill(0), ...u32be(0), ..."IDAT".split("").map(c => c.charCodeAt(0)), 1, 2, 3, 4, ...u32be(0)]);
// acTL chunk with correct CRC slot: sig | len=13 | IHDR | 13B data | crc | len=8 | acTL | 4B data | crc
const pngActl = buf([
  ...PNG_SIG, ...ihdr(13), ...new Array(13).fill(0), ...u32be(0),
  ...u32be(8), ..."acTL".split("").map(c => c.charCodeAt(0)), 1, 0, 0, 0, ...u32be(0),
]);
const pngNoIhdr = buf([...PNG_SIG, ...u32be(13), ..."IDAT".split("").map(c => c.charCodeAt(0)), ...new Array(13).fill(0)]);
const jpeg = buf([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70]);
const jpegSpiff = buf([0xff, 0xd8, 0xff, 0xf7, 0, 5]);
const gif87 = buf([..."GIF87a"].map(c => c.charCodeAt(0)));
const gif89 = buf([..."GIF89a"].map(c => c.charCodeAt(0)));
const webp = buf([...[..."RIFF"].map(c => c.charCodeAt(0)), ...u32le(20), ...[..."WEBP"].map(c => c.charCodeAt(0))]);
const bmp1x1 = (() => {
  const b = new Array(58).fill(0);
  "BM".split("").forEach((c, i) => b[i] = c.charCodeAt(0));
  // declared size 58, pixel data offset 54, dib header 40, planes 1, bpp 24
  b.splice(2, 4, ...u32le(58));
  b.splice(10, 4, ...u32le(54));
  b.splice(14, 4, ...u32le(40));
  b.splice(18, 4, ...u32le(1));
  b.splice(22, 4, ...u32le(1));
  b.splice(26, 2, ...u32le(1));
  b.splice(28, 2, ...u32le(24));
  b[56] = 0xff;
  return buf(b);
})();
const bmp12hdr = (() => {
  const b = new Array(26).fill(0);
  "BM".split("").forEach((c, i) => b[i] = c.charCodeAt(0));
  b.splice(2, 4, ...u32le(26));
  b.splice(10, 4, ...u32le(14 + 12));
  b.splice(14, 4, ...u32le(12));
  b.splice(22, 2, ...u32le(1));
  b.splice(24, 2, ...u32le(8));
  return buf(b);
})();
const bmpBadPlanes = (() => { const b = Array.from(bmp1x1); b.splice(26, 2, ...u32le(2)); return buf(b); })();
const bmpBadBpp = (() => { const b = Array.from(bmp1x1); b.splice(28, 2, ...u32le(3)); return buf(b); })();
const bmpBadOffset = (() => { const b = Array.from(bmp1x1); b.splice(10, 4, ...u32le(20)); return buf(b); })();
const bmpBadSize = (() => { const b = Array.from(bmp1x1); b.splice(2, 4, ...u32le(10)); return buf(b); })();
const bmpShort = bmp1x1.subarray(0, 25);
out.detect_mime = [
  ["jpeg", jpeg], ["jpeg_spiff", jpegSpiff], ["png", pngPlain], ["png_actl", pngActl],
  ["png_no_ihdr", pngNoIhdr], ["gif87", gif87], ["gif89", gif89], ["webp", webp],
  ["bmp", bmp1x1], ["bmp12", bmp12hdr], ["bmp_bad_planes", bmpBadPlanes],
  ["bmp_bad_bpp", bmpBadBpp], ["bmp_bad_offset", bmpBadOffset], ["bmp_bad_size", bmpBadSize],
  ["bmp_short", bmpShort], ["empty", buf([])], ["short_ffd8", buf([0xff, 0xd8])],
  ["text", buf([..."hello"].map(c => c.charCodeAt(0)))],
].map(([name, b]) => ({ name, got: mime.detectSupportedImageMimeType(b) }));

// ----------------------------------------------------------------- exif ----
function tiffExif(orientation, littleEndian) {
  const bo = littleEndian ? [0x49, 0x49] : [0x4d, 0x4d];
  const w16 = (n) => littleEndian ? [n & 0xff, (n >> 8) & 0xff] : [(n >> 8) & 0xff, n & 0xff];
  const w32 = (n) => littleEndian ? u32le(n) : u32be(n);
  const entries = [
    ...w16(1), // entry count
    ...w16(0x0112), ...w16(3), ...w32(1), ...w16(orientation), ...w16(0),
  ];
  // header: byte order + 0x002a + ifd offset 8
  const header = [...bo, ...w16(0x2a), ...w32(8)];
  return [...header, ...entries];
}
function jpegWithExif(orientation, littleEndian = true) {
  const payload = [..."Exif\0\0"].map(c => c.charCodeAt(0)).concat(tiffExif(orientation, littleEndian));
  const segLen = payload.length + 2;
  return [0xff, 0xd8, 0xff, 0xe1, (segLen >> 8) & 0xff, segLen & 0xff, ...payload, 0xff, 0xd9];
}
function webpWithExif(orientation, littleEndian = true) {
  const exifPayload = [..."Exif\0\0"].map(c => c.charCodeAt(0)).concat(tiffExif(orientation, littleEndian));
  const chunks = [];
  chunks.push(..."VP8X".split("").map(c => c.charCodeAt(0)), ...u32le(4), 0, 0, 0, 0, 0, 0);
  chunks.push(..."EXIF".split("").map(c => c.charCodeAt(0)), ...u32le(exifPayload.length), ...exifPayload);
  if (chunks.length % 2) chunks.push(0);
  const riffSize = 4 + chunks.length;
  return [..."RIFF"].map(c => c.charCodeAt(0)).concat([...u32le(riffSize), ..."WEBP".split("").map(c => c.charCodeAt(0)), ...chunks]);
}
const exifCases = [];
for (let o = 1; o <= 8; o++) {
  exifCases.push({ name: `jpeg_le_${o}`, bytes: jpegWithExif(o, true) });
  exifCases.push({ name: `jpeg_be_${o}`, bytes: jpegWithExif(o, false) });
  exifCases.push({ name: `webp_le_${o}`, bytes: webpWithExif(o, true) });
}
exifCases.push({ name: "plain_jpeg", bytes: [0xff, 0xd8, 0xff, 0xe0] });
// getExifOrientation is not exported upstream; pin it through
// applyExifOrientation's observable transform instead (see exif_transforms).

// applyExifOrientation with a mock photon: pins the pixel transforms.
function makeMockPhoton() {
  return {
    fliph(img) {
      const { width: w, height: h, pixels } = img;
      const dst = new Uint8Array(pixels.length);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const s = (y * w + x) * 4, d = (y * w + (w - 1 - x)) * 4;
        dst[d] = pixels[s]; dst[d + 1] = pixels[s + 1]; dst[d + 2] = pixels[s + 2]; dst[d + 3] = pixels[s + 3];
      }
      img.pixels = dst;
    },
    flipv(img) {
      const { width: w, height: h, pixels } = img;
      const dst = new Uint8Array(pixels.length);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const s = (y * w + x) * 4, d = ((h - 1 - y) * w + x) * 4;
        dst[d] = pixels[s]; dst[d + 1] = pixels[s + 1]; dst[d + 2] = pixels[s + 2]; dst[d + 3] = pixels[s + 3];
      }
      img.pixels = dst;
    },
  };
}
class MockImage {
  constructor(width, height, pixels) {
    this.width = width; this.height = height; this.pixels = Uint8Array.from(pixels);
  }
  get_width() { return this.width; }
  get_height() { return this.height; }
  get_raw_pixels() { return this.pixels; }
}
// The upstream module constructs `new photon.PhotonImage(dst, h, w)`; mirror
// the mock's pixel storage contract (raw RGBA, width/height swapped for 90°).
class CtorImage {
  constructor(pixels, height, width) {
    this.pixels = pixels; this.width = width; this.height = height;
  }
  get_width() { return this.width; }
  get_height() { return this.height; }
  get_raw_pixels() { return this.pixels; }
}
const mockPhotonWithCtor = { ...makeMockPhoton(), PhotonImage: CtorImage };
const W = 3, H = 2;
const basePixels = Array.from({ length: W * H * 4 }, (_, i) => (i * 37 + 11) % 256);
const exifTransforms = [];
for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8, 0, 9]) {
  const bytes = orientation >= 2 && orientation <= 8
    ? Uint8Array.from(jpegWithExif(orientation))
    : Uint8Array.from([0, 0]); // orientation 1 path
  const img = new MockImage(W, H, basePixels);
  const result = exif.applyExifOrientation(mockPhotonWithCtor, img, bytes);
  exifTransforms.push({
    orientation,
    out_width: result.get_width(),
    out_height: result.get_height(),
    pixels: Array.from(result.pixels),
  });
}
out.exif_transforms = exifTransforms;

// ----------------------------------------------------------- deprecation ----
out.chalk_yellow = {};
for (const level of [0, 1, 2, 3]) {
  chalk.level = level;
  out.chalk_yellow[level] = chalk.yellow("Deprecation warning: x");
}

// The relative() grids: capture a second pass from a deeper cwd so gen_data
// can tell depth-dependent ".."-chain results apart from pinned ones.
import fs from "node:fs";
const deepCwd = path.join(import.meta.dirname, "deep_cwd");
fs.mkdirSync(deepCwd, { recursive: true });
process.chdir(deepCwd);
out.node_path_relative_deep = {
  win32: RELATIVE_GRID.map(([from, to]) => pathMod.win32.relative(from, to)),
  posix: RELATIVE_GRID.map(([from, to]) => pathMod.posix.relative(from, to)),
};
process.chdir(import.meta.dirname);
fs.rmSync(deepCwd, { recursive: true, force: true });

fs.writeFileSync(path.join(import.meta.dirname, "oracle_output.json"), JSON.stringify(out, null, 1));
fs.writeFileSync(path.join(import.meta.dirname, "grid_args.json"), JSON.stringify({ resolve: RESOLVE_GRID, relative: RELATIVE_GRID, join: JOIN_GRID, normalize: NORM_GRID }, null, 1));
console.log("captured sections:", Object.keys(out).join(", "));
