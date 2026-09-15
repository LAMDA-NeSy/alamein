# 实验交接手册

所有命令从仓库根目录执行，适用于 macOS / Linux；Windows 建议使用 WSL。各节是不同操作，真实运行示例不要全部重复执行。

## 1. 获取相同版本与安装

需要 Node.js 18+、pnpm、Python 3.11+、uv。当前实验分支为 `codex/publish-alamein-org`，不是 `main`。参与同一组比较的机器应固定相同 commit，运行中不要拉取或修改代码。

```bash
git clone --branch codex/publish-alamein-org https://github.com/LAMDA-NeSy/alamein.git
cd alamein
git rev-parse HEAD
git status --short
pnpm install --frozen-lockfile
uv sync --locked --group dev
pnpm test
uv run --locked --group dev pytest ai/tests
```

拿到已有代码目录时不必重新 clone。保留 `.git`，不要只传没有版本信息的源码压缩包。正式运行前 `git status --short` 应为空；密钥和本地批次配置放在忽略目录，不要修改已跟踪文件。

## 2. 配置密钥和模型

下面只在 `.env` 不存在时创建，不会覆盖现有密钥：

```bash
test -f .env || cp .env.example .env
mkdir -p log
test -f log/model_suites.local.yaml || cp ai/config/model_suites.example.yaml log/model_suites.local.yaml
```

在本机编辑 `.env` 填入对应变量。不要把值写进命令行、YAML、聊天或提交到 Git。

| 选择 ID | 主模型 Profile | 独立 Checker Profile | 密钥变量 / 计费通道 |
| --- | --- | --- | --- |
| `mock` | `mock_primary` | `mock_secondary` | 无密钥，本地离线 |
| `glm53-api` | `glm_53_flash_api` | `glm_53_flash_api_checker` | `ZHIPU_API_KEY`，普通计费 API |
| `glm53-coding-plan` | `glm_53_flash_coding_plan` | `glm_53_flash_checker` | `ZHIPU_CODING_API_KEY`，Coding Plan |
| `deepseek` | `deepseek_flash` | `deepseek_flash_checker` | `DEEPSEEK_API_KEY` |
| `glm47` | `glm_47_flash` | `glm_47_flash_checker` | `ZHIPU_API_KEY` |

Profile 的 URL、模型名、thinking、超时和重试策略统一在 `ai/config/ai_models.yaml`。独立 checker 是独立配置和独立请求，不要求另一个供应商或另一把密钥。若增加新模型，先由项目维护者提交主模型和 checker 配置，所有同学同步同一 commit 后再跑。

`log/model_suites.local.yaml` 可以只保留需要的模型；也可以保留示例，使用 `--models` 显式选择。**不要对含多个真实模型的示例省略 `--models`，否则会运行配置中的全部模型。**

## 3. 离线预检

短烟测不访问真实 API。20 步只是检查链路，不是完整对局，也不能进入正式排名：

```bash
pnpm run ai:full-game -- \
  --scenario july --external-side axis \
  --decision-policy hierarchical_sae --task-management multi_task \
  --model-profile mock_primary --task-checker-model-profile mock_secondary \
  --tool-profile rolling_unit_rules_tactical \
  --seed 1942 --max-steps 20 \
  --out "log/smoke_july_axis_$(date +%Y%m%d_%H%M%S).json"
```

完整 Mock 验收（六局并行，不收费，CPU 和内存开销较大）：

```bash
pnpm run ai:acceptance -- \
  --out-dir "log/mock_six_$(date +%Y%m%d_%H%M%S)" \
  --model-profile mock_primary --task-checker-model-profile mock_secondary \
  --concurrency 6
```

Mock 只验证工具、协议、规则桥、日志和回放，不评价模型战术能力。

## 4. 多模型后台运行：最多两局并发

以下示例选择普通计费 GLM API。使用 Coding Plan 时，只把 `MODELS` 改为 `glm53-coding-plan`；测试多个模型可用 `glm53-api,deepseek`。不要自动切换计费通道。

```bash
MODELS="glm53-api"
SUITE_DIR="log/model_suite_$(date +%Y%m%d_%H%M%S)"
pnpm run ai:models -- \
  --config log/model_suites.local.yaml --models "$MODELS" \
  --out-dir "$SUITE_DIR" --concurrency 1 --case-concurrency 2 --dry-run
```

`--dry-run` 验证配置和本地凭据是否存在，不发送模型请求，不能证明服务端额度和网络一定可用。预检成功后只执行一次：

```bash
pnpm run ai:models -- \
  --config log/model_suites.local.yaml --models "$MODELS" \
  --out-dir "$SUITE_DIR" --concurrency 1 --case-concurrency 2 --background
```

- `--concurrency 1`：一次运行一个模型批次。
- `--case-concurrency 2`：该模型最多两局同时运行；总体最多两局，不是每个模型各开两局。
- 每个模型跑 **July、September、October × Axis、Allies，共六局**；不是两局，也不是模型自己左右互搏。每局都是 SAE 对阵前端同款复杂规则 AI。
- 固定 seed `1942`、replicate `1`、`manual_single_action`、`hierarchical_sae`、`multi_task`、`rolling_unit_rules_tactical` 和单步 180 秒；步数上限分别 1000 / 1500 / 3000。工具预算沿用方法配置。
- 先启动 July 双方，某个空位释放后启动下一个待运行场景；不保证两个同场景对局同时结束。
- 进程脱离终端，macOS 子局使用进程级防自动休眠；仍须保持电脑开机、供电和联网，合盖或关机不能保证继续运行。
- 每次使用新目录；没有自动重复付费重跑、Coding Plan 到普通 API 的切换或真实 Judge 调用。

返回的 PID 只是启动器信息。用下面命令确认 `suite_manifest.json` 和模型目录下的 `batch_manifest.json` 已生成，而不是把启动器退出当作实验结束：

```bash
pnpm run ai:models -- --status "$SUITE_DIR"
cat "$SUITE_DIR/glm53-api/batch_manifest.json"
```

Coding Plan 的子目录是 `glm53-coding-plan`，其他模型使用相应 ID。`cases` 给出各局状态、PID、精确输出路径和 console 路径。发生失败时保留完整目录，先检查原因，不要立即重复整批。

## 5. 只跑单个场景 / 阵营

这一节替代六局批次，不要在六局正在运行时重复启动。以下是一局 July Axis 普通计费 API，另一方自动使用 `rules_ai`：

```bash
pnpm run ai:full-game -- \
  --scenario july --external-side axis \
  --decision-policy hierarchical_sae --task-management multi_task \
  --model-profile glm_53_flash_api \
  --task-checker-model-profile glm_53_flash_api_checker \
  --tool-profile rolling_unit_rules_tactical \
  --seed 1942 --replicate 1 --step-timeout-ms 180000 --max-steps 1000 \
  --out "log/july_axis_glm53_api_$(date +%Y%m%d_%H%M%S).json"
```

更改 `--external-side allies` 测试防守方；更改场景时同步设置 `--max-steps`。`max_steps` / 部分对局不等于终局成功。完整结果须有 `status=final_victory` 和 `summary.victory.final=true`。

## 6. Baseline 和重复实验

规则基准不调用真实模型，每个 seed / replicate 生成三场景的 `rules_ai vs rules_ai` 对局：

```bash
BASE_DIR="log/rules_baselines_$(date +%Y%m%d_%H%M%S)"
pnpm run ai:baselines -- --out-dir "$BASE_DIR" --seed 1942 --replicate 1
```

建议论文对照为 Direct、Hybrid、Opportunity-Aware Hybrid、SAE，以及独立的 OpenCode / LangGraph / PydanticAI 系统。以下是 July Axis 方法批次示例，**会产生 4 × 3 × 3 = 36 局付费实验**，仅在预算与实验矩阵确认后运行；该入口串行，不是上述六局诊断的必要步骤：

```bash
pnpm run ai:batch -- \
  --scenario july --external-side axis \
  --decision-policies direct,hybrid,opportunity_aware_hybrid,hierarchical_sae \
  --model-profiles glm_53_flash_api \
  --task-checker-model-profile glm_53_flash_api_checker \
  --tool-profile rolling_unit_rules_tactical \
  --seeds 1942,1943,1944 --replicates 3 \
  --step-timeout-ms 180000 --max-steps 1000 \
  --out-dir "log/july_methods_$(date +%Y%m%d_%H%M%S)"
```

不要给这个混合方法命令统一加 `--task-management multi_task`；只有 SAE 支持它，其他方法使用自己的默认配置。上述各方法提示词和内部系统不同，默认解释为系统能力比较；严格方法排名仍须比较合同校验。改变主模型时若 checker 也改变，报告同样应披露，不能全部归因为主模型。

六局各一次仅用于诊断，不代表显著提升。论文重复实验需按每个场景、阵营、seed、replicate 配对，固定对手、版本和预算；规则 baseline 也须使用对应 seed / replicate。

## 7. 日志审计与评分

六局批次结束后自动生成 `all_scenarios_metrics.json`，不调用真实 Judge。以下命令用于人工重算；先把 `BATCH_DIR` 指向已结束的某个模型目录：

```bash
BATCH_DIR="$SUITE_DIR/glm53-api"
pnpm run ai:audit -- "$BATCH_DIR"/*__axis-*.json --out "$BATCH_DIR/audit.json"
pnpm run ai:metrics -- "$BATCH_DIR"/*__axis-*.json \
  --out "$BATCH_DIR/metrics_recomputed_$(date +%Y%m%d_%H%M%S).json"
```

`*__axis-*.json` 只匹配此批次的对局转录；不要使用 `*.json` 混入清单、指标报告或审计报告。单局命令使用自定义文件名时，应直接传该完整文件路径。

生成与规则基准的配对差值（`BASE_DIR` 指向上节基准目录）：

```bash
pnpm run ai:metrics -- "$BATCH_DIR"/*__axis-*.json \
  --baseline "$BASE_DIR/july.json" \
  --baseline "$BASE_DIR/september.json" \
  --baseline "$BASE_DIR/october.json" \
  --out "$BATCH_DIR/metrics_with_baseline_$(date +%Y%m%d_%H%M%S).json"
```

查看 `usable_for_scoring`、`ranking_eligible`、`issues`、`warnings` 和 `ranking_eligibility_reasons`。能从日志重算分数不等于满足正式排名条件。任务 checker 也不等于离线 Judge；原始 VP、端到端、pure-model 和 clean 指标不能互相替代。

真实 Judge 评分是额外付费步骤，各模型应使用同一 Judge 档案与 rubric。预算确认后再执行，例如：

```bash
pnpm run ai:metrics -- "$BATCH_DIR"/*__axis-*.json \
  --judge --judge-model-profile deepseek_flash_checker \
  --out "$BATCH_DIR/metrics_judge_$(date +%Y%m%d_%H%M%S).json"
```

没有真实 Judge 时对应指标标为未评估。`mock_secondary` 只测试评分协议，不能作为论文评分。

## 8. 发回哪些文件

保留整个实验目录：suite / batch 清单、每局 JSON、同名上下文目录中的 `model_steps.jsonl`、`state_snapshots.jsonl`、API 请求响应记录、console 和最终报告。不要只发 VP 截图；失败和部分对局同样保留。规则 baseline 目录一并发回。

另提供所用 commit、模型 ID、checker ID、计费通道、机器环境及是否中途休眠/断网。可在双方授权的私下渠道打包整个 `SUITE_DIR` 和 `BASE_DIR`；先检查日志是否含自定义私密提示词或供应商信息，不要包含 `.env`，不要公开上传真实日志。

```bash
tar -czf "alamein_results_$(date +%Y%m%d_%H%M%S).tar.gz" "$SUITE_DIR" "$BASE_DIR"
```

本地代码保持不变，实验日志默认不提交 Git。中途发现问题先反馈，重新运行必须明确记录原因并使用新目录，不能用重跑筛选结果。
