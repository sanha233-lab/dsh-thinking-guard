# dsh-thinking-guard

DSH 的一个小插件：模型"只思考、不动手"、在原地打转时，**自动打断它，再让它接着干活**。

你不需要一直盯着屏幕等它想完，也不用每次都手动点停止。

> 本仓库是 [ethanwong-hk/dsh-thinking-guard](https://github.com/ethanwong-hk/dsh-thinking-guard) 的修复版。
> 上游有若干会让对话直接崩掉的问题，这里全部修好了，修复清单见文末。

---

## 它解决什么问题

有些模型（尤其 flash 类）会陷进这种状态：

- 一直在输出"思考过程"，**不输出正文、不调用工具**
- 反复说同一句话，比如「好。执行。」「让我再确认一下。」
- 把同一段话换个数字再说一遍，看起来在推进，其实原地踏步

这时候你只能干等，或者手动中止。这个插件替你做两件事：

1. **检测到上面三种情况，立刻打断当前回合**
2. **往会话里插一条说明**（告诉你哪一档触发的、重复了多少次），
   再插一条**「继续」指令**，要求模型下一步先调工具、别再空想

---

## 安装

### 方式一：让 AI 装（推荐）

把这句话发给你正在用的 AI：

```
帮我安装 https://github.com/sanha233-lab/dsh-thinking-guard 到我的 DSH
```

如果你的 AI 需要更明确的步骤，把下面这段一起发给它：

```
安装步骤：
1. 把仓库克隆到 $DSH_HOME/plugins/dsh-thinking-guard
   （$DSH_HOME 在 Windows 上一般是 %APPDATA%\dsh-desktop\harness）
2. 把仓库里的 cordis.patch.yml 内容，追加到
   $DSH_HOME/profiles/<profile>/cordis.patch.yml 的末尾
3. 检查 $DSH_HOME/profiles/<profile>/.dsh-market/state.json，
   如果里面的 disabled 数组包含 dsh-thinking-guard，把它删掉
   （否则 DSH 每次启动都会把这个插件关掉）
4. 重启 DSH Desktop
```

`<profile>` 一般是 `web`。

### 方式二：手动装

**第一步**，把整个仓库放到：

```
%APPDATA%\dsh-desktop\harness\plugins\dsh-thinking-guard
```

**第二步**，打开 `profiles/web/cordis.patch.yml`，在**文件末尾**追加：

```yaml
- insert:
    - id: thinking-guard
      name: 'dsh-thinking-guard'
      config:
        enabled: true
        thinkingOnlyMs: 45000
        repeatThreshold: 3
        notify: true
        autoContinue: true
        verbose: false
```

**第三步**，检查市场状态文件 `profiles/web/.dsh-market/state.json`，
如果 `disabled` 数组里有 `dsh-thinking-guard`，删掉那一项。

**第四步**，重启 DSH Desktop。

---

## 装好之后怎么确认

1. 打开 DSH 的插件页面，能找到 `dsh-thinking-guard` 且是**启用**状态
2. 打开 `profiles/web/cordis.patch.yml`，能看到上面那段 `- insert:`
3. 真正触发一次时，会话里会出现一条 `[thinking-guard] 已中止当前活动……` 的说明

> 只看文件在不在没用——配置文件写了，插件模块也要 DSH 重启后才会加载。

---

## 它什么时候会打断你

| 档位 | 默认阈值 | 触发条件 | 默认状态 |
|---|---|---|---|
| `thinking-only-timeout` | 90 秒 | 只有思考、没有正文、没有工具调用，且距最后一次进展超过 90 秒 | **默认关闭** |
| `repeat-unit` | 同一短语连续 3 次 | 尾部窗口里同一段内容连续重复 | 开 |
| `sentence-repeat` | 同句式 8 次、占比 60% | 同一句式（数字归一化后）大量重复 | 开 |
| `gram-density` | 密度 0.16 | 600 字窗口内 6-gram 高度重复，原地打转 | 开 |
| `thinking-volume` | 8 万字符 | 单次思考的累计字符数 | **默认关闭** |
| `sparse-repeat` | 5 次 | 相隔几百字的短句反复出现 | **默认关闭** |

后两档默认关闭，因为实测误报率高（详见"已知边界"）。想更严格，把 `cordis.patch.yml`
里的 `maxThinkingChars` 和 `sparseMinCount` 两行删掉即可恢复默认值。

---

## 被打断得太频繁，或该断没断

改 `cordis.patch.yml` 里 `config` 下的数值，**保存即热重载，不用重启**：

| 你遇到的情况 | 改哪个 |
|---|---|
| 正常长回复被打断 | 这一档默认已关闭；要开启就把 `thinkingOnlyMs` 设为 90000 或更大 |
| 模型正常列举步骤被打断 | 调大 `repeatThreshold`（如 5）或 `sentenceMinPeak` |
| 模型明明在空转却没被打断 | 调小 `repeatThreshold` |

所有可调项都在 `lib/index.js` 顶部的 `DEFAULTS` 里，键名就是配置名。

---

## 已知边界

这个插件靠文本特征判断"空转"，不是靠理解语义，所以有几处刻意留白：

- **代码块、表格、清单一律不参与判重**。这些内容天然是"结构相同的行"，
  参与判重会把你正常写代码误判成复读。代价是：如果模型真的在反复输出同一段代码，抓不到。
- **纯英文内容可能被过度过滤**。英文里的括号、分号会被当成代码特征。
- **四句以上的轮转复读抓不到**（`A B C D A B C D…`），峰值占比过不了 60% 阈值。
  单句复读没问题。
- **纯符号（`**`、`---`）不计入短句统计**——它们不是"废话"，是 Markdown 格式。
- **"纯思考超时"默认关闭**。flash 类模型深推理时经常几十秒不吐正文、不调工具，
  45 秒或 90 秒都会误伤；关掉后由"重复检测"三档负责识别真正的空转——
  真卡死的特征是**内容原地打转**，不是**沉默时长**。

**设计取向：宁可漏报，不误报。** 误报会打断你正在做的事，漏报只是退化回"手动中止"。

---

## 卸载

1. 从 `cordis.patch.yml` 删掉那段 `- insert:`
2. 删除 `plugins/dsh-thinking-guard` 目录
3. 重启 DSH

---

## 仓库结构

```
dsh-thinking-guard/
├── lib/index.js          插件本体（单文件，无依赖）
├── test/guard.test.mjs   19 条回归用例
├── cordis.patch.yml      挂载配置模板
├── package.json
└── README.md
```

跑测试：

```bash
node test/guard.test.mjs
```

---

## 这个修复版改了什么

相对上游 1.0.2，修掉的问题：

**会让对话直接坏掉的**

- Windows 上通知链路恒定失效：用原生绝对路径做 `await import` 被 ESM loader 拒绝，
  导致熔断说明和"自动继续"**从来没注入过**，你只看到回合莫名其妙中断
- 注入消息用了 `source.kind: 'plugin'`，v4 消息格式不认，写入校验失败后**整轮报错**
  `format v4 message requires a producer-owned source kind`
- 熔断时用了非法的 `agent.cancel` cause，harness 抛错后写出 `reason: null` 的
  `turn/end` 事件，**会话消息区直接白屏**

**会把正常输出误判成空转的**

- 表格、代码块、清单、JSON 在判重前没有剥离，数字归一化后互相等同 → 正常输出被熔断
- Markdown 的 `**` 被当成"短句"计数，8-13 次就触发稀疏复读
- 环境变量阈值没有下界，`REPEAT_THRESHOLD=0.5` 会让任何文本都熔断

**功能名不副实的**

- 尾部缓冲上限 1200 字符 < 声明的稀疏窗口 4000 字符，实际窗口只有标称的三成
- 重复单元上限 40 字，41-80 字的中长复读全部漏检
- 同一 attempt 重复收到 `start` 会反复归零计时锚点，超时档永不触发

**健壮性**

- `{agent: null}` 类载荷会让异常在事件总线内逃逸
- `package.json` 的 `files` 会把 `.bak` 备份当发布内容

测试从 11 条扩到 **19 条**，全部覆盖上述修复。

---

## 许可

MIT，原作者 Ethan Wong。本仓库是修改版，同样以 MIT 发布。
