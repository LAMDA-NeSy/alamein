# Alamein Judge Studio

可复现的阿拉曼三场景兵棋 benchmark 和浏览器判定工具，包含 July、September、October 场景、固定规则引擎、复杂规则 AI、外部模型 Agent 方法、统一工具库、实验日志和指标报告。

## 快速开始

要求：Node.js 18+、pnpm、Python 3.11+、uv。

```bash
pnpm install --frozen-lockfile
uv sync --locked --group dev
pnpm test
uv run --locked --group dev pytest ai/tests
```

默认使用本地 Mock 模型，不需要 API Key。第一次运行建议先做短烟测：

```bash
pnpm run ai:full-game -- \
  --scenario july \
  --external-side axis \
  --decision-policy hierarchical_sae \
  --task-management multi_task \
  --model-profile mock_primary \
  --task-checker-model-profile mock_secondary \
  --seed 1942 \
  --max-steps 20 \
  --out log/smoke_july_axis.json
```

日志默认写入 `log/`，该目录不提交到 Git。

## 运行网页

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

打开 <http://127.0.0.1:8000/>。网页应用不需要数据库或构建步骤。

## 模型配置

模型档案位于 `ai/config/ai_models.yaml`：

| Profile | 用途 | API Key |
| --- | --- | --- |
| `mock_primary` | 离线主模型 | 不需要 |
| `mock_secondary` | 离线任务检查模型 | 不需要 |
| `glm_53_flash_coding_plan` | GLM-5.3-Flash Coding Plan | `ZHIPU_CODING_API_KEY` |
| `glm_53_flash_checker` | 独立 GLM 任务检查模型 | `ZHIPU_CODING_API_KEY` |
| `glm_53_flash_api` | 普通计费 API | `ZHIPU_API_KEY` |
| `glm_53_flash_api_checker` | 普通计费 API 的独立任务检查模型 | `ZHIPU_API_KEY` |
| `deepseek_flash` | DeepSeek Flash | `DEEPSEEK_API_KEY` |
| `claude_opus_51` | Claude Opus 5.1 | `ANTHROPIC_API_KEY` |
| `gpt_6` | GPT 6 | `OPENAI_API_KEY` |
| `kimi_k3` | Kimi K3 示例配置 | `KIMI_API_KEY` |
| `kimi_k3_checker` | Kimi K3 独立任务检查模型 | `KIMI_API_KEY` |

真实模型只在命令行显式指定。配置密钥：

```bash
cp .env.example .env
```

然后编辑 `.env`，只填写自己使用的变量。不要提交 `.env`、真实请求、真实响应或 `log/`。GLM-5.3-Flash 的 thinking 和 reasoning 配置由模型档案控制，不要在命令行强行覆盖。

## 给同学的运行清单

完整操作说明见 [实验交接手册](ai/EXPERIMENT_HANDOFF.md)，包括环境安装、密钥配置、Mock 预检、多模型后台双并发、单局、baseline、日志审计、Judge 和结果打包。

当前实验代码在 `codex/publish-alamein-org` 分支，不能直接使用尚未同步的 `main`：

```bash
git clone --branch codex/publish-alamein-org https://github.com/LAMDA-NeSy/alamein.git
cd alamein
pnpm install --frozen-lockfile
uv sync --locked --group dev
pnpm test
uv run --locked --group dev pytest ai/tests
```

六局验收中的 `--concurrency 2` 是三场景双方共六局、最多两局同时运行，不是只跑 July 两局。下面显式使用普通计费 API，主模型和 checker 均使用 `ZHIPU_API_KEY`：

```bash
pnpm run ai:acceptance -- \
  --out-dir log/sae_glm53_api_$(date +%Y%m%d_%H%M%S) \
  --model-profile glm_53_flash_api \
  --task-checker-model-profile glm_53_flash_api_checker \
  --concurrency 2
```

后台运行请使用手册中的 `ai:models --background`，不依赖终端的 `&` 保活。不要提交 `.env` 或 `log/`；所有运行使用新目录，不自动切换计费通道或重跑。

## 我们的方法和 Harness

本项目自己的 SAE 方法使用 `manual_single_action` 运行器，入口是 `ai/experiments/external_ai_full_game_transcript.js`。OpenCode、LangGraph 和 PydanticAI 是可选 Harness，不等同于 SAE 方法本身。

SAE 流程是：战略模型生成目标，Goal Manager 结构化目标，Task Manager 管理任务树，兵力分配模型分配角色，执行模型按阶段逐个执行动作，规则桥验证每个动作，任务检查模型评估进展。规则引擎始终是最终合法性判定者。

单局真实模型示例：

```bash
pnpm run ai:full-game -- \
  --scenario july \
  --external-side axis \
  --decision-policy hierarchical_sae \
  --task-management multi_task \
  --model-profile glm_53_flash_coding_plan \
  --task-checker-model-profile glm_53_flash_checker \
  --tool-profile rolling_unit_rules_tactical \
  --seed 1942 \
  --replicate 1 \
  --step-timeout-ms 180000 \
  --max-steps 1000 \
  --out log/july_axis_glm53.json
```

Allies 运行时将 `--external-side axis` 改为 `--external-side allies`。建议步数上限为 July `1000`、September `1500`、October `3000`。

## 六局完整验收

一次串行运行三场景、双方各一局：

```bash
pnpm run ai:acceptance -- \
  --out-dir log/sae_acceptance_glm53_$(date +%Y%m%d) \
  --model-profile glm_53_flash_coding_plan \
  --task-checker-model-profile glm_53_flash_checker \
  --concurrency 1
```

固定配置为 seed `1942`、`hierarchical_sae`、`rolling_unit_rules_tactical`、复杂规则 AI 对手和 180 秒单步超时，运行顺序为：

```text
July Axis -> July Allies -> September Axis -> September Allies -> October Axis -> October Allies
```

每次批次必须使用新的 `--out-dir`。程序不会覆盖已有日志、切换普通 API 或重复付费重跑。Mock 六局可以并行验证链路：

```bash
pnpm run ai:acceptance -- \
  --out-dir log/sae_acceptance_mock \
  --model-profile mock_primary \
  --task-checker-model-profile mock_secondary \
  --concurrency 6
```

## 多模型实验启动

每项包含主模型和独立 checker。默认 `ai/config/model_suites.yaml` 是离线 Mock；建议将 `ai/config/model_suites.example.yaml` 复制到忽略的 `log/model_suites.local.yaml`，通过 `--config` 和 `--models` 显式选择要跑的模型，避免修改已跟踪配置造成 dirty 工作树。在本机 `.env` 提供对应 API Key。脚本会为每个模型创建独立目录和 manifest，不覆盖已有结果。

先做不调用 API 的配置与凭据预检：

```bash
pnpm run ai:models -- \
  --config ai/config/model_suites.yaml \
  --out-dir log/model_suite_preview \
  --dry-run
```

脚本也可以直接从仓库根目录调用：

```bash
./scripts/run-model-suite.sh --config ai/config/model_suites.yaml \
  --out-dir log/model_suite_$(date +%Y%m%d_%H%M%S)
```

运行多个模型。`--concurrency` 是模型批次并发数，`--case-concurrency` 是每个模型内部六局并发数；真实模型建议先使用 `1`，确认额度和限流策略后再提高：

```bash
pnpm run ai:models -- \
  --config ai/config/model_suites.yaml \
  --out-dir log/model_suite_$(date +%Y%m%d_%H%M%S) \
  --concurrency 1 \
  --case-concurrency 1
```

后台运行以及查看状态：

```bash
pnpm run ai:models -- --config ai/config/model_suites.yaml \
  --out-dir log/model_suite_$(date +%Y%m%d_%H%M%S) --background
pnpm run ai:models -- --status log/model_suite_YYYYMMDD_HHMMSS
```

常用真实模型配置示例（不要把密钥写入 YAML）：

```yaml
version: 1
models:
  - id: glm53
    model_profile: glm_53_flash_coding_plan
    checker_model_profile: glm_53_flash_checker
  - id: deepseek
    model_profile: deepseek_flash
    checker_model_profile: deepseek_flash_checker
  - id: kimi-k3
    model_profile: kimi_k3
    checker_model_profile: kimi_k3_checker
```

Kimi K3 当前只作为显式 opt-in 示例加入。使用前请根据飞书实验表或实际服务协议核对模型 ID、endpoint 和计费渠道；若使用中转服务，只需在本地未跟踪的模型注册表中同步修改对应 profile，不要把密钥写入 YAML。

Kimi K3 单局示例（July，Axis SAE 对阵复杂规则 AI）：

```bash
pnpm run ai:full-game -- \
  --scenario july \
  --external-side axis \
  --decision-policy hierarchical_sae \
  --task-management multi_task \
  --model-profile kimi_k3 \
  --task-checker-model-profile kimi_k3_checker \
  --tool-profile rolling_unit_rules_tactical \
  --seed 1942 \
  --replicate 1 \
  --step-timeout-ms 180000 \
  --max-steps 1000 \
  --out "log/kimi_k3_july_axis_$(date +%Y%m%d_%H%M%S).json"
```

Kimi K3 三场景、双方各一局示例：

```bash
pnpm run ai:acceptance -- \
  --out-dir "log/kimi_k3_six_$(date +%Y%m%d_%H%M%S)" \
  --model-profile kimi_k3 \
  --task-checker-model-profile kimi_k3_checker \
  --concurrency 1
```

或者使用模型套件入口，只选择 Kimi，避免误跑示例中的其他模型：

```bash
pnpm run ai:models -- \
  --config ai/config/model_suites.example.yaml \
  --models kimi-k3 \
  --out-dir "log/kimi_k3_suite_$(date +%Y%m%d_%H%M%S)" \
  --concurrency 1 \
  --case-concurrency 1
```

实验日志从命令的 `--out` 或 `--out-dir` 获取。单局日志就是指定的 JSON 文件；六局批量则在输出目录下按场景和阵营生成六个 JSON，并同时生成 `suite_manifest.json`、每个模型目录的 `batch_manifest.json`、`model_steps.jsonl`、`state_snapshots.jsonl` 和控制台日志。常用查看命令：

```bash
ls -lt log/
jq '{status,summary,counts,model_usage,ranking_eligibility}' log/kimi_k3_july_axis_*.json
find log/kimi_k3_suite_* -maxdepth 3 -type f | sort
```

`log/` 默认被 `.gitignore` 忽略，不会随代码上传；把结果交给其他同学时，应提供完整实验输出目录和对应 commit，不要提供 `.env`。

## 批量实验与 Baseline

规则 AI baseline 使用双方规则 AI，并固定场景、seed 和 replicate：

```bash
pnpm run ai:full-game -- \
  --scenario july \
  --axis-controller rules_ai \
  --allies-controller rules_ai \
  --model-profile mock_primary \
  --seed 1942 \
  --replicate 1 \
  --max-steps 1000 \
  --out log/july_rules_vs_rules_1942.json
```

论文建议比较：

1. `Rules AI vs Rules AI`：规则基准。
2. `Direct`：模型直接调用 `act`。
3. `Hybrid`：阶段意图加动作执行。
4. `Opportunity-Aware Hybrid`：加入规则验证的战术机会。
5. `Hierarchical SAE`：完整战略、任务、分配、执行和反馈系统。
6. SAE 消融：去掉任务系统、路线建议、动作后反馈、reasoning memory 或机会账本。

批量示例：

```bash
pnpm run ai:batch -- \
  --scenario july \
  --external-side axis \
  --decision-policies direct,hybrid,hierarchical_sae \
  --model-profiles mock_primary \
  --seeds 1942,1943,1944 \
  --replicates 3 \
  --out-dir log/july_method_batch
```

严格方法对比必须固定场景、阵营、对手、模型、Harness、工具、Prompt、预算和规则 artifact。条件不同只能作为系统能力对比，不能混入严格排名。

## 指标报告

```bash
pnpm run ai:metrics -- \
  log/july_axis.json log/july_allies.json \
  log/september_axis.json log/september_allies.json \
  log/october_axis.json log/october_allies.json \
  --out log/all_scenarios_metrics.json
```

默认不调用 Judge，相关指标标为未评估。`--judge --judge-model-profile mock_secondary` 仅用于离线验证评分协议，不能作为论文 Judge 分数；真实评分须显式指定真实 Judge 档案，会额外调用 API。报告包含 VP、VP 增量、动作拒绝率、fallback、网络失败、Token、缓存、延迟、任务、机会、场景指标和排名资格。July 使用计分推进指标，September 使用清雷指标，October 使用合法西撤指标；Allies 使用 Axis 计分威胁和防守指标。

与规则 baseline 配对比较：

```bash
pnpm run ai:metrics -- \
  log/july_axis_glm53.json \
  --baseline log/july_rules_vs_rules_1942.json \
  --out log/july_metrics_with_baseline.json
```

重试和 SAE 自身 fallback 属于端到端方法的一部分，可以保留在端到端排名；网络受影响样本会单独标记，并从 clean 子集排除。`ranking_eligibility_reasons` 会说明 artifact 过期、合同不一致、非法动作或未完成对局等原因。

## 代码结构

- `docs/el_alamein_rules_cn_translation.md`：权威规则文本。
- `rule_engine.js`：浏览器和 Node 共用的规则引擎。
- `rules_el_alamein.json`、`terrain.json`、`scenarios/`：规则、地图和场景数据。
- `ai/config/`：模型、方法、工具和指标配置。
- `ai/core/`：模型网关、上下文、任务系统、规则桥、账本和 benchmark 合同。
- `ai/prompt/`：共享协议 Prompt 和 Axis/Allies 专属 PE。
- `ai/experiments/`：完整对局、批处理、验收和指标报告。
- `ai/harnesses/`：OpenCode、LangGraph、PydanticAI Harness。
- `ai/tests/`：Node 和 Python 测试。
- `log/`：本地生成的转录和报告，不提交真实实验数据。

## 常见问题

- **缺少 API Key**：检查 `.env` 中与 model profile 对应的变量。
- **输出文件已存在**：使用新的 `--out` 或 `--out-dir`，程序不会覆盖旧结果。
- **网络失败**：模型档案按各自配置重试；最终失败会记录原因并使用 SAE fallback，不会绕过规则引擎。
- **排名为 0**：查看每局的 `ranking_eligibility_reasons`。常见原因是 benchmark artifact 过期、工作树未提交、合同不一致或对局未完成。
- **只想验证系统链路**：使用 Mock；Mock 不用于声明战术能力。

## 规则版本

### SAE 场景任务

三个场景共享任务状态、依赖、分配、执行反馈和验收框架，但不共享计分目标：July 观察有效补给下的最东 Axis 计分列，September 观察实际清雷，October 观察合法西撤。

SAE 默认启用 `scoring_anchor_policy: july_terminal_v1`，仅用于 July Axis。它在六个任务槽位中保留一个本地只读监测项，模型可提出五个执行任务。监测项不分配单位、不占用三个执行任务名额，也不禁止任何规则合法动作。配置为 `none` 可关闭它。

监测记录“接近、已到达但补给不足、当前有效计分、已丢失”，并保留实际达到的最高有效计分列。失守产生一次 `scoring_anchor_lost` 重规划事件；恢复后再次失守是新事件。历史跨重规划保留，只有终局才结算，不将暂时到达当作已经锁定的 VP。模型仍自主权衡补给、支援、进一步推进或其他 VP 收益，没有固定单位、目标格、路线或攻击组合。

模型任务完成率不统计此监测项；完整证据保留在任务日志和最终结算中。新策略写入比较合同，不能将关闭监测的旧运行当作相同配置直接合并。

每局 artifact manifest 会记录规则、地图、场景、复杂规则 AI、方法运行时、Prompt 和依赖锁文件的 SHA-256。规则修改必须发布新的 benchmark 版本，旧日志不能与新版本直接排名。

本仓库包含网页判定工具和 AI benchmark，不包含 Vassal 模块、Vassal 转换工具或 `.vmod` 资产。
