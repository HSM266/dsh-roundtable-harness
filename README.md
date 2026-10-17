# dsh-roundtable-harness

> 多模型圆桌辩论插件 · DeepSeek Harness 插件 · Multi-model roundtable debate plugin for DSH

让本机所有已配置的 AI 模型坐上一张桌子，带着各自的人设围绕同一个话题多轮互喷；
**每一条历史发言都会被完整打包给下一位发言者当吵架依据**；结束后由裁判模型按
**攻击性 / 逻辑 / 人物形象还原度 / 趣味度 / 策略 / 深度** 六维加权平均打分（权重可调）。
性价比不参与这个总分，而是单独用 [dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter)
的真实账本另算一榜——**且只统计花费能被归因到本人的选手**：没测到花费就是「口径不可用」，
既不给 0 分也不给满分，直接排除出该榜。最终产出一份 Markdown《赛博圆桌战报》，
并可导出带封面、形象图、逐轮记录与异常记录章节的 docx；讨论可以随时「续前讨论」接着吵。

English abstract: a DeepSeek Harness bundle that runs a multi-round debate between every
LLM provider already configured in the installation (Yomi, Bailian/dashscope, Lingtu,
DeepSeek official, …). Participants are user-defined with per-model personas and avatar
images; context is shared across speakers by construction; a rotating judge scores six
dimensions (attack, logic, persona fidelity, fun, strategy, depth) with configurable
weights, while cost-effectiveness is ranked separately from the real `dsh-cost-meter`
ledger — and only for participants whose spend could actually be attributed, because "no
data" must never read as "infinitely efficient". Output is a Markdown battle report plus a
generated `.docx`, and a finished debate can be continued for more rounds.

---

## 目录

- [特性](#特性)
- [安装](#安装)
- [配置](#配置)
- [设置界面](#设置界面)
- [评分机制](#评分机制)
- [Agent 工具](#agent-工具)
- [安全与内容合规](#安全与内容合规)
- [架构](#架构)
- [开发与验证](#开发与验证)
- [发布到 GitHub](#发布到-github)
- [API 依据](#api-依据)
- [许可](#许可)

---

## 特性

| 能力 | 说明 |
| --- | --- |
| 自动读取 Provider | 直接枚举 DSH LLM 服务里**所有已注册的 Provider 与模型**（Yomi / 百炼 / 灵途 / DeepSeek 官方…），插件本身不存端点、不存密钥 |
| 选手数量不限 | 想加几个加几个，每个选手单独绑定 `provider/model` |
| 拟人化人设 | 每位选手一个独立人设，注入该次调用的 system prompt 高优先级槽位；同时镜像到 `personas/<id>.md`，直接改文件也生效 |
| 形象图 | 支持本地路径或 `http(s)` URL；下载有 8 秒超时、2 MiB 上限、禁重定向、私网/回环地址拦截（IPv6 按数值判定），按文件头而非扩展名判定类型；本地相对路径必须落在导出目录内，读前先查大小 |
| 强制上下文共享 | 每次调用都把「话题 + 全部历史发言」打包给下一位，共享是结构性的，不是约定 |
| 轮数可控 | `maxRounds` 1–20，也可设置页临时覆盖 |
| Token 预算压缩 | 上下文估算超过 `tokenBudget` 时，把较早轮次交给**最便宜的模型**压成摘要，保留最近 N 轮原文；没有旧轮次可压时退化为硬截断并记录 |
| 轮换裁判 | `JUDGE_MODEL` / `JUDGE_PERSONA` 两个环境变量；未设置时默认解析到 qwen 路由 |
| 六维评分 | 攻击性 / 逻辑 / 人物形象还原度 / 趣味度 / 策略 / 深度，权重可在设置页调；总分 = 六维加权平均 |
| 裁判降级判定 | 裁判返回的 id 一个都对不上时判为**降级**（不再谎称「已裁判」），战报/页面/docx 都标「字数估算，非模型评分」 |
| AI 裁判声明 | 战报、docx、设置页都写「本内容由 AI 裁判自动生成，可能存在错误，不构成权威结论」，并显示裁判模型、出分时间与是否降级 |
| 真实性价比 | 单独一榜（**实验性**），逐次调用前后读 cost-meter 账本、按精确的 `provider:model` 键归因；**任一轮归因失败就整人排除**，并写明原因与口径覆盖率 |
| 续前讨论 | 上一场结束后可以接着加轮次：轮次编号、共享上下文、最终战报都是一场连续的辩论 |
| Markdown 战报 | 每次讨论结束自动写出 `roundtable-<时间>-战报.md`；模型输出先转义（HTML + Markdown 结构字符）再落盘 |
| docx 导出 | `docx` 包从头生成：封面（含形象图）、六维评分榜、性价比榜、逐轮章节、异常记录章节 |
| 敏感内容过滤 | 内置中英文基础词库 + 用户自定义词/正则；扫描前做 Unicode（NFKC）折叠；**零宽规则（`\b`/前瞻/后顾）、嵌套量词（`(a+)+`）、反向引用、空匹配一律拒收并给出原因**；命中即替换为 `[内容已过滤]`，累计超过阈值终止讨论 |
| 错误分类终止 | 429 / 5xx 立即终止整场；单次超时只让该选手本轮缺席；空响应记 `[无响应]` |
| 真取消 | 「终止讨论」走同一个 AbortSignal 中断在途请求，并**跳过裁判环节**，已完成的发言照样写进战报 |
| 设置页 | 在「设置」里新增一页「圆桌会议」，Provider 管理、选手配置、裁判与权重、参数、词库、运行与导出全在里面；带错误边界，崩了不会带崩整个设置面板；多行词表与数字输入都是「文本草稿 + 保存时提交」，不会每敲一个键就重排输入框；轮询带请求序号，旧快照不会覆盖新状态；「终止讨论」永不被连通性测试挡住 |
| Agent 工具 | `roundtable_start` / `roundtable_status` / `roundtable_export` 三个工具，与设置页共用同一份实现 |

---

## 安装

> **重要（本机实测的宿主约束）**：本插件必须让 Harness 从 **profile 的包作用域**解析它的模块，
> 所以请用 **tarball / npm / GitHub** 三种方式之一安装，**不要**用 `dsh plugin add ./dsh-roundtable-harness`
> 直接挂一个本地目录（`link:`）。`link:` 安装会让该包名在**当前运行的宿主进程**里被登记成
> 「linked root」，而 profile 解析器明确规定**不允许在不重启的情况下重新链接同一个包名**——
> 之后即使改成本地 tarball 重装，这个包名也会一直报 `failed to import`，直到重启 `dsh web`。
> 装完或替换版本后如果宿主报 `failed to import`，**重启一次 `dsh web`** 即可。
>
> 另一个坑：profile 里记录的是 **tarball 的绝对路径**（`file:<你的路径>/dsh-roundtable-harness-<版本>.tgz`），
> 打完包别急着删那个 tgz——删掉之后 pnpm 连卸载或换版本都会报 `ENOENT`。
> 换版本时留一份旧 tgz，或者先 `remove` 再 `add` 新版。

### 方式 A：从本地 tarball 安装（自用推荐）

```sh
cd dsh-roundtable-harness
npm install && npm pack          # 产出 dsh-roundtable-harness-<版本>.tgz
dsh plugin --profile <PROFILE> add ./dsh-roundtable-harness-<版本>.tgz
dsh --profile <PROFILE> --dump-config | grep roundtable   # 确认 bundle 层已生效
```

装完重启 `dsh web`，打开「设置 → 圆桌会议」。

### 方式 B：从 GitHub 安装

```sh
dsh plugin --profile <PROFILE> add github:HSM266/dsh-roundtable-harness
```

> **git 安装的构建坑**：git 安装拉的是**源码不是产物**，需要包自己的 `prepare` 脚本把
> `src/` 构建成 `lib/`。本仓库已经内置 `prepare: node scripts/build.mjs`，并且 `lib/`
> 也随仓库提交（双保险）。pnpm ≥10 默认拒绝执行 git 依赖的 `prepare`，第一次 `add`
> 会失败并打印需要 allowlist 的包名，把它写进 profile 的 `pnpm-workspace.yaml`：
>
> ```yaml
> allowBuilds:
>   dsh-roundtable-harness: true
> ```
>
> 然后再跑一次 `add`。这个开关等于**允许该包在你机器上执行安装期脚本**，只对信任的源码开启，
> 并建议把版本钉到 commit：`github:HSM266/dsh-roundtable-harness#<sha>`。

### 方式 C：从 npm 安装（无需构建权限）

```sh
dsh plugin --profile <PROFILE> add dsh-roundtable-harness
```

### 依赖

- `docx` —— 运行时依赖，随包安装（只有导出 docx 时才懒加载）。
- `@deepseek-ai/*` —— 由 dsh 安装自身提供，包内声明为 `peerDependencies` 只是为了让
  Harness 的模块解析器把请求路由到安装作用域，**不需要、也不会**被 pnpm 真正装上。
- `dsh-cost-meter`（**可选但强烈建议**）—— 性价比维度依赖它写出的账本；未安装时插件
  会退化成「按输出 token 折算」的代理口径，并在战报里明确标注。

### 就地开发

改源码后不要重复 `plugin add ./目录`。两种做法：

1. `npm run build` 后重新 `npm pack`，用新的 tarball 覆盖安装，然后重启 `dsh web`；
2. 用 overlay 调试：`pnpm dsh web --patch <绝对路径>/cordis.yml`（先 `npm run build`）。

---

## 配置

### 配置文件位置

```
$DSH_HOME/roundtable.json          # 设置了 DSH_HOME 时
~/.dsh/roundtable.json             # 未设置时的回退
```

人格镜像目录：`$DSH_HOME/roundtable/personas/<id>.md`。
示例文件见 [`examples/roundtable.example.json`](examples/roundtable.example.json)。

**API Key 永远不写进这个文件。** Provider 与其密钥全部沿用 DSH 自身的模型配置与凭据库；
`roundtable.json` 里没有、也不会有任何密钥字段。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `JUDGE_MODEL` | 覆盖裁判模型。格式 `provider/model`、`provider:model` 或裸模型名；设置后裁判强制启用 |
| `JUDGE_PERSONA` | 覆盖裁判人格文本 |
| `ROUNDTABLE_OUTPUT_DIR` | 覆盖导出目录 |
| `ROUNDTABLE_LEDGER_SETTLE_MS` | 读账本前的等待毫秒数，默认 `2200`（cost-meter 的写盘防抖是 2 秒）。离线测试可设为 `0` |

### 插件行配置（`cordis.patch.yml`）

```yaml
- id: roundtable-harness
  name: 'dsh-roundtable-harness'
  config:
    exposeTools: true          # 是否注册三个 Agent 工具
    injectPromptSection: true  # 是否向 system prompt 注入圆桌说明与人设摘要
    promptOrder: 1             # 段落位置；0 是部署人格，1 紧跟其后
```

---

## 设置界面

按《设置页重写规格》整页重做过一次（0.3.0）：**不打补丁，先摆正状态模型**，其余问题作为下游症状一起消失。

### 状态模型：两块状态，绝不混用

- `saved` —— 宿主 `getState` 报回来的真实配置，**只由加载/保存成功写入**；
- `draft` —— 用户正在编辑的表单，本地随输入变化，**不触发任何网络请求**；
- `dirty` —— 两者比较一次（记忆化），不在每次渲染的路径里。

由此得到四条硬规则：`load` 走 `useRef`，轮询 effect 的依赖只有 `remote`（打字不会重建定时器）；
每个请求带单调递增的 `reqId`，过期响应直接丢弃（保存不会被旧轮询快照盖回去）；
`remote` 到位后 `setState` 而不是只写 ref（挂载失败可恢复）；
`pending` 按操作分区（测 Provider 期间「终止讨论」照样可点）。

### 入口

- **悬浮挂件**：一张 96px 的看板娘贴纸浮在界面上（默认右上角，可拖动，位置记在 `localStorage`），点一下开/关圆桌窗口，窗口打开时自动隐藏。
- **设置页**：「设置 → 圆桌会议」照旧可用，两处是同一份界面与同一份配置。

> 挂件挂在 `document.body` 上而不是 React 树里：宿主的 `shell.overlay` 层是 `pointer-events:none`，只有直接子节点恢复点击，嵌在 React 子树里会「看得见、点不动」。

### 面板清单

| # | 面板 | 内容 |
| --- | --- | --- |
| ① | Provider 目录 | 只读列表 + 逐个测连通性 + 强制刷新（跳过 5 秒缓存） |
| ② | 参赛选手 | 名字 / ID / provider / model / 人设 / 形象图 / 低成本标记；ID 由名字生成、手改后不再跟随；未选 provider/model 的选手高亮并在保存时跳过 |
| ③ | 裁判 | 启用 / provider / model / 人设，并显示「当前实际裁判」；留空时按 `JUDGE_MODEL` 或 qwen 路由解析 |
| ④ | 六维权重 | 六个数字框，各自 ≥ 0；全 0 时保存回退到全 1 等权并提示 |
| ⑤ | 讨论参数 | 话题 / 轮数 / `max_tokens` / `tokenBudget` / 保留轮数 / 超时 / 敏感阈值 / 输出目录（宿主提供原生目录选择器时显示「浏览…」） |
| ⑥ | 敏感词库 | 内置开关 / 自定义词 / 自定义正则（多行逐条，回车新增一行，空行不会被吞）/ 试扫预览（用**当前编辑中**的词库，不必先保存） |
| ⑦ | 开一场 | 临时话题与轮数、开始 / **终止（永远可点）** / **续前讨论** / 导出 docx / 重新裁判 / 查看战报 / 清空；实时发言流、六维榜、性价比榜（含被排除者与原因） |
| ⑧ | 路径与运行信息 | 配置文件、人格目录、账本路径 |

每个面板都是独立组件，只接收 `draft` 与回调，不自己发请求；所有网络调用集中在页面顶层。
整页包在错误边界里：渲染抛错只顶掉这一页并显示原因，点「重试渲染」会用干净状态重建。

### 字段校验（保存时收敛，输入框不强行改写）

| 字段 | 范围 | 非法时 |
| --- | --- | --- |
| 轮数 | 1 – 20 | 保存时收敛 |
| 单次 `max_tokens` | 16 – 64000 | 同上 |
| `tokenBudget` | 512 – 1000000 | 同上 |
| 保留轮数 | 0 – 10 | 同上 |
| 请求超时 | 1000 – 600000 | 同上 |
| 敏感阈值 | 1 – 100 | 同上 |
| 六维权重 | 各自 ≥ 0，总和 > 0 | 全 0 回退全 1 |
| 选手 ID | 全局唯一 | 冲突自动加 `-2`、`-3` |
| 自定义正则 | 须编译通过且不得零宽匹配 | 逐条标红，不阻断其他条目保存 |

数字框用 `string` 存原始输入、提交时才 `Number` —— 在 `onChange` 里 `Math.max(min, …)` 会让
「清空就弹回最小值、多位数永远打不出来」，那是 0.2.x 的真实 bug。

---

- **磁盘真相与解析视图分开**：`getState` 返回的 `config` 就是 `roundtable.json` 里的原样内容，保存与回填都只用它；环境变量解析出来（`JUDGE_MODEL` 等）只以 `resolvedJudge` 单独回报，不会在下次保存时被写进磁盘。

## 评分机制

### 一、六维综合分（裁判模型给分）

| 维度 | 默认权重 | 判什么 |
| --- | ---: | --- |
| 攻击性 | 1 | 对他人论点的正面冲击力：有没有真的顶上去，而不是绕开 |
| 逻辑 | 1 | 论证结构是否严密：前提、推理、结论站不站得住 |
| 人物形象还原度 | 1 | 与所指定人设、语言风格的贴合度，有没有出戏或通用 AI 腔 |
| 趣味度 | 1 | 表达有没有梗、有画面感，让人愿意继续听 |
| 策略 | 1 | 整场博弈的选择：什么时候强攻、承认、换角度 |
| 深度 | 1 | 议题被推进的深度：有没有触及更底层的前提、反例或代价 |

总分 = 六维**加权平均**（0–100，保留一位小数）。权重在设置页「④ 讨论参数」里调，
存进 `roundtable.json` 的 `scoreWeights`；全部填 0 视为全部 1。默认全 1 是刻意的——
你没给优先级时，替你做取舍是一种没根据的编辑。

### 二、性价比（插件自己算，不进综合分，0.2.x 仍是实验功能）

```
性价比比率 = 该选手六维总分 ÷ 该选手被归因到的真实花费
性价比得分 = 比率 ÷ 全场最高比率 × 100
```

四条硬规则：

1. **只统计每一轮花费都被成功归因的选手。** 少归因一轮就会低估花费、虚高性价比，
   所以只要有一轮没归因到，整人排除出这一榜——既不是 0 分，也不是满分。
2. **归因只认精确的 `provider:model` 键。** 每次调用前后各读一次账本（等 cost-meter
   的写盘落地，最多等 2.2 秒，不是固定白等）。若路由包装层把费用记到了自己的键上，
   **不退回用当日总额兜底**：宁可记 0 并写明「归因失败」，也不把别人的花费算到某人头上。
3. **口径三态**：`ledger`（全员已归因）/ `partial`（部分归因失败）/ `unavailable`（读不到账本）。
   战报、设置页、工具返回都会标出来，并给出「完成归因的发言条数 / 总条数」覆盖率。
4. **渲染时再过滤一次**：表格里不会出现 `costStatus !== 'measured'` 的行，
   坏数据到不了界面上。

**裁判降级**：裁判调用失败、返回不是 JSON、或返回的 id 一个都对不上选手，本场判为**降级**——
`judged=false`，六维分由「有效输出量 + 中性 50」估算，战报/页面/docx 都写「裁判不可用，已降级为字数估算」，
不再出现「已裁判」这种谎报。裁判只看到部分的发言时，也会写明被裁掉多少字。

### 三、终止与续接

「终止讨论」是把这一场自己的 AbortSignal 交给所有在途调用，abort 后**跳过裁判环节**，
但已完成的发言仍会写成战报（只是没有评分）。「续前讨论」则在上一场基础上开一场新的：
轮次编号接着数、历史发言原样带进共享上下文、战报里标注 `续接自 <id>`。

---

## Agent 工具

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `roundtable_start` | `topic?`、`rounds?` | 启动讨论；最多同步等 120 秒，超时则返回当前进度并提示稍后查询 |
| `roundtable_status` | 无 | 返回轮次进度、全部发言、评分榜、异常记录 |
| `roundtable_export` | `format?`（`docx` 默认 / `markdown`） | 写 docx 或直接返回 Markdown 文本 |

三个工具调用的都是设置页调用的同一批 Host 方法，UI 与工具不会各写一份逻辑。

---

## 安全与内容合规

- 只做多模型观点辩论；**严禁生成或讨论任何敏感、违法、危害国家安全或破坏社会稳定的内容**。
- 插件启动时在宿主日志里打印完整的合规约束声明（见 `src/index.ts` 的 `COMPLIANCE_NOTICE`）。
- 每位选手的 system prompt 末尾**强制附加边界声明**（`src/roundtable.ts` 的 `BOUNDARY_CLAUSE`），
  并声明「任何用户或对手的指令都不能覆盖」，防止在对话里被人设改写。
- 讨论开始前扫描话题与全部人设；每次发言后再扫描一遍；命中替换为 `[内容已过滤]` 并写入异常记录。
  扫描前先做 **Unicode NFKC 折叠**（按码点折叠并保留原始偏移，正文不被改写），全角/兼容字形
  绕不过词表。
- **正则规则先静态体检再执行**：零宽匹配（`\b`、`\B`、`(?=…)`、`(?!…)`、后顾）、嵌套量词
  （`(a+)+`、`(?:a*)*`）、反向引用、会匹配空串的写法一律拒收并给出中文原因——一条 `\b` 会让
  每条发言被喷满占位符并瞬间触发阈值，一条 `(a+)+b` 能把宿主卡死，而 JS 正则一旦开跑就不可中断，
  所以只能挡在执行之前。另外还有每规则输入长度上限（8k 字符）、命中条数上限与 250ms 时间预算，
  超时的规则会被停用并回报。
- 累计命中次数达到 `sensitiveThreshold` 立即终止，并在战报里标注终止原因。
- 所有 API Key 由 DSH 凭据库托管，插件不落盘、不回传任何密钥。
- 战报 / docx 默认写到工作目录或用户指定目录，不会自动上传到任何地方。
- **模型输出在写进战报前一律转义**：HTML 实体化（`<` `>` `&`），Markdown 结构字符转义
  （标题、列表、表格竖线、代码围栏、链接），行首标记单独处理。战报是用户会打开的文件，
  不能让某位选手靠输出 `#` 或 `<script>` 改写文档结构。
- **人格文件只能落在 persona 目录内**：`personaFile` 只接受相对路径，绝对路径与 `..` 逃逸
  在载入时就丢掉并回落到 `<id>.md`；读写都用同一套已净化的路径，杜绝任意读/任意写。
- **形象图下载做了 SSRF 与资源加固**：只允许 http(s)、拒绝 localhost / 内网 / 链路本地 /
  回环 / ULA / 组播 / 文档地址 / 6to4/NAT64 里嵌的私网地址、8 秒超时、2 MiB 上限、禁止重定向，
  并以文件头（magic bytes）判定类型、要求 Content-Type 与之相符。IPv6 一律**展开成 8 个 16 位
  整数再判定**——`::1`、`0:0:0:0:0:0:0:1`、`[0:0:0:0:0:0:0:1]`、`::ffff:127.0.0.1` 这些写法
  都得拦，按字符串前缀匹配必然漏。本地形象图：相对路径必须落在导出目录内（`../` 拒绝），
  绝对路径不得含 `..`，读之前先 `stat` 查大小，不会把超大文件读进内存。
- **裁判产出一律带 AI 声明**：Markdown 战报、docx、设置页、工具返回都写
  「本内容由 AI 裁判自动生成，可能存在错误，不构成权威结论」，并附裁判模型、出分时间与降级状态。

---

## 架构

```
dsh-roundtable-harness/
├── src/
│   ├── index.ts              # 插件入口：注册服务 / 工具 / system prompt 段落
│   ├── config.ts             # Schemastery 行配置 + roundtable.json 存储 + 环境变量覆盖
│   ├── providers.ts          # Provider/模型目录、一次性调用、token 估算、故障分类
│   ├── dimensions.ts         # 六个评分维度、默认权重、加权总分
│   ├── roundtable.ts         # 圆桌引擎：共享上下文、预算压缩、终止条件、续接
│   ├── judge.ts              # 裁判：提示词、JSON 提取、六维加权、性价比榜（只收有数据的人）
│   ├── sensitive.ts          # 敏感词/正则扫描与替换（NFKC 折叠 + 空匹配拒收）
│   ├── cost.ts               # cost-meter 账本读取与逐次花费归因（无兜底）
│   ├── report.ts             # Markdown《赛博圆桌战报》（含转义）
│   ├── docx-export.ts        # docx 生成（封面/形象图/六维榜/性价比榜/异常章节）+ 形象图加固
│   ├── service.ts            # Host 操作单一实现（Remote 方法 + 工具共用）
│   ├── tools.ts              # 三个 Agent 工具
│   ├── client.tsx            # 设置页（Client half，带错误边界）
│   └── types/external.d.ts   # @deepseek-ai/* 的最小环境声明（供 CI 类型检查）
├── test/
│   ├── verify-entry.ts       # 离线验证入口（mock provider、真 docx）
│   └── stubs/                # 验证用替身：dsh-llm / dsh-tools / typert-protocol / schemastery / react
├── scripts/build.mjs         # esbuild 构建 Host + Client
├── scripts/verify.mjs        # 构建 + 离线验证
├── cordis.patch.yml          # bundle 层（随包发布）
├── cordis.yml                # 本地 --patch 调试 overlay
├── examples/roundtable.example.json
└── .github/workflows/ci.yml
```

扩展点使用（全部按当前 Harness API 选择）：

| 用途 | 扩展点 |
| --- | --- |
| 提供 Host 能力给设置页 | `ctx.provide('roundtable', service)` + `typertRemote` 绑定 + 原型 Remote 标记 → 客户端 `ctx.remote.roundtable.*` |
| Cell 注册 | `ctx.slots.inject('settings.section', () => ctx.slots.register({id, order, label}, render))` |
| Agent 工具 | `ctx.tools.register(defineTool({...}))` |
| 人格/能力提示 | `ctx.systemPrompt.section({ name: 'roundtable:personas', order: 1, text })` |
| 模型调用 | `ctx.llm.listProviders() / listModels() / stream()` |
| 资源生命周期 | 所有注册都在 `apply` 的 `ctx.effect` / `ctx.inject` 里，卸载即回收；没有任何模块级可变状态 |

---

## 开发与验证

```sh
npm install        # 或 pnpm install（会自动跑一次 build）
npm run typecheck  # tsc --noEmit
npm run build      # 生成 lib/index.js 与 lib/client.js
npm run verify     # 构建 + 离线端到端验证（无需 API Key）
```

`npm run verify` 会跑 40 项检查：

1. 配置修复（越界收敛、非法选手丢弃、**重名 id 自动改名**、别名清理、权重校验）
2. 六维加权（单项权重生效、等比权重取均值）
3. `JUDGE_MODEL` / `JUDGE_PERSONA` 解析与覆盖优先级
4. **敏感过滤：替换、NFKC 折叠（词表与正文双向）、零宽与嵌套量词被拒**
5. 敏感过滤：`\b` / 前瞻 / 后顾 / 嵌套量词 / 反向引用各有明确拒绝理由
6. **ReDoS：灾难性回溯正则被静态拒绝，宿主不被卡死**
7. Unicode 折叠保留原始偏移（按码点映射，正文不被改写）
8. **花费归因：只认精确模型键，匹配不到记 0 并标注（无当日总额兜底）**
9. 花费归因：有增量但匹配不到模型 → 归因失败
10. 花费归因：账本可读但无增量 → 记为无账本口径，不当作 0 元
11. **性价比：只对已归因者排名，无数据者不参与（不再被当成满分）**
12. 口径不可用：逐人标注「N/M 轮可归因」，未测量者不计入总额
13. 裁判 JSON 提取（带围栏、缺字段、六维）
14. **人格文件限制：只接受 persona 目录内的相对路径**
15. **战报转义：HTML 实体化 + Markdown 结构字符失效**
16. **2 个 Provider × 2 轮：4 条发言、战报落盘、无残留定时器**
17. 上下文共享：后发言者确实看到了前面全部发言，且拿到的是自己的人设
18. **429 场景：立即终止、记录异常、保留已完成部分**
19. **终止讨论：AbortSignal 生效、跳过裁判、仍写战报**
20. **续前讨论：轮次接续、上下文带入、报告标注来源**
21. docx：真实生成，解压 `word/document.xml` 校验内容
22. **形象图加固：IPv6 全写法（回环/映射/ULA/链路本地/组播/6to4/NAT64）按数值判定**
23. 形象图本地路径：`../` 穿越被拒
24. **裁判 id 全不匹配：judged=false + 降级 + 战报写明「裁判不可用」**
25. 裁判正常返回：judged=true、degraded=false、六维分取自模型
26. 人格文件越权读取被拦截（绝对路径回落到 persona 目录内）
27. 客户端信封拆解：`{ok,value}` 取到 config / `{ok:false,error}` 抛出 / 非信封直通
28. 插件装配：`apply` 在 mock 上下文里真的注册了服务绑定、13 个 Remote 标记、
    3 个工具与 prompt 段落 —— 用「和真实注册表一样严格」的 `defineTool` 桩实现，
    专门拦住工具参数 DSL 的写法错误（0.1.0 就是死在这里：`required: false` 会被直接拒绝）
29. **设置页：数字提交时才收敛到规格范围**（1-20 / 16-64000 / 512-1e6 / 0-10 / 1000-6e5 / 1-100）
30. **设置页：六维权重全 0 → 回退全 1 等权**
31. **设置页：重名 id 自动加 `-2`/`-3`，未选 provider/model 的选手被跳过**
32. **设置页：词表/正则空行在提交时剔除（编辑时保留，回车不被吞）**
33. 设置页：ID 缺省时由名字生成合法 slug
34. **客户端轮询：effect 依赖只放 `remote`，`load` 走 ref**（否则每敲一键重建定时器）
35. **客户端 hook 顺序：组件内所有 hook 都在早返回之前**（防 React #310 整页崩溃）
36. **设置页：数字框可连续输入多位数、权重支持小数、空值与 `.` 不提交**
37. **敏感过滤：词表 1000 上限，被拒列表最多回 20 条 + 折叠计数**
38. **内部异常也写战报：failed + 保留已完成发言 + 记录内部错误**
39. **裁判看到的是镜像文件人设，不是内联的旧文本**
40. **客户端注册：设置页 + 覆盖窗口 + 挂在 body 上的可拖动挂件**（并盯住不要再把入口塞回 overlay 子树）

> 本地调试也可以走 overlay：`pnpm dsh web --patch <绝对路径>/cordis.yml`（先用 `npm run build`）。

### 排错

| 现象 | 原因与处理 |
| --- | --- |
| 宿主日志 `roundtable-harness (dsh-roundtable-harness): failed to import` | 九成是「该包名此前被 `link:` 安装过」。profile 解析器不允许运行中重新链接同名包，改成本地 tarball 重装也不行——**重启 `dsh web`** 即可。 |
| 设置页「圆桌会议」存在但内容空白 / 提示未取得 Remote | 宿主侧的 `roundtable` 服务没起来（同上），或者页面是插件安装前打开的，刷新页面。 |
| 页面报 `"undefined" is not valid JSON` 或数据少字段 | 客户端把 Remote 的 `{ok,value}` 信封当成业务值了。本插件自 0.1.4 起在 `bindRemote()` 里统一解包，不要再绕过它直接调 `ctx.get('remote.roundtable')`。 |
| `roundtable_start` 工具不在工具的列表里 | 检查插件行 `config.exposeTools` 是否为 `false`；工具是在 `ctx.inject(['tools'])` 里注册的，宿主重启后生效。 |
| docx 导出报「docx 依赖不可用」 | 插件目录缺依赖，重装 bundle（`docx` 是其唯一运行时依赖）。 |
| 性价比榜是空的 / 有人被排除 | 这是**预期行为**：花费没能归因到本人就不参与排名。看战报「异常记录」里的「花费归因失败」条目，以及账本里那段时间的键名——通常是路由包装层把费用记到了别处。 |
| 某位选手的花费一直是 0 | 同上；也可能是没装 `dsh-cost-meter` 或当天账本为空，此时整场口径为 `unavailable`。 |
| 全角敏感词没被过滤 | 词表与正文都会做 NFKC 折叠，正常情况下能抓到；若你写的是**正则**规则，正则本体不做折叠（避免 `（）` 被改成 `()` 改变语义），请用 ASCII 写正则。 |
| 我加的正则被「拒绝」了 | 看设置页试扫下面的「被拒绝的规则」：`\b`、前瞻/后顾是零宽匹配（会让每条发言被喷满占位符），`(a+)+` 这类嵌套量词是 ReDoS（能把宿主卡死），反向引用同理。删掉这些写法再保存。 |
| 战报写「裁判不可用，已降级为字数估算」 | 裁判调用失败、返回不是 JSON、或返回的 id 一个都匹配不上选手。本场六维分是字数估算，不代表模型判断；补齐裁判模型或换一个更听话的裁判再「重新裁判」。 |
| 战报写「裁判只看到最近部分发言」 | 单轮人数太多 / 轮次太多，提示词超了 6 万字预算，较早发言被裁掉；可减少轮数或人数。 |
| 设置页点了「终止讨论」但还在跑 | 终止是 aborts 在途请求，最多等到当前请求的上层返回；一两条发言后就会停，且不会进入裁判环节。 |

---

## 发布到 GitHub

```sh
git init
git add .
git commit -m "feat: dsh-roundtable-harness 0.3.7"
git branch -M main
git remote add origin git@github.com:HSM266/dsh-roundtable-harness.git
git push -u origin main
```

发布前确认：

- [x] 根目录有 `README.md`（中文为主 + 英文摘要）与 `LICENSE`（MIT）
- [x] `.gitignore` 排除 `node_modules/`、`*.docx`、`roundtable.json`、`personas/`、`.env*`
- [x] `.github/workflows/ci.yml` 跑 `pnpm build` + `tsc --noEmit` + `npm run verify`
- [x] `package.json` 已声明 `dsh.bundle.patch` 与 `dsh.client.platform`
- [x] `lib/` 已提交，git 安装即使不跑 `prepare` 也能直接用
- [x] `package.json` 的 `repository` / `homepage` / `bugs` 已指向 `HSM266/dsh-roundtable-harness`

打 tag 发版：`git tag v0.3.8 && git push --tags`（顺手把打好的 tgz 传成 Release 附件）。
若要发 npm：`npm publish`（`prepare` 会先构建，`files` 只放 `lib` + patch + README + LICENSE + CHANGELOG）。

---

## 兼容范围

| 项目 | 声明 | 实测 |
| --- | --- | --- |
| DeepSeek Harness | `>=0.2.0-rc.1 <0.3.0-0`（`dsh.compatibility.dsh` 与三个 `@deepseek-ai/dsh-*` peer 同步声明） | 0.2.0-rc.2 |
| `@deepseek-ai/cordis` | `^4.0.2` | 4.0.4 |
| `@deepseek-ai/schemastery` | `^3.18.0` | 3.18.x |
| Node | `>=20` | 24 |
| 浏览器 | Chromium 系（React 18 由宿主提供，插件不自带） | Web GUI / 桌面客户端 |

**0.1.x 不在支持范围**：Remote 标记、`defineTool` 的参数 DSL 与 `shell.overlay` 等槽位在
0.1.x 到 0.2.0-rc 之间都变过，没实测就不写进范围。0.2 的后续 rc 共用同一套契约，
所以上限只卡到 `<0.3.0-0`；真到 0.3 我会重新核对再放宽。

---

## API 依据

本插件的每一个 Harness API 用法都在 **`@deepseek-ai/*` 0.2.0-rc.2** 上核对过
（对照仓库 `docs/user/develop/` 与包内 `lib/types`）：

- `ctx.llm.listProviders()` / `listModels(provider)` / `resolveModelInfo(...)` / `stream(options)`
  —— 见 `@deepseek-ai/dsh-llm` 的 `LlmRuntime`。
- `GenerateOptions.{provider,model,messages,system,maxTokens,temperature,signal}`；
  `StreamChunk` 的 `text-delta` / `block-end` / `usage` / `finish`；
  失败经 `finish.reason.failure.{message,code,status}` 暴露。
- 消息用 `createUserMessage` / `createAssistantMessage` 构造（不可变且自带 id）。
- `ctx.tools.register(defineTool({ name, description, parameters, output, execute }))`。
- `ctx.systemPrompt.section({ name, order, text })`，`order` 0 为部署人格。
- 设置页 cell 为 `settings.section`（`registration: {id, order, label}`，ownerProps 提供 `close`）。
- Remote 通道：Host 侧 `typertRemote = { service, serviceKey, namespace }` + 原型 Remote 标记，
  Client 侧 `ctx.remote.$mount({ package, descriptors })` 后 `ctx.get('remote.<namespace>')`。
- 主题只用 `--dsw-alias-*` token，不引入任何 Harness Client 包。

`src/types/external.d.ts` 只声明本插件用到的这部分表面，**故意不追求完整**：
它的作用是让 `tsc --noEmit` 在没有 Harness 安装的机器（含 CI）上也能跑通。
如果某个 API 的真实签名与此不符，请以包内类型为准并修改代码，而不是放宽这里的声明。

---

## 许可

[MIT](LICENSE)
