// Captures renderLatex outputs for the v0.99.1 latex.ts delta from the REAL
// upstream module: script layout nodes, font switches, and the cases rewrite.
// Sources are hash-verified against upstream HEAD by the Rust test.
import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { renderLatex } from "./latex.ts";

const display = { display: true };
const R = String.raw;
const cases = [
  // FONT_SWITCH_COMMANDS (upstream latex.test.ts delta).
  [R`\textnormal{hello}+\mbox{world}+\boldsymbol{x}+{\rm roman}+{\bf bold}+{\it italic}+{\sf sans}+{\tt mono}+{\cal calligraphic}+{\sl slanted}`, {}],
  [R`\mathrm{diag}(-1/2,1,1),\quad F_{\rm intrinsic}(\lambda)`, {}],
  // Scripts: unicode, layout nodes, nesting (upstream latex.test.ts delta).
  [R`\partial_tU_2(t,0)=Aj_*(1-t)^{-A-1}.\qquad x^{n^2}+x_{i_j}`, display],
  [R`e^{\frac{1}{2}}+\tfrac{1}{2}`, display],
  [R`F_1 = -\frac{1}{4x^2}.`, {}],
  [R`x^2_y`, {}], [R`x_y^2`, {}], [R`x^{a}_{b}`, {}], [R`x^{2^{3}}`, {}], [R`x_{i_{j}}`, display],
  [R`x^{abc}`, {}], [R`x_{abc}`, {}], [R`x^{A}`, {}], [R`x^{*}`, {}], [R`x^{\ast}`, {}], [R`x^{a/b}`, display],
  [R`x^{-A-1}`, display], [R`x^\ast`, {}], [R`x^*y`, {}], [R`v_{\mathrm{rel}}`, display],
  [R`x^ {2}`, {}], [R`x^2y^2`, {}], [R`a ^ b`, {}], ["x^=2", {}], ["x_{a = b}", {}],
  // Cases rewrite (upstream latex.test.ts delta).
  [R`f(x)=\begin{cases}a & x<0 \\ b & \text{if }x=0 \\ c & \text{otherwise}\end{cases}`, {}],
  [R`f(x) = \begin{cases} x^{2} & x \geq 0 \\ -x & x < 0 \end{cases}`, {}],
  [R`\begin{cases}x\\\end{cases}`, {}],
  [R`\begin{cases}x, & \text{if } y \\ z\end{cases}`, {}],
  [R`\begin{cases}\frac{1}{2} & even \\ x & odd\end{cases}`, display],
  [R`\begin{cases}`, {}],
  [R`\begin{cases}a\end{cases}`, {}],
  [R`\begin{cases}1 & a \\ 2 & b \\ 3 & c \\ 4 & d\end{cases}`, {}],
  [R`\Psi(x,t) = \sum_{n=1}^{\infty} c_n \sqrt{2/L} \sin\left(\frac{n\pi x}{L}\right)_{\text{(spatial eigenmode)}} \exp\left(-\frac{i\hbar n^2\pi^2}{2mL^2}t\right), \quad |\Psi(x,t)|^2 = \begin{cases}` + "\n" + R`\Psi^\ast\Psi, & 0<x<L,\\` + "\n" + R`0, & \text{otherwise}.` + "\n" + R`\end{cases}`, {}],
];

const out = { cases: [], provenance: {} };
for (const [source, options] of cases) {
  let rendered;
  try {
    rendered = renderLatex(source, options);
  } catch (error) {
    rendered = `!THROW:${error.message}`;
  }
  out.cases.push({ source, display: options.display === true, rendered });
}
const sha = (data) => createHash("sha256").update(data).digest("hex");
out.provenance = {
  latexSha256: sha(readFileSync(fileURLToPath(new URL("./latex.ts", import.meta.url)))),
  utilsSha256: sha(readFileSync(fileURLToPath(new URL("./utils.ts", import.meta.url)))),
  node: process.version,
  platform: process.platform,
};
const target = process.argv[2] ?? fileURLToPath(new URL("./latex_oracle.json", import.meta.url));
writeFileSync(target, JSON.stringify(out, null, 1) + "\n");
console.log("latex delta cases:", out.cases.length, sha(readFileSync(target)));
