# AI 模块目录

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
pnpm run ai:metrics -- log/run1.json log/run2.json --out log/research_metrics.json
pnpm run ai:metrics -- log/run1.json log/run2.json --judge --judge-model-profile deepseek_flash --out log/research_metrics_with_judge.json
```

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

`config/research_metrics.yaml` 固定论文评估口径。`ai:metrics` 不带 `--judge` 时计算平均 VP、相对场景初始值的 VP 增减、阵营方向校正后的 VP 收益、动作拒绝率和低赔率攻击率；带 `--judge` 时额外按“外部阵营的一回合”评估错失机会严重度和多步计划连贯性，并保存逐窗口证据与 Judge 覆盖率。

`prompt/prompts.yaml` 只保存阵营无关的工具协议、规则上下文和研究指标 Judge PE。完整战略与执行 PE 分别位于 `prompt/axis_prompts.yaml` 和 `prompt/allies_prompts.yaml`，覆盖浏览器外部 AI、手写方法、OpenCode、LangGraph、PydanticAI、阶段意图、单位计划、SAE 战略与分配、任务检查和阵营压缩摘要。启动时会校验当前阵营的完整 PE，缺失字段不会回退到共享战略文本。转录记录 `prompt_profile`、阵营 PE SHA-256、共享 Prompt SHA-256 和完整 Harness Prompt SHA-256。

`unit_plan_hybrid` 在每个移动阶段先生成一次阶段意图，随后通过 `phase_status` 获取阶段开始时的全部合资格单位。模型每次选择一个剩余单位，使用 `act` 提交移动，或使用 `hold_unit` 标记保持；系统执行一个单位动作后更新局面，再进入下一步。只有全部单位移动或保持后，模型才能用 `act(pass)` 结束阶段。战斗阶段继续使用 Opportunity-Aware Hybrid。

`hierarchical_sae` 是三层分层策略：每个回合和阵营先由战略模型生成作战意图，再由兵力匹配模型把己方单位分为 spearhead、support、supply、reserve，最后由调度模型逐步调用同一套 rolling_unit_tactical 工具执行具体动作。战略意图和兵力角色在同一回合复用；当前阶段、VP、单位位置和下一项任务每个 step 刷新。规则引擎仍是最终合法性权威，任何上层规划失败都记录为分层 fallback，并使用本地默认计划继续运行。

`hierarchical_sae` 当前使用 `rolling_unit_rules_tactical` 工具 Profile。详细规则不要求全部依赖静态上下文；调度模型可以按需调用只读工具 `inspect_rules`，通过 `topic` 查询 `scoring`、`movement`、`combat`、`supply`、`phase` 或 `stacking`。工具只返回规则投影和当前动态状态，不修改局面；最终动作仍只能通过 `act` 并由本地规则引擎裁决。旧方法继续使用原有工具 Profile，保证历史比较合同不被规则工具加入影响。

多任务模式通过 `--task-management multi_task` 显式启用，旧版 SAE 仍可复现。当前使用 `side-aware-goal-v2`、`side-aware-task-v2` 和 `single-action-comparison-v8-side-aware`。Axis 目标观察 Axis VP、有效计分前沿和突破补给；Allies 的拒止目标观察 Axis 前沿，使用 `subject_side=axis`、`relation=keep_below` 和 `evaluation_scope=game_end`。Allied 单位自身东移不会产生 VP 或完成拒止任务；防守任务在终局前只能维持、受威胁或阻塞，最终成功/失败仅由本地规则状态裁决，任务检查模型无权提前完成。行动评估分别记录自身 VP、对手 VP、Axis 计分威胁、补给风险和兵力保全风险；Allied 移动只有产生可验证的 ZOC 牵制、计分入口封锁或 Axis 补给下降时才算降低威胁。战斗任务读取实际 CRT 结果，只有敌方后退、被消灭或补给恶化才记录任务推进。旧 v7.x 日志仅作为历史数据，不能与 v8 直接排名。

Mock 烟测命令：

```bash
pnpm run ai:full-game -- --scenario july --external-side axis --decision-policy hierarchical_sae --model-profile mock_primary --seed 1942 --max-steps 3 --out log/sae_smoke.json
```

从 `single-action-comparison-v7.7` 开始，模型上下文使用 `scenario-scoring-v3`：提供场景精确计分公式、当前 VP breakdown、下一计分列、下一胜利等级差值、场景感知地图目标和动作预计 VP 增量。July 移动评价在投影局面中重新计算移动后补给，断供的深远推进不再获得虚假 VP 奖励。Opportunity-Aware 筛选在意图匹配攻击被风险规则拒绝后会回填其他合法攻击，避免错误快速 pass。不可重试的 API 4xx 会立即结束当前模型步骤并执行本地 fallback，不再重复调用 20 次。移动阶段采用规则完整终止条件，每个合资格单位每阶段最多成功行动一次。v7.19 的 Thinking 策略由 `ai/config/ai_models.yaml` 中的模型档案控制：DeepSeek 配置为 `thinking: disabled`，网关自动发送 `thinking: {type: disabled}`；其他模型可以独立配置为 `enabled` 或 `omitted`。执行阶段使用 DeepSeek 兼容的 `tool_choice=auto`，应用层仍要求且校验恰好一个已启用工具调用，并在缺少或多于一个工具调用时重试或 fallback。该协议不再发送 DeepSeek 不兼容的 `required` 或函数对象式强制选择。战略规划、兵力分配、任务检查、LangGraph、OpenCode 和 PydanticAI 均复用模型档案的 Thinking 配置。v7.10 增加场景无关的计分前沿解析、目标候选和自适应重规划；不可达目标的动作反馈包含替代路线。v7.19 结果不能与旧 v7.7-v7.18 日志直接合并排名。完整实验默认 `maxSteps=1000`；旧 v4-v7.6 日志不能与 v7.7 直接合并排名。
