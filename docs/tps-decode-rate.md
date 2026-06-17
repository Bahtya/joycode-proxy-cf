# 解码速率（TPS）回归估计方案

> 适用：joycode-proxy-cf（Cloudflare Pages + Functions + D1）仪表盘「响应质量 → 解码 TPS」卡片。
> 目的：在**无法逐请求直接观测解码耗时**的前提下，用线性回归从历史请求中统计估计模型的**真实解码（生成）速率**，并扣除网络/排队/预填充开销。

---

## 1. 摘要

本服务代理 JoyCode（GLM 等）模型，仪表盘需要一个可信的「模型生成速度」指标。朴素口径全部失败：基于 SSE chunk 时长的统计给出 **17.6 万 tok/s**（后台 drain 读缓冲）或 **~1700 tok/s**（上游网关突发投递，非解码速率）；`output_tokens / latency` 给出 **~30 tok/s**（含 RTT/排队/预填充，偏低）。

真实解码耗时不可逐请求观测，但其**速率**可被反推：端到端延迟线性分解为 `latency = 固定开销 + 预填充(input) + 解码(output)`。对历史流式请求做 `latency_ms ~ input_tokens + output_tokens` 的普通最小二乘（OLS）回归，**输出项系数 β_out（ms/输出 token）即解码 per-token 耗时**，故 `解码速率 = 1000 / β_out`。

对生产 611 条流式请求拟合得 `β_out ≈ 25.8 ms/tok` → **解码速率 ≈ 38.7 tok/s**（今日 352 条得 38.2，一致），并同步得到固定开销 `β0 ≈ 3549 ms`、预填充速率 `≈ 0.089 ms/输入 token`（≈ 1.1 万 tok/s）。该法对网关「突发投递」鲁棒——线性关系不依赖交付模式。

---

## 2. 问题与目标

仪表盘「响应质量」区需要一项反映**模型本身快慢**的指标。直接可量的只有端到端 `latency_ms` 与 `usage.{input,output}_tokens`，但 `latency` 混合了网络、排队、预填充、解码、交付多种成分，无法直接读出「解码速率」。目标是：**在只有 (latency, input_tokens, output_tokens) 三个观测量、且解码耗时不可直接拆出的约束下，估计出真实的解码 token 速率（tok/s）**。

---

## 3. 背景：LLM 推理延迟的构成

理解指标的前提是先理解自回归（autoregressive）语言模型一次推理的内部结构。

### 3.1 两阶段生成

一次 chat completion 在服务端分两个计算阶段：

| 阶段 | 处理对象 | 计算特征 | 耗时主导项 | 典型速率 |
|---|---|---|---|---|
| **预填充 Prefill**（prompt processing） | 输入 prompt 的全部 token | **算力密集（compute-bound）、高度并行**：一次性并行算出所有输入 token 的注意力 | `input_tokens` | 很快（本数据 ≈ 1.1 万 tok/s） |
| **解码 Decode**（generation） | 逐个输出的 token | **访存带宽受限（memory-bandwidth-bound）、串行**：每生成 1 个 token 都要读取此前全部的 KV cache | `output_tokens` | 慢（本数据 ≈ 38 tok/s） |

预填充的产物是 **KV cache**（每层的 Key/Value 缓存），解码阶段每步都依赖它，因此解码是**串行访存**——这是解码比预填充慢一到两个数量级的根本原因（解码速率受显存带宽限制，而非算力）。

> 旁注：在连续批处理（continuous batching）下，服务端会把多个请求的解码步合并成一批以摊薄访存，但这只影响**绝对速率**，不改变「解码耗时 ∝ output_tokens」的线性结构。

### 3.2 关键延迟量

- **TTFT（Time-To-First-Token，首 token / 首字节延迟）**：从发出请求到收到第一个生成 token 的时间。它 ≈ `网络 RTT + 排队 + 预填充`。决定了用户主观上「多快开始吐字」。
- **解码速率（decode rate, tok/s）**：生成阶段每秒产出的 token 数，即 `output_tokens / 解码耗时`。这是用户主观上「字蹦得多快」、也是模型**生成能力**的核心指标——本方案要测的就是它。
- **端到端延迟（latency）**：`latency ≈ RTT + 排队 + 预填充(input) + 解码(output) + 交付`。

### 3.3 为何选「解码速率」而非总吞吐

总吞吐（`总 token / 总时间`）或含 TTFT 的均值会被预填充/TTFT 严重稀释（长 prompt、高 TTFT 会拉低数值），无法反映「模型生成有多快」。解码速率剥离了这些与生成能力无关的开销，是更有意义的工程指标。

---

## 4. 本部署的测量约束：为何解码耗时不可逐请求观测

本服务部署在 **Cloudflare Pages + Functions（Workers 运行时）+ D1**，把 Anthropic/OpenAI 协议翻译成 JoyCode 协议，上游是 JoyCode **彩网关 `api-ai.jd.com`**（HMAC 签名）。每条请求落库到 `request_logs`：`latency_ms, input_tokens, output_tokens, stream, tps, created_at`（schema 见 `migrations/0001_init.sql` + `0008_tps.sql`）。

流式响应在代理内以单个 `ReadableStream` 消费上游 body（`functions/v1/chat/completions.ts`、`functions/v1/messages.ts`）。问题在于：**代理侧拿不到「解码阶段」的边界时间戳**。三种朴素口径逐一失败：

| 口径 | 结果 | 失败原因 |
|---|---|---|
| chunk 时长（后台 drain 分支） | **176,000 tok/s** | drain 在 `waitUntil` 里、等客户端消费完才跑，读的是 tee 后**已积压的整段缓冲**，首末 chunk 间隔被压到 ~1ms |
| chunk 时长（实时单消费者读） | **~1,700 tok/s** | 彩网关**突发投递整段响应**（非按解码速率流式）。证据：30 tok→15ms、485 tok→287ms，到达速率恒定 ~1700 tok/s——这对解码不可能（GLM 解码 ~30–60） |
| `output_tokens / latency_ms` | **~30 tok/s** | 分母含 RTT + 排队 + TTFT + 预填充 + 交付，是**解码速率的下界**、系统性偏低 |

> 关键事实：上游网关把整段响应**生成完后一次性投递**（burst），因此代理看到的 chunk 到达节奏是「交付速度」而非「解码速度」。chunk 时间戳里**没有解码阶段的信号**。

结论：**解码耗时不可逐请求直接观测**。必须改用统计推断。

---

## 5. 方法：回归反推解码速率

由 §3.3 的分解：

```
latency = (RTT + 排队 + 交付) + 预填充(input) + 解码(output)
        = β0                    + β_in·input   + β_out·output
```

其中 `β_in` 是预填充的每输入 token 耗时（ms），`β_out` 是解码的每输出 token 耗时（ms），`β0` 是与 token 数无关的固定开销。

**核心洞察**：`β_out`（ms/输出 token）正是解码的 per-token 耗时，因此：

```
解码速率 (tok/s) = 1000 / β_out
```

固定开销进截距 `β0`、预填充进输入系数 `β_in`，与解码正交分离。该法**对突发投递鲁棒**：`latency` 与 `output_tokens` 的线性关系只取决于服务端「解码耗时 ∝ 输出量」，与网关**如何投递**无关（突发只影响交付那一小段，已被吸收进 `β0`）。

---

## 6. 数学：普通最小二乘（OLS）与求解

### 6.1 模型

对 n 条观测 `(xᵢ=input, wᵢ=output, yᵢ=latency_ms)`，假设：

```
yᵢ = β0 + β_in·xᵢ + β_out·wᵢ + εᵢ ,   εᵢ ~ 均值0、同方差
```

OLS 最小化 `Σ εᵢ²`，解等价于**正规方程（normal equations）** `XᵀX·β = Xᵀy`。三个未知数，写成 3×3 线性方程组：

```
┌ n    Σx    Σw  ┐ ┌ β0   ┐   ┌ Σy  ┐
│ Σx   Σx²   Σxw │ │ β_in │ = │ Σxy │
└ Σw   Σxw   Σw² ┘ └ β_out┘   └ Σwy ┘

记 A = 左侧矩阵，b = 右侧向量。
```

### 6.2 用 Cramer 法则解 β_out

只需 `β_out`（第三个变量），用 Cramer 法则：把 A 的**第 3 列**换成 `b` 得 `A_out`，则：

```
β_out = det(A_out) / det(A)
```

按第 1 行余子式展开（与实现 `fitDecodeRate` 完全一致）：

```
det(A)     = n·(Σx²·Σw² − (Σxw)²)
           − Σx·(Σx·Σw² − Σxw·Σw)
           + Σw·(Σx·Σxw − Σx²·Σw)

det(A_out) = n·(Σx²·Σwy − Σxy·Σxw)
           − Σx·(Σx·Σwy − Σxy·Σw)
           + Σy·(Σx·Σxw − Σx²·Σw)
```

### 6.3 拟合优度

正式指标是决定系数 R²（`1 − SSres/SStot`），越接近 1 越好。本方案以**预测残差**做实用核验（§9）：用拟合常数回算典型请求的 latency，与实测对比。

---

## 7. 数据与拟合

### 7.1 采样

```sql
-- 仅流式、去极短回复（解码窗口太短、噪声大）、去离群/卡死
WHERE stream = 1
  AND output_tokens >= 20
  AND latency_ms BETWEEN 500 AND 120000
```

### 7.2 聚合（生产样本，全量 n=611）

| 量 | 值 |
|---|---|
| n | 611 |
| Σx (Σinput) | 33,914,136 |
| Σw (Σoutput) | 121,203 |
| Σy (Σlatency) | 8,318,887 |
| Σx² | 2,519,884,266,256 |
| Σw² | 98,078,197 |
| Σxw | 6,282,546,604 |
| Σxy (Σinput·latency) | 506,968,447,151 |
| Σwy (Σoutput·latency) | 3,524,217,446 |

均值参考：`avg_input ≈ 55,506`（Claude Code 常带超大上下文，预填充不可忽略）、`avg_output ≈ 198`、`avg_latency ≈ 13,615 ms`。

### 7.3 代入求解

```
det(A)     ≈ 2.8714 × 10²²
det(A_out) → β_out = det(A_out)/det(A) ≈ 25.847 ms/output_tok
```

→ `解码速率 = 1000 / 25.847 ≈ 38.7 tok/s`。

（今日 352 条样本重算：`det(A) ≈ 3.065×10²¹`、`β_out ≈ 26.17` → **38.2 tok/s**，与全量一致，说明拟合稳定。）

---

## 8. 得出常数与最终公式

### 8.1 拟合常数（全量 611 条）

| 系数 | 值 | 含义 |
|---|---|---|
| `β0` | **≈ 3549 ms** | 固定开销 = 网络 RTT + 排队 + 交付（与 token 数无关） |
| `β_in` | **≈ 0.089 ms / 输入 token** | 预填充速率 ≈ 1000/0.089 ≈ **11,238 tok/s**（并行、算力密集，远快于解码） |
| `β_out` | **≈ 25.8 ms / 输出 token** | 解码速率 = 1000/25.8 ≈ **38.7 tok/s**（串行、访存受限） |

完整延迟模型：

```
latency_ms ≈ 3549 + 0.089 × input_tokens + 25.8 × output_tokens
```

### 8.2 最终公式

**仪表盘口径（生产采用）**：

```
解码 TPS = 1000 / β_out        # β_out 由当日流式样本实时回归得到
```

**可选：逐请求补偿式**（把统计常数代回单条请求，扣开销得该请求的解码耗时估计）：

```
tps_i = output_tokens_i / ( (latency_i − β0 − β_in·input_tokens_i) / 1000 )
```

> 注意：逐请求补偿值较噪声大（单条 latency 抖动大），故仪表盘采用**回归拟合值**（总体估计，鲁棒），而非逐请求补偿的均值。

### 8.3 实现

- 回归查询 + 求解：`fitDecodeRate()` @ `src/store/dashboard.ts`（Cramer 解 3×3，`n<30` 或奇异返回 null）。
- 接入：`getStats()` 加并行回归查询，`avg_tps = fitDecodeRate(reg) ?? latency 兜底`（数据不足回退到 `output_tokens/latency` 下限，不报错、不爆表）。
- 卡片：`web/src/pages/Dashboard.tsx`「解码 TPS · 回归去开销」。

---

## 9. 验证

### 9.1 残差核验（拟合优度的实用证据）

取典型请求 `input=55,000、output=198`，用拟合常数回算：

```
latency ≈ 3549 + 0.089×55000 + 25.8×198
        = 3549 + 4895 + 5108
        = 13,552 ms
实测 avg_latency ≈ 13,615 ms   → 残差 < 0.5%，拟合良好。
```

### 9.2 口径演进

| 迭代 | 口径 | 值 | 评价 |
|---|---|---|---|
| v1 | chunk 时长·后台 drain | 176,000 | ✗ drain 读缓冲，~1ms 窗口 |
| v2 | chunk 时长·实时读 | ~1,700 | ✗ 网关突发投递，非解码速率 |
| v3 | output / latency | ~30 | △ 含 RTT/TTFT/prefill，下限偏低 |
| **v4** | **线性回归 1000/β_out** | **~38** | ✓ 去开销、绕开突发，可信 |

### 9.3 稳定性

今日样本（n=352）38.2 与全量（n=611）38.7 一致 → 拟合不随窗口剧烈漂移。

---

## 10. 假设、局限与维护

- **线性假设**：预填充/解码耗时近似与 token 数成线性。对同一模型成立；极端长上下文下预填充可能轻微超线性，会引入小偏差。
- **样本量**：需 `n ≥ 30` 才拟合；不足时回退到 `output_tokens/latency` 下限（仪表盘仍可用，只是偏低）。
- **常数随模型/网关变化**：换模型（不同解码速率）或换网关（不同 RTT/突发行为）常数会变。**但因回归在查询时实时拟合**，自动适应，无需手填常量。
- **离群过滤**：`latency ∈ [500, 120000]ms`、`output ≥ 20`，剔除卡死/极短噪声。
- **仅流式计入**：非流式无 SSE 时序，且本就一次性返回，不参与。
- **若网关将来改为真·按解码速率流式**：本法**仍然成立**——`latency ∝ output` 的线性结构不变，`β_out` 照样可估（届时也可直接测 chunk 时长作交叉验证）。
