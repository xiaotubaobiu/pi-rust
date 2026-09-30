# HANDOFF — pi → pi-rust 迁移交接文档（2026-09-24 重写版，自包含）

> 本文档是**唯一权威交接入口**，为"换任何执行者/工具接手"而写，自包含。
> 旧版交接内容已归档至 `docs/migration/HANDOFF-archived-2026-09-24.md`
> （其中 NEXT_SESSION_PROMPT.md / NEXT_SLICE_PLAN.md 所述的 Lane 12 项验收
> 已由并行执行者完成并通过，详见 WORK_LOG 2026-09-24 条目，无需重读旧计划）。
> 读完本文 + `docs/migration/MIGRATION_STATUS.md` 即可安全接手，无需读旧会话。

---

## 0. 一句话现状

M4（TUI 包）已完成约 90%：utils/keys/screen/renderer 等基础层与 11 个组件全部带差分测试通过四道门禁（最近一次全绿账面：**2342 tests = 2306 lib + 27 generate-models + 9 pirs，0 failed，2 ignored**，日志 `docs/migration/validation/2026-09-24-layoutwidgets-gates.log`）。
当前有一个**进行中未收尾的切片：markdown 组件**（lexer + 渲染器 + 82 例差分 fixtures 已写完；逐 fixture 修复到 11/12 测试通过，最后一个失败的修复补丁已落盘但**验证运行被中断、未确认**）。
接手者第一件事 = 按 §4 队列把 markdown 切片收尾，然后按 §6 路线图继续。

## 1. 环境与硬性约束（不可违反）

| 项 | 值 |
|---|---|
| 上游只读参考 | `C:\Users\13063\Desktop\code\agent work\pi`（HEAD `590144609`，仅原有未跟踪 `.zcodeignore`，**禁止任何写入/checkout**） |
| pisper | `../pisper` 不在范围内，未检查未修改，保持不动 |
| 工作仓库 | `C:\Users\13063\Desktop\code\agent work\pi-rust`（HEAD `f8d69f7`，**55 个脏路径，全部保留；禁止 commit/stage/push/reset/stash/clean**） |
| Node（差分 oracle 用） | `C:/Users/13063/anaconda3/node.exe`（v25.8.2；跑上游 TS 用 `--experimental-strip-types`） |
| Python（脚本/修补用） | `/c/Users/13063/anaconda3/python.exe`（**PATH 上的 `python` 是坏的 WindowsApps 桩**，exit 49 静默失败，绝不使用） |
| Rust | 离线编译（所有 cargo 命令加 `--offline`）；**禁用 unsafe**；无真实凭据/付费调用；测试全部离线 mock |
| 并行执行者协调 | 只认领不相交切片；若必须救援他人 WIP，先按字节备份到 `../.migration-handoff/` 并在 WORK_LOG 记 SHA-256 |

### 工具坑（前人踩过，别再踩）
- **heredoc / 工具调用会吞 `\\t`、`\\n` 等反斜杠转义**：往 Rust 源码写含转义序列的补丁后，必须 grep 验证落盘结果（本切片已发生 4+ 次，见 §3.4）。稳妥做法：anaconda python 按行号 + `chr(9)`/`chr(10)`/`chr(92)` 构造替换串，或写补丁脚本文件再执行。
- cargo 测试偶尔因残留测试进程锁住 exe 而 LNK1104：`taskkill //F //IM pi_rust-<hash>.exe` 后重跑。
- 离线 crate 缓存里有 `regex 1.13.1` 但**没有支持 lookaround/backref 的 crate（无 fancy-regex）**，所以 marked 规则全部手写扫描器实现，不要试图改用 regex crate。
- `serde_json`、`icu_properties`（compiled_data）、`unicode-segmentation` 已在依赖里，可直接用。

## 2. 已完成且账面可信的部分（不要重做）

- **四本账本**（每切片后必须更新；接手者后续也要维护）：
  - `docs/migration/WORK_LOG.md` — 按时间的详细日志（含救援备份 SHA、每片门禁数字）
  - `docs/migration/MIGRATION_STATUS.md` — 阶段状态表 + Latest whole-project verification
  - `docs/migration/TUI_COMPATIBILITY.md` — 逐文件移植映射表 + 已披露偏差
  - `docs/migration/validation/*.log` — 每次门禁完整输出存档
- **门禁四件套**（每片收尾必跑，完整输出 tee 到 `docs/migration/validation/<date>-<slice>-gates.log`）：
  1. `cargo fmt --all -- --check`
  2. `cargo clippy --offline --all-targets -- -D warnings`
  3. `cargo test --offline --all-targets`
  4. `cargo test --offline --doc`
- **M4 已收尾切片**：utils（含 EAW/SpacingMark/RGI 生成表 + 128,360 例差分扫描；表生成器 `docs/migration/reference/generate-tui-width-tables.mjs`）、terminal_colors、keys（Kitty CSI-u/alternate keys/event types 全量）、stdin_buffer、terminal、screen（输入分发/focus/listener 链）、renderer + alt_screen（差分帧规划器）、component/overlay 合成核心、editor（paste-marker/kill-ring/history/autocomplete 集成，70 测试）、input、select_list、settings_list、scroll_view、autocomplete（CombinedAutocompleteProvider）、layout_widgets（box/spacer/truncated-text）、fuzzy/keybindings/undo_stack/word_navigation。
- **runtime Lane**（并行执行者的切片）12/12 验收通过（WORK_LOG 2026-09-24）。
- 参考依赖解包（npm 缓存，离线）：`../.migration-handoff/reference-deps/` 下有 marked-18.0.5（含 **src-ref/ = 从 sourcemap 提取的 marked 原始 TS 源码**，lex/规则对照权威）、chalk-5.6.2、get-east-asian-width-1.6.0、diff-8.0.4 等。

## 3. 进行中：markdown 切片的精确状态

### 3.1 差分 oracle（已完成，可用）

- 上游 pin `marked@18.0.11` **不在离线 npm 缓存**；已批准用缓存中最接近的 **18.0.5** 并在账本披露偏差。
- 差分 harness：`../.migration-harness-markdown/`
  - 布局：`src/components/markdown.ts` + `src/{latex,terminal-image,utils}.ts`（pi 原件拷贝，保持相对导入可用）+ `node_modules/{marked=18.0.5, chalk=5.6.2, get-east-asian-width=1.6.0}`（缓存解包，离线可跑）
  - 生成器 `gen.mjs`：82 个用例（标题/段落/围栏/列表全套/引用块/hr/html/链接与能力开关/表格全套/latex 全套/转义/内边距与背景/空输入/图片行/长 token/CJK）+ 4 条从 markdown.test.ts 抄录的字面断言 + themeProbe（chalk 各函数实测序列）
  - 运行：`cd ../.migration-harness-markdown && C:/Users/13063/anaconda3/node.exe --experimental-strip-types gen.mjs` → 产出 `fixtures.json`；**改语料后要拷贝为 `pi-rust/src/tui/markdown_fixtures.json`**（Rust 侧 `include_str!`）。
  - 4 条字面断言在 18.0.5 下全部通过 → 版本偏差对已测表面无实测影响（披露证据）。
- 实测确认的 chalk 5.6.2 行为（测试内 `Chalk` 仿真器已实现，勿动）：reopen = 串内的 close 序列替换为 **close+open**（不是仅 open）；换行处 closeAll/openAll 包裹（CRLF 感知）；嵌套链 openAll=父先子后、closeAll=逆序。

### 3.2 已落盘的新文件（编译曾通过；最终态未验证）

| 文件 | 内容 |
|---|---|
| `src/tui/markdown_lexer.rs`（~4200 行） | marked 18.0.5 gfm block+inline 词法器手写移植：`Token` 模型、`LexerExtensions` trait（latex block/inline tokenizer + 严格删除线 del 钩子）、全部规则扫描器、`Lexer::lex`（block 两阶段 + 按 DFS pre-order 回填 inline，等价 marked 的 inlineQueue 顺序；路径用 `Cont{Tokens,Items,Header,Row}` 标注容器） |
| `src/tui/components/markdown.rs`（~1100 行） | `Markdown` 组件：`MarkdownTheme`（`StyleFn = Arc<dyn Fn>`）、`DefaultTextStyle`、`MarkdownOptions`、renderToken/renderInlineTokens/renderList/renderTable 全移植、wrap+padding+background 三段输出、渲染缓存、`trim_partial_closing_fences`、latex tokenizers + `strict_strikethrough_del` |
| `src/tui/terminal_image.rs` | `getCapabilities/setCapabilities/hyperlink/isImageLine` 子集（markdown 依赖；env 探测降级为保守默认，模块 doc 已披露；测试用 `set_capabilities` 强制开/关） |
| `src/tui/latex.rs` | **占位 stub**：`render_latex` 恒返回 `None`（对应上游"不支持→回退原文"路径）；latex.ts 完整移植是下一片（1394 行：3-600 行符号表建议生成、641-1394 行 renderLayout 引擎手工移植） |
| `src/tui/tests/markdown.rs` | chalk 仿真器 + 82 fixtures 逐字节断言（`PENDING_LATEX` 白名单跳 7 例）+ 8 个 markdown.test.ts 行为测试（transform 缓存计数、任务列表、OSC8 开关、标题间距、转义两种模式、流式围栏截断、pending latex、窄表格、空输入、chalk 序列探针） |
| `src/tui/tests/markdown_debug.rs` | **临时调试模块**（打印 token 树）——收尾时必须删除，并去掉 `src/tui/tests.rs` 里的 `mod markdown_debug;` |
| `src/tui/markdown_fixtures.json` | 82 例期望输出（harness 拷贝） |

模块注册已完成：`src/tui/mod.rs`（latex / markdown_lexer / terminal_image）、`src/tui/components/mod.rs`（markdown）、`src/tui/tests.rs`（markdown、markdown_debug⚠️）。
`src/tui/utils.rs` 新增 `is_js_space_unicode / is_punct_or_symbol_unicode / is_letter_or_number_unicode`（icu GeneralCategory，服务 JS `\s` / `\p{P}\p{S}` / `\p{L}\p{N}`）。

### 3.3 修复史（最后一次完整验证 = 11 passed / 1 failed）

按时间序，每条都已由一次完整测试运行确认"由错转对"（fixture 名为证）：

1. chalk 仿真器 reopen 语义改为 close→close+open（`heading1_paragraph` 转对；用 harness chalk 实测钉死）。
2. `rx_fences` 闭合扫描 off-by-one：body 的换行被消费后闭合围栏从 `p+1` 起（`code_fence_lang` 转对）。
3. 列表嵌套：marked `cachedIndentRegex` 实际用 **indent-1**（cacheIndex）构建六个 begin-regex → `tokenize_list` 里 `begin_indent = indent.saturating_sub(1)`（`list_nested` 转对）。
4. blockquote：marked 规则里嵌入 `paragraph` 分支带 `^` 锚，消费 `> ` 后永不匹配 → 行匹配退化为单行 `[^\n]*`（`blockquote_paragraph_after` 转对；`rx_blockquote_end` 已改）。
5. **link href 回溯**（针对当时唯一的失败 `link_no_hyperlinks`）：`rx_inline_link` 的 href 贪婪吞掉 `)`，marked 靠正则回溯收回——整块替换为带回溯循环的实现（定位 anchor：`let (href_end, i, title) = matched?;`）。**此步之后的编译+测试未跑完（见 §3.4）。**

### 3.4 ⚠️ 未验证状态与已知风险

- 第 5 步补丁写入时**再次发生 heredoc 转义吞噬**，已做两轮修复并确认输出 `fixed 4 escape lines` / `replaced 2 newline byte literals`：
  - 位置：`markdown_lexer.rs` 约 2070-2115 行的新块内，真 TAB 应为 `b'\t'`（4 处已修）、真换行应为 `b'\n'`（2 处已修）。
  - **随后两次 `cargo test` 运行均被环境杀死（exit 137），修复后的编译/测试状态未知。**
- 接手者第 1 步若编译失败：`cargo check --offline 2>&1 | head -30`，优先看 2070-2115 行；若还有真 TAB/真换行进 `b'...'` 字面量，用 anaconda python 按 `chr(9)`/`chr(10)` 定位替换。
- latex 引擎 7 例在 `PENDING_LATEX` 白名单跳过（`latex_inline_dollar / latex_inline_paren / latex_display_dollar / latex_display_bracket / latex_matrix_display / latex_lower_limit / latex_in_list`）——latex.rs 完整移植后从白名单移除即可。其余 latex 行为（currency/shell-var 非数学、pending 流式、renderLatex:false、unsupported 回退、code-fence 内不渲染、`\$` 转义）已被 fixtures+行为测试覆盖并通过。
- 已知残留：一轮出现过 unused variable warning（markdown 主题闭包参数 `c`），后已改用 `is_letter_or_number_unicode`；若 clippy 仍报按提示处理。

### 3.5 markdown 收尾后必须做的账本更新

- WORK_LOG：markdown 切片条目（移植内容、§3.3 修复史、门禁数字、7 个 latex fixture 待启用、版本偏差披露）。
- TUI_COMPATIBILITY：`markdown.ts` / `marked@18.0.5（偏差披露）` / `latex.ts(stub→完整)` / `terminal-image.ts(子集)` 四行映射。
- MIGRATION_STATUS：M4 行 + Latest whole-project verification 行。
- 删 `markdown_debug.rs` 及其注册。
- 跑 §1 四道门禁并存日志。

## 4. 接手者的执行队列（按序）

1. **验证 markdown 现状**：`cargo test --offline --lib tui::tests::markdown 2>&1 | tail -40`；按 §3.4 处理编译问题；若仍有 fixture mismatch，先读 `../.migration-handoff/reference-deps/marked-18.0.5/src-ref/` 对应规则原件再改（教训：`^` 锚失效、缓存索引 off-by-one、贪婪+回溯、chalk reopen——见 §3.3）。
2. 删 `src/tui/tests/markdown_debug.rs` + `tests.rs` 注册行。
3. `cargo fmt --all`（新文件从未 fmt）→ clippy `-D warnings` 清零 → 四道门禁 → 存日志。
4. §3.5 账本更新。
5. **latex.rs 完整移植**：符号表区（建议写 `.migration-harness-markdown/extract-latex-tables.mjs` 从 pi 原件提取生成 Rust 表，带 `@generated` + SHA-256 头，参照 generate-tui-width-tables.mjs 先例）+ renderLayout 引擎手工移植；完成后移除 PENDING_LATEX 白名单并全绿。
6. overlay 鼠标区域 hit-testing 接 screen.rs / 帧规划器（上游 mouse-region.ts）。
7. M4 剩余小件：h-stack/v-stack/stack 布局分配、loader/cancellable-loader、image.ts、index.ts 导出面、tui-main-screen 集成。
8. M5 coding-agent 主体（~71.8k 行 TS）→ M6 protocol/client/server/session-backends/telemetry。MemorySessionRepo/Facade 仍未移植。

## 5. 关键架构事实（写代码前必读）

- **差分测试模式**：真上游 TS 在 Node 下产出期望值（fixtures/生成表），Rust 逐字节对比。改行为先改 harness 语料再改 Rust。
- **JS↔Rust 语义**：`[...str].length` 是码点数；JS `.sort()` 按 UTF-16；`String.prototype.trim` 含 U+FEFF、不含 U+0085；JS 正则字节偏移是 UTF-16，Rust 用 char/字节偏移（BMP 内一致；astral 字符在 em/del raw 截取是已披露微偏差）。
- **marked 移植要点**：inline 队列 = 树的 DFS pre-order；`cachedIndentRegex` 用 indent-1；blockquote 的 `paragraph` 分支 `^` 锚 mid-pattern 失效；href/label 贪婪+回溯；`emStrong` rdelim 是 8 分支交替扫描（group 1-6 语义见 `scan_rdelim_ast` 注释与 Tokenizer.ts emStrong）；任务列表 checkbox 的 loose/tight 两条路径都在 `tokenize_list`。
- **chalk 5.6.2**：见 §3.1 末条。
- Component trait：`render(&mut self, width: usize) -> Vec<String>`；主题闭包统一 `StyleFn = Arc<dyn Fn(&str) -> String + Send + Sync>`。

## 6. 长期路线与验收标准

- **总目标**：pi-rust 与 pi 行为等价、可同样正常完成使用（全量差分测试佐证），且不动 pisper。
- 顺序：M4 收尾（§4.1-7）→ M5 coding-agent 主体 → M6 支撑件。
- 每切片铁律：移植 + 上游测试移植/差分 fixtures + 四道门禁 + 四本账本更新；不自动 commit；保留全部脏路径；pi 只读。
- 会话减速/收尾时：把本文档 §3 改写成"进行中切片"的**真实快照**（已验证/未验证分开写），使任何新执行者都能从此处无损续作。

---

*本文件由上一执行者于 2026-09-24 写于 markdown 切片收尾中断点；"已验证/未验证"以 §3.3/§3.4 为准。*
