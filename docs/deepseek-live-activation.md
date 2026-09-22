# DeepSeek live research activation / DeepSeek 异步研究启用

## Model and operation / 模型与运行方式

The API identifier is `deepseek-flash`. DeepSeek-V4.1-Flash is the product name; a request using the product name literally was rejected. The canonical API identifier succeeded through the dedicated DeepSeek Messages provider. Production research uses the official `https://api.deepseek.com/anthropic` endpoint, thinking disabled, and at most three retries after the initial attempt. Credentials remain in the private server environment.

API 模型名使用 `deepseek-flash`；DeepSeek-V4.1-Flash 是产品名称。专用 DeepSeek Messages provider 已实测成功。生产环境关闭思考，保留首次请求后的最多三次重试，密钥仅保存在私有服务器环境中。

Jev remains the sole live action selector. The independent DeepSeek worker researches completed evidence, publishes approved scoped evidence templates, and its inference is not awaited by the action loop. New hands pin the available knowledge version; existing hands and historical requests are preserved. Research availability, publication and actual request adoption are separate measurements.

Jev 继续负责每次实时动作。DeepSeek 独立研究已完成牌局，发布经过模板审核、限定适用范围的证据摘要，不阻塞出牌。新手牌固定当时可用的知识版本；既有手牌与历史请求不改写。调用成功、建议发布与实际采用分别验收。

## Four-street template correction / 四街摘要修正

The first two real opponent proposals both referenced preflop/flop/turn/river action counts. The v1 fixed wording plus all four metric labels produced 354–356 characters, beyond the unchanged 300-character per-item projection limit. A published item could therefore never be consumed, even when its opponent matched.

前两次真实对手提案都引用四街行动统计。v1 固定文案加上指标名称达到 354–356 字符，超过每条 300 字符限制；因此即使对手匹配，建议也不能进入 Jev 输入。

The correction uses an explicitly versioned `opponent-evidence-v2` template with compact wording. It retains every referenced count and the limits of observed action frequencies. It does not truncate evidence, expand the input limit or adopt generated free-text strategy. A publication-time size check keeps oversized recipe proposals pending. V1 approval does not authorize V2; the operator reviews and approves V2 independently. Existing publications, hashes, hand pins and exact requests remain unchanged.

修复采用明确版本号 `opponent-evidence-v2` 和精简固定文案，完整保留所引用的统计与解释限制。不截断证据，不扩大输入上限，不自动采用模型自由文本策略。模板发布前检查长度，超长提案保留待处理。v1 的审批不会自动授权 v2；v2 需单独审核。已有发布记录、哈希、手牌绑定及完整请求保持原样。

## Executed evidence / 已执行的证据

On 2026-09-22 UTC, the initial canonical-model diagnostic succeeded in 2,969 ms. After the 1.3.0 configuration was activated, background leak review and opponent research succeeded in 1,794 ms and 3,025 ms respectively, without retries. Leak review reported insufficient evidence; opponent research published one v1 template. These observations establish transport and publication behavior, not advice adoption or profitability. Deployment verification for the template correction is recorded after execution.

2026-09-22 UTC，规范模型名的首次诊断耗时 2,969 ms。1.3.0 启用后，两次后台分析分别耗时 1,794 ms 与 3,025 ms，均首次成功。全局复盘返回证据不足，对手研究发布了一条 v1 模板。以上只能证明调用与发布链路，不能代表实际采用或盈利；模板修复后的部署验证将在执行后补充。

## Correction validation / 修复验证

Local `npm run check` passed for 1.3.1: 505 tests across 66 files, ESLint, formatting, TypeScript, production build and repository checks. Five added regression cases cover complete four-street evidence in the serialized Jev request, v1/v2 approval isolation, oversized publication rollback, Unicode accounting and preservation of existing publication/bundle bytes. Provider responses in these regression cases are controlled fixtures, not additional live calls.

1.3.1 本地 `npm run check` 已通过：66 个文件中的 505 项测试，以及 lint、格式、TypeScript、生产构建和仓库检查。新增回归验证四街证据完整进入实际序列化 Jev 请求、版本审批隔离、超长发布回滚、Unicode 字符计数及既有记录保留；这些测试使用受控模型响应，不冒充新的线上调用。
