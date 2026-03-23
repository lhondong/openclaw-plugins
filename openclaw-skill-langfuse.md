
为了解决 Openclaw 中对 skill read 和 complete 的记录，进行如下思考：

首先参考 Openclaw 的 PR: https://github.com/openclaw/openclaw/pull/16044

该 PR 提出 `onAgentEvent` 和 `onSessionTranscriptUpdate`

**`skill:read` 和 `skill:complete` 本来就是“高层语义事件”**，而 PR #16044 暴露的是更底层、信息更丰富的两类信号：

* `onAgentEvent`：实时拿到 agent 运行时事件，覆盖文本流、工具调用、生命周期等。PR 里的示例明确写了 `assistant` / `tool` / `lifecycle` 三类 stream。
* `onSessionTranscriptUpdate`：会话 transcript 一有更新就通知你，适合做补全、纠偏、跨 channel 汇总。

**`skill:read` 很容易判定。**：当 agent 读到 `SKILL.md` 时触发，本质上就是“**检测到 read 工具读了 `SKILL.md`**”，方法就是“read tool + path matching”。`onAgentEvent` 已经提供实时工具事件，所以只要看到一次工具调用命中 `.../SKILL.md`，就可以立刻发一个 Langfuse `skill.read`。
**`skill:complete` 没有唯一官方边界，需要 heuristic，issue 里给的定义是几种可能：显式 agent 信号、若干轮后无再读、或 skill 相关工具调用后的 turn boundary。也就是说，这两个 skill 事件从定义上就是可以由更底层事件推导出来的，而不是必须内建成专门 API。换句话说，就算官方真加了这个事件，底层大概率也还是某种启发式。既然 `onAgentEvent` 给了生命周期和工具流，`onSessionTranscriptUpdate` 给了 turn/transcript 边界，你已经拥有实现这些启发式所需的主要输入。([GitHub][2])

### 实现思路

把“skill 使用”当成一个临时 span：

1. **监听 `onAgentEvent`**

   * 如果事件是工具调用，且参数/路径命中 `/skills/<name>/SKILL.md`，创建或刷新一个 active skill session。
   * 记录：

     * `skillName`
     * `skillPath`
     * `sessionKey`
     * `runId`
     * `startTs`
     * `lastSeenTs`
     * `toolsUsed[]`

2. **继续监听 `onAgentEvent`**

   * 如果后续有 tool 事件，把工具名塞进 `toolsUsed`
   * 如果有 lifecycle end，记为一个很强的“可完成”信号
   * 如果再次读同一个 `SKILL.md`，刷新 `lastSeenTs`
   * 如果读到另一个 skill 的 `SKILL.md`，先把上一个 active skill 结算，再开启新的

3. **监听 `onSessionTranscriptUpdate`**

   * 把它当作“这一轮会话内容落盘/边界更清晰了”的信号
   * 当 transcript 更新后，检查 active skill：

     * 若最近一段时间没有再看到该 skill 的 read 或相关工具活动
     * 或者已经收到 lifecycle end
     * 就 emit `skill.complete`

### 完成判定规则

“三选一命中即完成”，按优先级结算：

* **强信号**：收到该 `runId` 的 `lifecycle end`。PR 说明 `lifecycle` 就是开始/结束类事件。([GitHub][1])
* **切换信号**：在同一 session 中又读了另一个 `SKILL.md`。这通常意味着上一个 skill 的指导阶段结束。
* **空闲信号**：transcript update 后 idle timeout，active skill 已经超过 N 秒没有新的相关 tool/read 事件。这个和 issue 里写的 “N turns after skill:read without re-reading” 本质一致。([GitHub][2])

### 上报 Langfuse

映射成两类 span 或 event：


* `skill.read`：创建一个 span（**只在第一次读某个 `SKILL.md` 时发一次**）
  * name: `skill:<skillName>`
  * input/meta: `skillPath`, `sessionKey`, `runId`
* `skill.complete`：结束这个 span，按优先级结算
  * output/meta: `toolsUsed`, `durationMs`, `success`
  `success` 这里稳妥的做法是：
    * 有明确报错/中断：`success = false`
    * 正常 lifecycle end 且无错误工具结果：`success = true`
    * 其余：`success = null` 或不填。([GitHub][2])
* `sessionKey + skillPath + runId` 作为去重主键
* 同一 skill 被重复 read，不新开 span，只更新 `lastSeenTs`
