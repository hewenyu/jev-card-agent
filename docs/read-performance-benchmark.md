# Frozen support-query benchmark / 冻结支持事实查询对照

Build first with `npm run build`, then run:

先构建，再对显式指定的 research SQLite 文件运行：

```sh
node scripts/benchmark-advice-reads.mjs /path/to/jev.sqlite.research.sqlite
```

The script opens the source in read-only mode, obtains every support snapshot in one SELECT, then closes the source. Original row IDs, availability, watermarks and payloads are copied to a temporary in-memory database. Both algorithms read this same frozen evidence; the new read-model migration changes only the in-memory copy. Publications and audit tables in the benchmark are empty because this comparison measures only support selection.

脚本只读打开源库，通过一次 SELECT 固定支持事实，随后关闭源连接。保留原始 rowid、可用时间、watermark 和 payload，两种算法在同一内存副本上比较。迁移只作用于内存副本；发布和审计表为空，本对照仅衡量支持事实选择。

The output contains counts, one measurement of each query, migration time and a check that selected IDs match. It does not print payloads, opponent identities or keys and does not load `.env`. This is a RAM-only query comparison, **not HTTP latency, a full bundle benchmark, or production P95**. It excludes source reads, JSON validation and concurrent workload effects. Results from the production host still have these limits.

输出只有数量、两次单次查询耗时、迁移耗时和返回 ID 集合是否一致，不显示 payload、对手身份或密钥，不加载 `.env`。这是内存查询对照，**不是 HTTP 耗时、完整 bundle 性能或线上 P95**，不包含源库读取、JSON 校验和并发负载影响；即使在生产主机执行也应保留这一限制说明。

For a historical cutoff, add `--as-of 2026-09-22T12:00:00.000Z`. When the compiled helper is supplied separately, use `--read-model /path/to/advice-read-model.mjs`. The script exits with status 2 if the ID sets differ. For more than 64 scopes tied at the cutoff, the old query's unspecified tie order can select a different subset; investigate such a mismatch rather than treating timing as acceptance evidence.

历史截止可指定 `--as-of`，单独复制编译文件时可指定 `--read-model`。ID 集合不一致时退出码为 2；当超过 64 个 scope 在截断边界有相同 watermark 时，旧查询未定义的平局顺序可能导致不同子集，需先解释差异，再使用性能结果。
