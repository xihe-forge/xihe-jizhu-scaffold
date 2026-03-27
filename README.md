# xihe-jizhu-scaffold

> **命名由来 / Etymology** — 遵循曦和项目三段式命名规范 `xihe-{隐喻}-{功能}`：
> - **xihe（曦和）** — 品牌。源自中国神话中的太阳女神曦和 / Brand. Xihe, the sun goddess in Chinese mythology
> - **jizhu（机杼）** — 隐喻。机杼是古代织机与梭子的合称，成语「独出机杼」意为独创巧思。脚手架如机杼般将代码编织成完整项目 / Metaphor. Jīzhù refers to the ancient loom and shuttle; the idiom 独出机杼 (dú chū jīzhù) means "original ingenuity". The scaffold weaves code into complete projects
> - **scaffold（脚手架）** — 功能。项目脚手架/编排框架 / Function. Project scaffolding and orchestration framework

面向 **AI 自主软件开发** 的生产级脚手架——集持久化规划状态、7×24 自动驾驶执行、智能配额自愈于一体。

A production-grade scaffold for **autonomous AI software development** -- combining durable planning state, 24/7 autopilot execution, and intelligent quota self-healing.

为希望 AI agent 持续交付代码而非仅回复提示词的团队而建。

Built for teams that want AI agents to ship code continuously, not just respond to prompts.

## 它做什么 / What This Does

你描述一个项目构想，脚手架会：

You describe a project idea. The scaffold:

1. **访谈** 你以厘清范围、需求和优先级 / **Interviews** you to clarify scope, requirements, and priorities
2. **生成** 结构化项目计划（任务、里程碑、验收标准） / **Generates** a structured project plan (tasks, milestones, acceptance criteria)
3. **自主执行**，采用多 agent 模型（Opus 编排，Sonnet/Codex/Gemini 实现） / **Executes autonomously** using a multi-agent model (Opus orchestrates, Sonnet/Codex/Gemini implement)
4. **中断恢复** ——配额耗尽、速率限制、进程崩溃均可自动恢复 / **Survives interruptions** -- quota exhaustion, rate limits, process crashes -- and resumes where it left off

最终形成一个自治的开发循环，直到所有工作完成。

The result is a self-governing development loop that runs until the work is done.

## 核心设计决策 / Key Design Decisions

### 多 Agent 模型（Opus + Sonnet + Codex） / Multi-Agent Model (Opus + Sonnet + Codex)

自动驾驶始终以最强模型（Opus）作为编排者。Opus 读取任务队列、分析依赖、规划拆解，并将工作分派给实现者：

The autopilot always runs the strongest model (Opus) as orchestrator. Opus reads the task queue, analyzes dependencies, plans decomposition, and dispatches workers for implementation:

- **Sonnet 子 agent** ——使用 worktree 隔离启动（每个拥有独立 git 分支和工作目录） / **Sonnet sub-agents** -- launched with worktree isolation (each gets its own git branch and working directory)
- **Codex CLI** ——通过 `codex-bridge/` PowerShell 模块委派独立编码任务 / **Codex CLI** -- delegated via the `codex-bridge/` PowerShell module for independent coding tasks
- **Gemini CLI** ——通过 `gemini-bridge/` PowerShell 模块委派前端/设计任务 / **Gemini CLI** -- delegated via the `gemini-bridge/` PowerShell module for frontend/design tasks
- **Opus 直接执行** ——规划/审查任务由编排者自己完成 / **Opus direct** -- planning/review tasks completed by the orchestrator itself

任务分配由 `dev/task.json` 中的 `assignee` 字段控制（`"sonnet"`, `"codex"`, `"gemini"`, 或 `"opus"`）。

Task assignment is controlled by the `assignee` field in `dev/task.json` (`"sonnet"`, `"codex"`, `"gemini"`, or `"opus"`).

### 配额自愈 / Quota Self-Healing

当 AI 运行时遇到速率限制或配额耗尽时，大多数工具会崩溃或浪费重试。本脚手架将配额故障识别为独立类别——不消耗正常重试预算。自动驾驶进入 `waiting_quota` 状态，解析可用的重置时间，并自动恢复。一次 24 小时运行即使多次撞上配额墙仍能完成所有任务。

When the AI runtime hits rate limits or quota exhaustion, most tools crash or burn retries. This scaffold recognizes quota failures as a distinct category -- they don't consume the normal retry budget. The autopilot enters a `waiting_quota` state, parses reset times when available, and resumes automatically. A 24-hour run that hits multiple quota walls still completes all tasks.

### 持久化规划状态 / Durable Planning State

所有规划产物以纯文件形式存放在 `.planning/` 中：

All planning artifacts live in `.planning/` as plain files:

| 文件 / File | 用途 / Purpose |
|------|---------|
| `PROJECT.md` | 产品定位、目标用户 / Identity, positioning, target users |
| `REQUIREMENTS.md` | 范围内外、约束条件 / In-scope, out-of-scope, constraints |
| `ROADMAP.md` | 里程碑和阶段序列 / Milestones and phase sequence |
| `STATE.md` | 当前状态、阻塞项、下一步、决策 / Current status, blockers, next step, decisions |

AI 每轮运行前读取这些文件，人类也可直接编辑。没有数据库、没有服务器、没有锁定——只是仓库中的文件。

The AI reads these before every round. Humans can edit them directly. There's no database, no server, no lock-in -- just files in your repo.

### 增量式项目接入 / Additive-Only Project Adoption

已有项目？`pnpm adopt` 将规划层叠加到你的项目中，不触碰源代码、配置或目录结构。它会扫描仓库、访谈你的目标并生成规划文件，绝不覆盖已有文件。

Got an existing project? `pnpm adopt` overlays the planning layer without touching your source code, configs, or project structure. It scans your repo, interviews you about goals, and generates the planning files. Existing files are never overwritten.

## 目录结构 / Architecture

```
xihe-jizhu-scaffold/
├── .planning/          # 持久化规划状态 / Durable planning state (PROJECT, REQUIREMENTS, ROADMAP, STATE, config.json)
├── .autopilot/         # 运行时配置和状态 / Runtime config and state (model selection, retry policy, session state, project memory)
├── .ai/
│   ├── recipes/        # Agent 剧本 / Agent playbooks (implement, review, diagnose, adopt, security-audit, etc.)
│   ├── skills/         # 外部技能模块 / External skill modules (impeccable, vercel-web-design)
│   └── templates/      # 项目类型模板 / Project type templates (saas, landing-page, api-only, fullstack)
├── .claude/commands/   # CLI 斜杠命令 / CLI slash commands, templates (*.md.tmpl), command-registry.json
├── apps/               # 应用入口 / Application entrypoints (web, api)
├── packages/           # 共享代码和类型 / Shared code and types
├── docs/               # 研究、MRD、PRD、技术规格、设计文档 / Research, MRD, PRD, tech specs, design docs
├── dev/                # task.json, progress.txt, metrics.json, bug 修复、审查日志 / Bug fixes, review logs
├── test/               # 单元测试 / Unit tests (195 tests across 33 test suites)
├── infra/scripts/      # 自动驾驶引擎、接入流程、健康检查 / Autopilot engine, intake flow, health checks
│   └── lib/            # 共享工具库 / Shared utilities (ai-runner, autopilot-phases, autopilot-runner, memory, project-setup, utils, notifications, skill-utils)
├── codex-bridge/       # Codex CLI 委派模块 / PowerShell module for Codex CLI delegation
├── gemini-bridge/      # Gemini CLI 委派模块 / PowerShell module for Gemini CLI delegation
├── AGENTS.md           # Agent 行为规则 / Agent behavior rules (read before every round)
└── package.json        # 所有命令 / All commands: kickoff, work, adopt, health, etc.
```

## 快速开始 / Quick Start

### 新项目 / New Project

```bash
git clone https://github.com/xihe-forge/xihe-jizhu-scaffold.git my-project
cd my-project
pnpm install
pnpm kickoff
```

接入流程会：/ The intake flow will:
- 选择配置模式（一键 / 标准 / 高级） / Choose your configuration mode (one-click / standard / advanced)
- 描述你的项目构想 / Ask you to describe your project idea
- 通过 AI 生成澄清问题，然后产出结构化规划文件和任务队列 / Generate clarification questions via AI, then produce structured planning files and a task queue
- 配置审查策略和 AI 运行时（标准/高级模式） / Configure review strategy and AI runtime (standard/advanced modes)
- 自动验证并启动自动驾驶（一键模式），或手动确认 / Auto-verify and start autopilot (one-click mode) or confirm manually

### 配置模式 / Configuration Modes

| 模式 / Mode | 适用人群 / Who it's for | 询问内容 / What it asks |
|------|-------------|-------------|
| **一键 / One-click** | 快速上手 / Get started fast | 仅项目描述+澄清问题，自动启动自动驾驶 / Project description + clarification only. Auto-starts autopilot |
| **标准 / Standard** | 多数用户 / Most users | + 审查策略 + AI 运行时选择 / + Review strategy + AI runtime selection |
| **高级 / Advanced** | 高级用户 / Power users | + 并行度、TDD、代码审查开关、Bug 阈值 / + Parallelization, TDD, code review toggles, bug threshold |

### 审查策略 / Review Strategies

在 `.planning/config.json` 的 `review_strategy` 中配置：

Configured in `.planning/config.json` under `review_strategy`:

| 策略 / Strategy | `mode` 值 / value | 行为 / Behavior |
|----------|-------------|----------|
| **自动 / Auto**（默认 / default） | `"auto"` | 审查轮次随项目复杂度自动缩放（5--12） / Review rounds scale with project complexity (5--12) |
| **零缺陷 / Zero-bug** | `"zero_bug"` | 持续审查直到剩余 Bug 低于阈值（默认：3） / Keep reviewing until remaining bugs < threshold (default: 3) |
| **自定义 / Custom** | `"custom"` | 用户通过 `custom_rounds` 指定精确审查轮次 / User specifies exact number of review rounds via `custom_rounds` |

### 接入已有项目 / Adopt Existing Project

```bash
cd your-existing-project
# 将脚手架文件复制到项目中，然后：/ Copy scaffold files into the project, then:
pnpm adopt
```

### 启动自主工作 / Start Autonomous Work

```bash
pnpm work
```

自动驾驶会：/ The autopilot will:
- 读取 `AGENTS.md` 和 `.planning/STATE.md` / Read `AGENTS.md` and `.planning/STATE.md`
- 选取所有依赖已满足的最高优先级任务（环路安全） / Pick the highest-priority task with all dependencies satisfied (cycle-safe)
- 多任务就绪时并行分派子 agent / Dispatch parallel sub-agents when multiple tasks are ready
- 注入适用的审查门和技能指令到提示词中 / Inject applicable review gates and skill instructions into the prompt
- 审查、合并、验证后标记任务完成 / Review, merge, and verify before marking tasks complete
- 自动处理配额/速率限制（专用状态，不消耗重试预算） / Handle quota/rate limits automatically (dedicated state, does not consume retry budget)
- 循环直到所有任务完成，然后进入最终审查 / Loop until all tasks are done, then enter final review

### npm 脚本 / npm Scripts

```bash
pnpm start-here          # 交互菜单 / Interactive menu
pnpm kickoff             # 项目接入向导 / Run project intake wizard (alias: pnpm setup, pnpm talk)
pnpm work                # 启动自动驾驶循环 / Start autopilot loop (alias: pnpm autopilot:start)
pnpm health              # 验证项目结构 / Validate project structure
pnpm plan:status         # 显示规划状态 / Show planning state
pnpm adopt               # 叠加规划层到已有项目 / Overlay planning layer onto existing project
pnpm autopilot:configure # 更改 AI 运行时/模型选择 / Change AI runtime / model selection
pnpm autopilot:status    # 显示自动驾驶状态 / Show autopilot status
pnpm autopilot:stop      # 优雅停止自动驾驶 / Stop the autopilot gracefully
pnpm autopilot:doctor    # 诊断自动驾驶问题 / Diagnose autopilot issues
pnpm nyquist             # 运行 Nyquist 验证检查 / Run Nyquist validation check
pnpm skill:update        # 更新技能子模块到最新远程版 / Update skill submodules to latest remote
pnpm skill:add           # 添加外部技能模块 / Add an external skill module (git submodule)
pnpm skill:create        # 从模板创建新自定义技能 / Create a new custom skill from template
pnpm dashboard           # 打开自动驾驶仪表盘 / Open autopilot dashboard
pnpm test:unit           # 运行单元测试 / Run unit tests (node --test)
pnpm dev                 # 启动开发服务器 / Start dev servers (turbo)
pnpm build               # 构建所有包 / Build all packages (turbo)
pnpm typecheck           # 类型检查所有包 / Type-check all packages (turbo)
pnpm lint                # 检查所有包 / Lint all packages (turbo)
pnpm test                # 运行所有测试 / Run all tests (turbo)
pnpm gen:commands        # 从模板重新生成命令 / Regenerate .claude/commands/*.md from templates
pnpm validate:commands   # 验证命令注册表 / Validate command registry (skill paths, recipe paths)
```

### CLI 斜杠命令 / CLI Slash Commands

`.claude/commands/` 中的命令由 `.md.tmpl` 模板通过 `pnpm gen:commands` 生成。每个模板包含 `{{PREAMBLE}}` 占位符，被替换为 `preamble.md` 中的共享上下文，保持所有命令一致无需手动复制。

Commands in `.claude/commands/` are generated from `.md.tmpl` templates via `pnpm gen:commands`. Each template contains a `{{PREAMBLE}}` placeholder that is replaced with shared context from `preamble.md`, keeping all commands consistent without manual duplication.

`pnpm validate:commands` 检查每个模板文件是否存在、`command-registry.json` 中引用的每个技能是否解析到 `skill-registry.json` 中的条目、以及每个 recipe 路径是否解析到 `.ai/recipes/` 中的文件。

`pnpm validate:commands` checks that every template file exists, every skill referenced in `command-registry.json` resolves to an entry in `skill-registry.json`, and every recipe path resolves to a file in `.ai/recipes/`.

可用命令 / Available via `.claude/commands/`:

| 命令 / Command | 用途 / Purpose |
|---------|---------|
| `/intake` | 运行项目接入向导 / Run project intake wizard |
| `/autopilot` | 启动自动驾驶循环 / Start autopilot loop |
| `/health` | 运行健康检查 / Run health checks |
| `/status` | 一览项目状态 / Show project status at a glance |
| `/review [files]` | 代码 + 前端审查 / Code + frontend review |
| `/design [target]` | 前端设计生成/细化 / Frontend design generation/refinement (impeccable) |
| `/ux-audit [files]` | 双重 UX 审计（美学 + 工程） / Dual UX audit (aesthetic + engineering) |
| `/security [files]` | OWASP Top 10 + 密钥 + 依赖漏洞扫描 / OWASP Top 10 + secrets + dependency vulnerability scan |
| `/deploy-check` | 生产部署就绪检查 / Production deployment readiness check |
| `/cost [detail]` | 成本和 token 用量报告 / Cost and token usage report |

## 外部技能模块 / External Skill Modules

脚手架的核心架构（自动驾驶、接入、审查管道）是自包含的。外部技能模块为专业的前端质量提供扩展：

The scaffold's core architecture (autopilot, intake, review pipeline) is self-contained. External skill modules extend it for specialized frontend quality:

| 模块 / Module | 角色 / Role | 来源 / Source |
|--------|------|--------|
| **impeccable** | 前端设计生成与细化，反 AI 审美（10 个注册技能 + 7 个参考文档） / Frontend design generation & refinement, anti-AI-slop aesthetics (10 registered skills + 7 reference docs) | [impeccable](https://github.com/pbakaus/impeccable) |
| **vercel-web-design** | 工程级 UX 质量门（无障碍、性能、标准） / Engineering UX quality gate (accessibility, performance, standards) | [vercel-labs](https://github.com/vercel-labs/agent-skills) |
| **xihe-rinian-seo** | SEO/GEO/AEO 审计、AI 搜索引擎优化、结构化数据验证 / SEO/GEO/AEO audit, AI search engine optimization, structured data validation | [xihe-forge](https://github.com/xihe-forge/xihe-rinian-seo) |

三个模块**互补**：impeccable 负责视觉美学（反 AI 味），Vercel 负责工程标准（无障碍、性能、UX），xihe-rinian-seo 负责搜索可发现性（SEO/GEO/AEO）。审查和最终迭代中三者协同使用。

These three modules are **complementary**: impeccable handles visual aesthetics (anti-AI-slop), Vercel handles engineering standards (a11y, performance, UX), and xihe-rinian-seo handles search discoverability (SEO/GEO/AEO). All are used together during reviews and final iteration.

技能注册表 / Skill registry: `.ai/skills/skill-registry.json`
- 技能声明 `depends_on` 边（如 `polish` 依赖 `audit`） / Skills declare `depends_on` edges (e.g., `polish` depends on `audit`)
- 自动驾驶对技能进行拓扑排序并按正确顺序注入 / Autopilot topologically sorts skills and injects them in correct order
- 每个任务将注入的技能记录到 `dev/progress.txt` / Each task logs which skills were injected to `dev/progress.txt`

**阶段映射 / Phase mapping**（来自 `skill-registry.json`）：

| 阶段 / Phase | 注入的技能 / Skills injected |
|-------|----------------|
| `implement_frontend` | `impeccable/frontend-design` |
| `review_frontend` | `impeccable/critique` -> `vercel-web-design/web-design-guidelines` -> `impeccable/audit` -> `impeccable/normalize` -> `impeccable/polish` |
| `review_seo` | `xihe-rinian-seo/seo-audit` -> `xihe-rinian-seo/aeo-audit` -> `xihe-rinian-seo/aeo-monitor` -> `xihe-rinian-seo/seo-report` |
| `final_review` | `impeccable/audit` -> `vercel-web-design/web-design-guidelines` -> `xihe-rinian-seo/seo-audit` -> `xihe-rinian-seo/aeo-audit` -> `xihe-rinian-seo/aeo-monitor` -> `xihe-rinian-seo/seo-report` |

## 项目模板 / Project Templates

接入向导提供项目类型模板以预配置脚手架：

The intake wizard offers project type templates to pre-configure the scaffold:

| 模板 / Template | 审查门 / Review Gates | 支付 / Payment | TDD |
|----------|-------------|---------|-----|
| **SaaS** | MRD/PRD、技术/设计、代码、测试、营销 / MRD/PRD, Tech/Design, Code, Test, Marketing | 启用 / Enabled | 开 / On |
| **落地页 / Landing Page** | 仅代码 + 营销 / Code + Marketing only | 关 / Off | 关 / Off |
| **纯 API / API-only** | MRD/技术/代码/测试 / MRD/Tech/Code/Test | 关 / Off | 开 / On |
| **全栈 / Full-stack** | MRD/技术/代码/测试 / MRD/Tech/Code/Test | 关 / Off | 开 / On |
| **自定义 / Custom** | 手动配置 / Manual configuration | -- | -- |

模板还提供起始任务和建议阶段，在接入时选择。

Templates also provide starter tasks and suggested phases. Select during intake.

模板文件 / Template files: `.ai/templates/{saas,landing-page,api-only,fullstack}.json`

## 成本与指标追踪 / Cost & Metrics Tracking

自动驾驶在 `dev/metrics.json` 中追踪每任务的成本和 token 用量：

The autopilot tracks per-task cost and token usage in `dev/metrics.json`:

- 每任务：模型、输入/输出 token、成本（USD）、时长、状态 / Per-task: model, input/output tokens, cost USD, duration, status
- 每会话：累计总量（完成任务数、总 token、总成本、总时长） / Per-session: cumulative totals (tasks completed, total tokens, total cost, total duration)
- 通过 `/cost`（概要）或 `/cost detail`（逐任务明细）查看 / View with `/cost` (summary) or `/cost detail` (per-task breakdown)

## 阶段审查门 / Stage-Based Review Gates

脚手架在每个开发阶段强制执行审查。审查门配置在 `.planning/config.json` 的 `review_gates` 中。

The scaffold enforces mandatory reviews at each development stage. Review gate configuration is in `.planning/config.json` under `review_gates`.

```
MRD/PRD 已创建 / Created -------> review-mrd-prd.md        [阻塞 / BLOCKING]
                                       |
技术/设计文档 / Tech/Design Docs --> review-tech-design.md   [阻塞 / BLOCKING]
                                       |
代码实现 / Code Implementation ----> review-code.md          [阻塞 / BLOCKING]
                                       |
测试完成 / Testing Complete -------> review-test-coverage.md [阻塞 / BLOCKING]  (需 100% PRD 覆盖 / 100% PRD coverage required)
                                       |
营销 / Marketing ------------------> review-marketing.md     [建议 / Advisory]
                                       |
SEO/AEO（Web 部署）/ (web deploy) -> review-seo-aeo.md      [建议 / Advisory]
                                       |
所有任务完成 / All Tasks Complete --> review-final-iteration.md [阻塞 / BLOCKING]  (多 AI 收敛 / multi-AI convergence)
```

每个门指定：/ Each gate specifies:
- **Recipe**：要遵循的审查剧本（在 `.ai/recipes/` 中） / the review playbook to follow (in `.ai/recipes/`)
- **Tools**：审查中引用的开源技能模块 / opensource skill modules referenced during review
- **Blocking**：该门是否必须通过才能继续 / whether the gate must pass before proceeding

**补充检查清单 / Supplementary checklists**（被审查 recipe 引用）：
- `.ai/recipes/frontend-review-checklist.md` ——真实前端 Bug 清单（布局、认证 UI、定价、响应式、i18n），所有前端代码审查必用 / Real-world frontend bugs (layout, auth UI, pricing, responsive, i18n). Mandatory for all frontend code reviews
- `.ai/recipes/payment-integration-guide.md` —— Creem + Wise 设置和端到端测试流程，当 `optional_modules.payment.enabled` 为 true 时使用 / Creem + Wise setup and E2E test flow. Used when `optional_modules.payment.enabled` is true
- `.ai/recipes/security-audit.md` —— OWASP Top 10、依赖扫描、密钥检测、API 安全、前端安全 / OWASP Top 10, dependency scanning, secrets detection, API security, frontend security
- `.ai/recipes/error-handling-and-logging.md` ——错误安全和结构化日志标准，所有项目必用 / Error safety and structured logging standards. Mandatory for all projects

**PRD 到测试覆盖规则 / PRD-to-Test coverage rule**：测试必须覆盖整个 PRD。测试覆盖审查构建覆盖矩阵（每条 PRD 需求→对应测试），有缺口则阻塞。

Tests must cover the entire PRD. The test coverage review builds a coverage matrix (every PRD requirement -> corresponding tests) and blocks on any gaps.

### 先修复审查协议 / Fix-First Review Protocol

审查发现分为两类：/ Review findings are classified into two categories:

| 分类 / Classification | 动作 / Action | 示例 / Examples |
|----------------|--------|----------|
| **自动修复 / AUTO-FIX** | Agent 立即修复，无需询问 / Agent fixes immediately without asking | 缺少空值检查、断裂的导入、测试缺口、拼写错误 / Missing null check, broken import, test gap, typo |
| **报告 / REPORT** | 记录供人类决策 / Logged for human decision | 架构变更、范围扩展、模糊需求 / Architecture change, scope expansion, ambiguous requirement |

其他审查行为 / Additional review behaviors:

- **范围漂移检测（阶段 0）/ Scope Drift Detection (Stage 0)**：任何审查门运行前，自动驾驶检查当前工作是否偏离任务的验收标准。漂移会被标记并在审查前纠正 / Before any review gate runs, the autopilot checks whether the current work has drifted from the task's acceptance criteria. Drift is flagged and corrected before review proceeds
- **对抗性子 Agent / Adversarial Sub-Agent**：最终审查中，对抗性子 agent 通过测试边界情况、无效输入和未记录假设来尝试破坏交付物。发现进入正常分类管道 / During final review, an adversarial sub-agent attempts to break the deliverable by testing edge cases, invalid inputs, and undocumented assumptions. Findings feed into the normal triage pipeline
- **完成状态协议 / Completion Status Protocol**：每轮审查以四种状态之一结束 / Every review round ends with one of four statuses:
  - `DONE` ——所有检查通过，无问题 / all checks pass, no issues
  - `DONE_WITH_CONCERNS` ——通过但有值得注意的建议性发现 / passes but has advisory findings worth noting
  - `BLOCKED` ——发现阻塞问题，必须修复后才能继续 / blocking issue found, must fix before proceeding
  - `NEEDS_CONTEXT` ——审查者无法在没有额外信息的情况下判断正确性 / reviewer cannot determine correctness without additional information

## 最终迭代审查（多 AI 收敛） / Final Iteration Review (Multi-AI Convergence)

当所有任务完成时，自动驾驶进入**最终审查循环**，多个 AI 模型并行审计整个交付物：

When all tasks complete, the autopilot enters a **final review loop** where multiple AI models audit the entire deliverable in parallel:

```
所有任务完成 / All tasks done
    |
    v
+--------------------------------------+
| Opus 分派并行审查者 / dispatches:    |
|                                      |
|  文档 / Docs: Opus + Codex (并行)    |
|  代码 / Code: Sonnet + Codex (并行)  |
|                                      |
|         v                            |
|  Opus 收集并分类发现 / triages       |
|  (去重、分类、过滤 / dedup, filter)  |
|         |                            |
|    +----+----+                       |
|    |         |                       |
| 无问题    有 Bug                      |
| No issues  Has bugs                  |
|    |         |                       |
|    v         v                       |
| 收敛       通过 Sonnet/Codex 修复     |
| CONVERGED  Fix via Sonnet/Codex      |
|            -> 下一审查轮 / next round |
+--------------------------------------+
```

每个审查者使用审查 recipe 和开源工具独立运行。Opus 作为分类者——仅 BUG、SECURITY 和 COVERAGE GAP 发现被修复；STYLE 和 FALSE POSITIVE 被跳过。

Each reviewer operates independently using the review recipes and opensource tools. Opus acts as triage -- only BUG, SECURITY, and COVERAGE GAP findings get fixed; STYLE and FALSE POSITIVE are skipped.

**动态最大轮次 / Dynamic max rounds**（当 `review_strategy.mode` 为 `"auto"` 时）：

| 项目规模 / Project Size | 任务数 / Tasks | 源文件数 / Source Files | 最大轮次 / Max Rounds |
|---|---|---|---|
| 小 / Small | <= 10 | <= 20 | 5 |
| 中 / Medium | 11--30 | 21--50 | 7 |
| 大 / Large | 31--60 | 51--100 | 10 |
| 超大 / XL | > 60 | > 100 | 12 |

当任务数和文件数落在不同层级时，取较高层级。

The higher tier wins when task count and file count fall in different tiers.

**用户决策门 / User decision gate**：当最大轮次用尽且仍有未解决问题时，自动驾驶**暂停**（`awaiting_user_decision`）而非静默完成。用户选择：

When max rounds are reached and unresolved issues remain, the autopilot **pauses** (`awaiting_user_decision`) instead of silently finishing. The user chooses:

- `pnpm work --continue-review` ——继续更多审查轮次 / extend with another batch of review rounds
- `pnpm work --accept-as-is` ——接受当前状态，标记审查完成 / accept current state, mark review as done

## 自动驾驶状态机 / Autopilot State Machine

```
                    +---------------------------+
                    |                           |
                    v                           |
              +----------+    exit=0     +------+-----+
  start ----->|  idle    |<--------------| running    |
              +----+-----+              +--+---+-----+
                   |                       |   |
                   | 选取任务 / pick task   |   | 检测到配额 / quota detected
                   v                       |   v
              +----------+                 | +--------------+
              | running  |                 | |waiting_quota |
              +----------+                 | | (智能等待 /   |
                                           | |  smart wait) |
                          非配额错误 /      | +------+-------+
                          non-quota error   |       | 计时器到期 / timer expires
                                +----------+       |
                                v                  |
                          +--------------+         |
                          |waiting_retry |         |
                          | (普通等待 /   |         |
                          |  dumb wait)  |         |
                          +------+-------+         |
                                 |                 |
                                 +--------+--------+
                                          |
                                          v
                                    +----------+
                                    | running  | (重试 / retry)
                                    +----------+

所有任务完成时 / When all tasks done:

              +--------------+
 全部完成 --> | final_review |<---- 有修复任务 / has fix tasks
 all done     | (第 N 轮)    |        |
              +------+-------+        |
                     |                |
              +------+-------+        |
              |              |        |
          无问题        有 Bug -------+
          no issues    found bugs (修复 -> 再审 / fix -> re-review)
              |
              v
        +-----------------+
        |final_review_done|
        +-----------------+

最大轮次用尽且仍有未解决问题 / Max rounds reached with unresolved issues:

        +--------------+
        | final_review  |
        | (已达上限 /   |
        |  max reached) |
        +------+-------+
               | 有未解决问题 / has unresolved
               v
  +--------------------------+
  | awaiting_user_decision   |
  | (自动驾驶暂停 /          |
  |  autopilot paused)       |
  +-----+----------+---------+
        |          |
  --continue    --accept
   -review      -as-is
        |          |
        v          v
  +----------+ +-----------------+
  | 继续审查  | |final_review_done|
  | resume   | +-----------------+
  | review   |
  +----------+
```

**关键区别 / Key distinctions**:
- `waiting_quota` 不消耗重试预算——速率限制是预期行为，不是错误 / does not consume the retry budget -- rate limits are expected, not errors
- `final_review` 并行分派多个 AI 模型进行交叉验证 / dispatches multiple AI models in parallel for cross-validation
- 当零个新 BUG/SECURITY/COVERAGE GAP 问题被发现时审查循环收敛 / The review loop converges when zero new BUG/SECURITY/COVERAGE GAP issues are found
- `awaiting_user_decision` 确保问题持续存在时人类拥有最终决定权 / ensures humans have final say when issues persist after max rounds

**依赖 ID 验证 / Dependency ID validation**：引用未知 ID 的 `depends_on` 条目被警告并视为未满足，而非静默跳过。循环依赖在运行前通过 DFS 图着色检测。

Task `depends_on` entries referencing unknown IDs are warned and treated as unsatisfied rather than silently skipped. Circular dependencies are detected via DFS graph coloring before the run begins.

**Windows 进程树终止 / Windows process tree termination**：超时时，自动驾驶使用 `taskkill /T /F` 终止整个进程树，防止孤儿 AI CLI 进程在会话间累积。

On timeout, the autopilot uses `taskkill /T /F` to kill the entire process tree, preventing orphaned AI CLI processes from accumulating across sessions.

**Git 安全 / Git safety**：`ensureCleanWorkingTree()` 在每个任务完成后自动提交未暂存的变更。`pushToRemote()` 在所有任务完成时推送。所有 git 命令使用 `spawnSync` 配合参数数组以防止 shell 注入。

`ensureCleanWorkingTree()` auto-commits any unstaged changes after each task completes. `pushToRemote()` pushes when all tasks are done. All git commands use `spawnSync` with argument arrays to prevent shell injection.

## 多运行时支持 / Multi-Runtime Support

脚手架是运行时无关的。配置一次，随时切换：

The scaffold is runtime-agnostic. Configure once, switch anytime:

```bash
pnpm autopilot:configure
```

支持的运行时 / Supported runtimes:
- **Claude CLI** —— 使用 `--print` 模式的 `claude` / `claude` with `--print` mode
- **Codex CLI** —— 使用 `--full-auto` 的 OpenAI `codex` / OpenAI's `codex` with `--full-auto`
- **Gemini CLI** —— 通过 `gemini-bridge/` 委派的 Google `gemini` / Google's `gemini` delegated via `gemini-bridge/`
- **自定义 / Custom** ——任何接受 stdin 提示并在 stdout 返回输出的 CLI / any CLI that accepts a prompt on stdin and returns output on stdout

## 部署就绪检查 / Deploy Readiness

运行 `pnpm health` 进行基本结构验证，或加 `--deploy-ready` 进行生产检查：

Run `pnpm health` for basic structure validation, or add `--deploy-ready` for production checks:

```bash
node infra/scripts/health-check.mjs --deploy-ready
```

部署就绪检查项 / Deploy readiness checks:
1. **环境变量 / Environment variables** ——生产环境文件存在，无占位值 / production env file exists, no placeholder values
2. **密钥扫描 / Secrets scan** ——遍历 `src/`、`apps/`、`packages/` 查找硬编码的密钥/令牌/密码 / walks `src/`, `apps/`, `packages/` for hardcoded keys/tokens/passwords
3. **构建验证 / Build verification** ——运行 `pnpm build` 并检查输出目录 / runs `pnpm build` and checks for output directories
4. **Package.json** ——名称、版本、private 标志、无 `file:`/`link:` 依赖 / name, version, private flag, no `file:`/`link:` dependencies
5. **法律页面 / Legal pages**（启用支付时 / if payment enabled）——隐私政策、服务条款、支持邮箱 / privacy policy, terms of service, support email

## 设计理念 / Philosophy

1. **让 AI 先澄清再编码** ——接入访谈避免浪费工作 / **Let AI clarify before coding** -- the intake interview prevents wasted work
2. **规划状态属于仓库** ——不在 SaaS 中，不在数据库中 / **Planning state belongs in the repo** -- not in a SaaS, not in a database
3. **自主性需要韧性** ——配额墙和崩溃是预期中的，不是例外 / **Autonomy requires resilience** -- quota walls and crashes are expected, not exceptional
4. **小的可验证任务** ——每个任务都有明确的验收标准 / **Small verifiable tasks** -- every task has explicit acceptance criteria
5. **最强模型编排，最快模型实现** ——按任务类型匹配模型能力 / **Strongest model orchestrates, fastest model implements** -- match model capability to task type

## 贡献 / Contributing

参见 [AGENTS.md](./AGENTS.md) 了解人类和 AI agent 共同遵循的仓库规则。[`.ai/recipes/`](./.ai/recipes/) 目录包含常见工作流的剧本。

See [AGENTS.md](./AGENTS.md) for the repo rules that both humans and AI agents follow. The [`.ai/recipes/`](./.ai/recipes/) directory contains playbooks for common workflows.

## 许可证 / License

MIT

---

## 关于曦和 AI / About Xihe AI

曦和（Xihe）得名于中国神话中驾驭太阳的女神。[xihe-forge](https://github.com/xihe-forge) 是曦和 AI 的开源锻造炉——我们在这里把实用的 AI 工具从想法锤炼成可以直接上手的开源项目。

Xihe is named after the sun goddess who drives the solar chariot in Chinese mythology. [xihe-forge](https://github.com/xihe-forge) is Xihe AI's open-source forge — where we hammer practical AI tools from ideas into ready-to-use open-source projects.

xihe-jizhu-scaffold 是第一件出炉的作品。更多面向 AI 自主开发的工具正在锻造中，欢迎 Watch 组织动态或参与贡献。

xihe-jizhu-scaffold is the first piece out of the forge. More AI-powered development tools are being forged — watch the org or contribute.
