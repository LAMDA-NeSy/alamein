# AI 模块目录

从仓库根目录开始的完整安装、Mock 烟测、真实模型、六局验收、baseline 和指标报告说明，统一维护在根目录 [README.md](../README.md)。本文件保留 AI 模块的技术细节和单个入口示例。

AI 代码按职责分为以下目录：

```text
ai/
├── config/       YAML 模型、方法、工具 Profile 和浏览器 AI 配置
├── core/         上下文、工具桥、模型网关、比较合同和公共路径
├── harnesses/    OpenCode、LangGraph、PydanticAI 运行实现
├── prompt/       阵营专属 PE 与共享协议 Prompt
├── experiments/  完整对局、批量实验、质量检查、审计和汇总
└── tests/        Node 与 Python AI 测试
```

常用命令仍从项目根目录运行：

```bash
pnpm test
pnpm run ai:full-game -- --model-profile mock_primary --max-steps 1
pnpm run ai:full-game -- --decision-policy unit_plan_hybrid --model-profile mock_primary --max-steps 1000
pnpm run ai:full-game -- --decision-policy hierarchical_sae --task-management multi_task --model-profile mock_primary --task-checker-model-profile mock_secondary --max-steps 8
pnpm run ai:opencode -- --model-profile mock_primary --max-steps 1
pnpm run ai:langgraph -- --model-profile mock_primary --max-steps 1
pnpm run ai:pydanticai -- --model-profile mock_primary --max-steps 1
pnpm run ai:batch -- --model-profiles mock_primary --seeds 1942 --max-steps 1
pnpm run ai:acceptance -- --out-dir log/sae_acceptance_mock --model-profile mock_primary --task-checker-model-profile mock_secondary --concurrency 6
pnpm run ai:metrics -- log/run1.json log/run2.json --out log/research_metrics.json
pnpm run ai:metrics -- log/run1.json log/run2.json --judge --judge-model-profile deepseek_flash --out log/research_metrics_with_judge.json
pnpm run ai:metrics -- \
  log/july_axis.json log/july_allies.json \
  log/september_axis.json log/september_allies.json \
  log/october_axis.json log/october_allies.json \
  --judge --judge-model-profile mock_secondary \
  --out log/all_scenarios_metrics.json
# Optional rules-vs-rules baselines must match scenario, side, seed, and replicate.
pnpm run ai:metrics -- log/july_axis.json \
  --baseline log/july_axis_rules_baseline.json \
  --out log/july_metrics_with_baseline.json
pnpm run ai:compare -- --dimension method --baseline direct log/run1.json log/run2.json
```

The public default model is `mock_primary`, so the commands above run offline without
an API key. The task checker defaults to `mock_secondary`. Real model calls are
opt-in, for example `--model-profile deepseek_flash`; the selected profile reads
its API key only from the configured environment variable.

Python 和 PydanticAI 环境由 `uv` 管理：

```bash
uv sync --locked --group dev
uv run --locked --group dev pytest ai/tests
pnpm run test:pydanticai
```

依赖变更后先运行 `uv lock`；日常使用 `uv sync --locked --group dev`，确保环境严格匹配 `uv.lock`。PydanticAI Harness 默认使用 `.venv/bin/python`；也可以通过 `--pydanticai-python` 或 `PYDANTICAI_PYTHON` 显式指定解释器。

所有实验默认写入项目根目录的 `log/`。命令行传入 `--out` 或 `--out-dir` 时使用显式路径。

实验回放与前端使用同一组双方控制器名称，可分别配置 Axis 和 Allies：

```bash
pnpm run ai:full-game -- \
  --scenario july \
  --axis-controller external_ai \
  --allies-controller rules_ai \
  --model-profile deepseek_flash \
  --decision-policy hierarchical_sae \
  --seed 1942 \
  --out log/july__axis-external_ai__allies-rules_ai__1942.json
```

可选值是 `human`、`heuristic_ai`、`rules_ai` 和 `external_ai`。自动实验遇到 `human` 会返回 `waiting_for_human`，不会静默替换成规则 AI。未指定双方控制器时，实验默认双方使用 `rules_ai`，与前端新局默认配置一致。旧的 `--external-side axis|allies` 仍可用，会把指定方映射为 `external_ai`，另一方使用 `rules_ai`。实验日志、完整转录和质量指标会记录 `controllers`、`axis_controller`、`allies_controller`，并在实验 ID 和指标分组中包含双方配置。

`config/` 只包含 YAML：`agent_methods.yaml` 配置方法和工具组合；`agent_tools.yaml` 使用 `name`、`description` 和 `parameters` 定义工具；`ai_models.yaml` 配置模型；`ai_config.yaml` 配置 API 兼容入口与上下文边界；`agent_tool_profiles.schema.yaml` 约束工具组合。

`config/research_metrics.yaml` 固定论文评估口径。`ai:metrics` 统一输出 `result_metrics`、`tactical_metrics`、`reliability_metrics`、`efficiency_metrics`、`judge_metrics`、`baseline_comparison`、`scenario_metrics` 和 `ranking_eligibility`。July 只计算有效计分列，September 只计算规则引擎确认的清雷，October 只计算合法西撤和撤退 VP；Allies 使用 Axis 计分威胁和防守指标，不使用己方最东位置作为主要效果指标。命令支持重复 `--baseline`，只有同场景、同外部阵营、同 seed 和 replicate 的 rules-vs-rules 完整日志才会生成配对基准差值。正式排名使用已确认完整且带 benchmark artifact 清单的样本；重试和方法自身 fallback 属于端到端方法的一部分，可以进入排名，但必须同时报告 `sample_status`、传输失败、恢复次数和 fallback 率。部分对局与 Harness 错误仍被排除。`ai:compare` 按 `seed + replicate` 输出配对 VP 差值，异常或重复配对的差值为空。

在提交排名或比较结果前，可以只使用转录日志运行一致性审计：

```bash
pnpm run ai:audit -- log/run1.json log/run2.json \
  --out log/run_audit.json
```

审计器从日志中的 `game_log`、`model_steps`、执行账本、任务结算、artifact manifest 和比较合同重算关键字段。`usable_for_scoring` 表示日志能否独立重算分数；`ranking_eligible` 还会额外检查严格 benchmark 条件，例如工作树是否干净。历史协议的冗余计数不覆盖可重算证据，会以 `legacy_count_summary_mismatch` 警告显示。

`prompt/prompts.yaml` 只保存阵营无关的工具协议、规则上下文和研究指标 Judge PE。完整战略与执行 PE 分别位于 `prompt/axis_prompts.yaml` 和 `prompt/allies_prompts.yaml`，覆盖浏览器外部 AI、手写方法、OpenCode、LangGraph、PydanticAI、阶段意图、单位计划、SAE 战略与分配、任务检查和阵营压缩摘要。启动时会校验当前阵营的完整 PE，缺失字段不会回退到共享战略文本。转录记录 `prompt_profile`、阵营 PE SHA-256、共享 Prompt SHA-256 和完整 Harness Prompt SHA-256。

当前计分上下文版本为 `scenario-scoring-v4-grounded-metrics`，任务进度版本为 `evidence-grounded-model-task-progress-v7-scenario-scoring`。只有 July 使用有效计分列；September 读取规则引擎确认的清雷数，October 读取合法西撤单位与撤退 VP。移动到地标不等于获得 VP，清雷提案被接受也不等于清雷成功。防守计分目标仅在终局结算；checker 不能替代本地规则证据宣布清雷、撤出或拒止任务完成。

artifact 清单记录规则、方法运行时、上下文与记忆、Harness、模型和工具配置、Prompt 及依赖锁文件的 SHA-256；实际选择的 checker profile 同时写入运行配置与比较合同。`ai:compare` 的 `paired_statistics` 保留可排名的方法 fallback 样本，`clean_paired_statistics` 只纳入双方都为 clean 的配对。战斗阶段已有的实验动作预算在日志中显式标记为 `combat_experiment_budget`，它不是兵棋规则，也不适用于移动阶段。本次不改变规则、场景、地图或复杂规则 AI；旧日志保留，不与新 artifact 合并正式排名。

`unit_plan_hybrid` 和 `hierarchical_sae` 在每个移动阶段先生成一次包含全部合资格单位的阶段计划。模型为每个单位选择 `move` 或 `hold`，给出目标和优先级；October 中 `legal_exit_west=true` 的单位还可以选择 `exit_west`。系统按优先级逐个执行，每次执行前用最新局面重新验证路径、堆叠、ZOC、补给和场景限制。目标失效时只修复当前单位，失败后继续处理其他单位。所有单位移动、保持或确认无合法动作后，系统才结束移动阶段；战斗阶段继续使用现有工具决策循环。

`single-action-comparison-v15-grounded-unit-planning` 使用有界的规则验证推荐搜索：每单位、每移动模式默认展开 32 个搜索节点，再对最多 12 个目标作完整战术评估。这是推荐计算预算，不是游戏动作预算，也不代表完整可达集合；模型仍可提出其他目标，由 `act` 规划和验证。已推荐的完整路径会复用，但每次执行前重新验路；单单位修复不再重新规划整支部队。相同局面复用上下文、阶段合法性查询和战术摘要，局面改变后重新计算。剩余单步时间不足 1 秒时不再发送必然超时的 API 请求。

单位计划请求实际包含场景计分、战略目标、任务标题和完成条件、敌军与雷区、补给、上一步效果及压缩记忆。阶段计划是一次 JSON 请求，不在这次请求内开放交互式工具调用；战斗执行仍使用配置工具。无效根 JSON 不能被解释为模型主动全员保持。October 的西撤准备只记部分任务进展，合法撤出才算撤出完成和 VP；掩护任务不会因为文字提到西撤而套用撤出判据。日志区分本地 fallback、模型计划和模型修复，请求统计包含独立 checker；撤出覆盖率只使用有明确资格记录的单位 ID，旧日志缺失时返回空值。

模型任务的目标坐标必须在地图内，`28xx` 等区域描述不能直接作为 `target_hex`。归一化会清除无效坐标并记录修正，保留原始任务文本；推荐计算也会校验缓存中的目标。外部 provider 仅对已分类的坐标、模型协议和传输异常启用方法自身的 fallback，恢复动作仍经过回放规则校验，原始响应与错误保留在同一个步骤记录中。未预期的程序错误继续终止为 `provider_error`，不会伪装成模型失败或改用对手规则 AI。

`hierarchical_sae` 是三层分层策略：每个回合和阵营先由战略模型生成作战意图，再由兵力匹配模型把己方单位分为 spearhead、support、supply、reserve，最后由调度模型逐步调用同一套 rolling_unit_tactical 工具执行具体动作。战略意图和兵力角色在同一回合复用；当前阶段、VP、单位位置和下一项任务每个 step 刷新。规则引擎仍是最终合法性权威，任何上层规划失败都记录为分层 fallback，并使用本地默认计划继续运行。

`hierarchical_sae` 当前使用 `rolling_unit_rules_tactical` 工具 Profile。详细规则不要求全部依赖静态上下文；调度模型可以按需调用只读工具 `inspect_rules`，通过 `topic` 查询 `scoring`、`movement`、`combat`、`supply`、`phase` 或 `stacking`。工具只返回规则投影和当前动态状态，不修改局面；最终动作仍只能通过 `act` 并由本地规则引擎裁决。旧方法继续使用原有工具 Profile，保证历史比较合同不被规则工具加入影响。

多任务模式通过 `--task-management multi_task` 显式启用，旧版 SAE 仍可复现。当前使用 `side-aware-goal-v2`、`side-aware-task-v2` 和 `single-action-comparison-v8-side-aware`。Axis 目标观察 Axis VP、有效计分前沿和突破补给；Allies 的拒止目标观察 Axis 前沿，使用 `subject_side=axis`、`relation=keep_below` 和 `evaluation_scope=game_end`。Allied 单位自身东移不会产生 VP 或完成拒止任务；防守任务在终局前只能维持、受威胁或阻塞，最终成功/失败仅由本地规则状态裁决，任务检查模型无权提前完成。行动评估分别记录自身 VP、对手 VP、Axis 计分威胁、补给风险和兵力保全风险；Allied 移动只有产生可验证的 ZOC 牵制、计分入口封锁或 Axis 补给下降时才算降低威胁。战斗任务读取实际 CRT 结果，只有敌方后退、被消灭或补给恶化才记录任务推进。旧 v7.x 日志仅作为历史数据，不能与 v8 直接排名。

Mock 烟测命令：

```bash
pnpm run ai:full-game -- --scenario july --external-side axis --decision-policy hierarchical_sae --model-profile mock_primary --seed 1942 --max-steps 3 --out log/sae_smoke.json
```

从 `single-action-comparison-v7.7` 开始，模型上下文使用 `scenario-scoring-v3`：提供场景精确计分公式、当前 VP breakdown、下一计分列、下一胜利等级差值、场景感知地图目标和动作预计 VP 增量。July 移动评价在投影局面中重新计算移动后补给，断供的深远推进不再获得虚假 VP 奖励。Opportunity-Aware 筛选在意图匹配攻击被风险规则拒绝后会回填其他合法攻击，避免错误快速 pass。不可重试的 API 4xx 会立即结束当前模型步骤并执行本地 fallback，不再重复调用 20 次。移动阶段采用规则完整终止条件，每个合资格单位每阶段最多成功行动一次；v2 移动协议改为“阶段级统一计划、逐单位顺序执行、每步重新验证”。v7.19 的 Thinking 策略由 `ai/config/ai_models.yaml` 中的模型档案控制：DeepSeek 配置为 `thinking: disabled`，网关自动发送 `thinking: {type: disabled}`；其他模型可以独立配置为 `enabled` 或 `omitted`。执行阶段使用 DeepSeek 兼容的 `tool_choice=auto`，应用层仍要求且校验恰好一个已启用工具调用，并在缺少或多于一个工具调用时重试或 fallback。该协议不再发送 DeepSeek 不兼容的 `required` 或函数对象式强制选择。战略规划、兵力分配、任务检查、LangGraph、OpenCode 和 PydanticAI 均复用模型档案的 Thinking 配置。v7.10 增加场景无关的计分前沿解析、目标候选和自适应重规划；不可达目标的动作反馈包含替代路线。v7.19 结果不能与旧 v7.7-v7.18 日志直接合并排名。完整实验默认步数为 July `1000`、September `1500`、October `3000`；命令行显式传入 `--max-steps` 时覆盖该默认值。旧 v4-v7.6 日志不能与 v7.7 直接合并排名。
# Verified Outcomes v18

See [validation, baseline, and report commands](VERIFIED_OUTCOMES.md) for the
current integrity checks, task evidence, deadline handling, and metric semantics.
