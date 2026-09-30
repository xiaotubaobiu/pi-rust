# M5 coding-agent 并行拆片计划（wave-3 预案）

更新：2026-09-25T13:40+09:00。规模实测：packages/coding-agent = 265 文件 / 71,845 行 TS
（core 30,027 / modes 20,717 / experimental 10,677 / utils 3,558 / cli 1,920 / extensions 1,457 / root ≈3,435）。
Rust 现有 shim ≈6.4k 行；净新增 ≈65,000 行。

## 前置依赖
- M3b 收口：drive tools/structural/deferred 全链、dispatcher/AgentHarness、telemetry、task11（wave-1/2 进行中）。
- M4 host 剩余：eventloop/Intl/native clipboard/Kitty——modes/interactive 依赖它们。
- 落位约定：M5 代码按现有仓库惯例落位（候选 src/coding_agent/** 或并入 src/cli + agent_core；每个切片开工前先看 lib.rs 现有结构再定，不强制统一迁移）。

## 拆片原则
- 叶子优先、依赖聚簇、文件互斥；每片 600–1200 行 TS 等价。
- 每片：上游 SHA256 登记 → 实现 + 测试 → 确定性序列化接缝 byte oracle（node --experimental-strip-types 实跑上游）→ 报告 seam/divergence。
- 编排者集中：四门禁、scope 审计、封存、WORK_LOG。并发槽 2 个，排队轮转。

## Wave 3 排队顺序
| # | 切片 | 上游规模 | 依赖 |
|---|---|---|---|
| W3.1 | utils 叶子包：abort/ansi/json/paths/mime/frontmatter/deprecation/fs-watch/git/child-process | ~2,000 | 无（可最先行） |
| W3.2 | utils 图像包：clipboard*/image-*/exif-orientation/mime/html/photon | ~1,500 | W3.1 |
| W3.3 | core 叶子包：defaults/diagnostics/event-bus/keybindings/cache-stats/messages/model-config/models-store/footer-data-provider | ~2,500 | M3b |
| W3.4 | compaction/compaction.ts + compaction/ 其余 | ~1,400 | M3b compaction 侧 |
| W3.5 | extensions 三件套：types/loader/runner + extensions/ | ~3,900 | W3.3 |
| W3.6 | model 栈：model-registry/model-resolver/model-runtime/provider-composer/http-dispatcher | ~2,700 | W3.3 |
| W3.7 | settings-manager + auth-storage + auth-guidance | ~2,200 | W3.3 |
| W3.8 | resource-loader + skills | ~1,600 | W3.3 |
| W3.9 | package-manager.ts + package-manager-cli.ts（相对独立） | ~3,800 | W3.1 |
| W3.10 | session-manager | 1,786 | W3.5–W3.8 |
| W3.11 | agent-session.ts 上半（构造/消息/事件） | ~1,800 | W3.10 |
| W3.12 | agent-session.ts 下半（工具/压缩/生命周期）+ agent-session-runtime/services | ~1,800 | W3.11 |
| W3.13 | modes: print-mode + json-event + rpc | ~4,000 | W3.12 |
| W3.14 | modes/interactive（最大单体，等 M4 host） | ~15,000 | W3.13 + M4 |
| W3.15 | experimental 集群 A：server/coordinator/session-worker* | ~4,500 | W3.12 |
| W3.16 | experimental 集群 B：client*/micro/mini/plugins/radius* | ~6,200 | W3.15 |
| W3.17 | cli 包：args/auth*/session-picker/setup/startup-ui/project-trust 等 | ~1,900 | W3.13 |

## 节奏与估算
- 并发槽 2、每片全协议（oracle+四门禁+封存）约 0.5–1.5 晚/波；W3.1–W3.9 可两两并行轮转。
- M5 全量按每晚 8–12 小时会话节奏估 4–8 个工作日；24/7 连续约 3 天；误差 ±40%（首波实际吞吐出来后校准）。
- 行为等价标准不放松：byte oracle 覆盖所有确定性序列化接缝；LLM 响应等天然非确定项不纳入比对。
