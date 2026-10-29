/**
 * Prompts for the three DDoG sessions: root definition, expansion, parent judgment.
 *
 * One shared section states the method; each task section only states what that
 * session must produce. The text is the method itself — a node agent that has
 * never seen the conversation must be able to act from it alone.
 */

const SHARED = `## 共同原则

### 这套图在解决什么

固定层级的 DoG 图会腐化、无限膨胀，而且很多节点几乎从来不会错；判断“会不会错”需要真实失败来检验。

动态规则：运行过程中根据失败方式动态生成候选子节点，持久记录，后续对该父节点可见，但不单独起会话判定。候选失败超过 2 次且失败频率高于 20% 时转为正式子节点；正式子节点成功频率高于 90% 时进入退休评估；对它过往失败的案例，由父节点一并判定，一致性高于 80%（交叉熵，至少 5 次）时成为退休节点。

运行层负责：记录候选、正式、退休状态；按阈值转正、开始退休评估、退休；用交叉熵计算父项和子项在过去失败案例上的一致性。

节点 agent 负责：在父项的同一次会话里判定直接候选和退休子项；汇报每个子项的通过、失败或无法判定；发现现有子项没有覆盖的失败方式时提交新候选；不自行修改状态，不自行计算一致性。

### 父节点不许被已有候选限制

不要被已有的候选节点限制住思维。根据一句话定义做经院哲学般的思考，找出实质上、本质上不同的东西，做完全归类，找到所有角落，数学化划分等价类和穷举，找到各种思维方向。

### 苏格拉底四问与第一性原理

对每个节点的直接子项回答四问，并从第一性原理说明：

1. 为什么是这些子项？
2. 为什么只有这些子项？
3. 其他的为什么不是？
4. 为什么不能更精简？

第一性原理的写法：

- 把父节点当成实现某功能的整体，把功能写成一整句话；这句话是父节点的公理。
- 父定义是压缩过的内涵集合；下一层来自内涵的展开，失败方式只用来接触现实。
- 操作四步：拿一个真实失败，定位它落在定义里的哪一处内涵；展开那一处还包含哪些别的含义（对象、条件、程度、时序、依赖），并列成下位内涵；用现实中的相似失败检验每条下位内涵，优先检验还没被现实碰过的；最后用四问收口。
- 禁止：一个词配一个失败方式；把随手想到的失败方式并列成子节点；跳过内涵直接挂节点。三者都会得到同层混杂、互相重叠、还漏掉整片的图。
- 词是入口线索，不是配对单位：一个方面常由两个词共同承担，一个词也常承载多个内涵。
- 定位落空说明定义缺内涵：先补定义，再生成候选。
- 子项失败必须使父项失败；去掉这个子项，父项不能被完整刻画。
- 兄弟子项同面，互不包含；各自的失败可以独立发生。
- 分离案例：给出一份实物，使这个子项失败而兄弟子项通过。写不出分离案例，说明它们其实是一条。
- 领域知识用来填失败方式清单；上层抽象保持领域无关。
- 用形式逻辑和经院哲学检查排列和完备性；防止一个方面的实例实际上属于另一个父项。

### 定义、层级、追溯

- 每个节点是一句话定义，只有一个句末标点。
- 定义写被判断的性质，不写“怎么做”，不用分类、清单、总结代替性质。
- 定义使用词典能查到的词；不用比喻和自造词。
- 每个非根节点声明直接父项和层级；层级等于父项层级加一。
- 所有节点沿父项链走到根。
- 不预设总层数；不要求补全同一层；只保留有真实例子支持的路径。
- 中间抽象层先搭好；可以直接产生叶子候选，但叶子必须沿父项链走到根。
- 候选必须能追溯到一个真实例子：exampleIndex 是例子编号，trigger 是该行原文摘录。
- 根定义是复合命题；每个合取项至少有一个候选覆盖；覆盖不了就先生成候选。

### 输出方式

你只能通过写文件交付结果：把结果写成 JSON 写到提示末尾给出的绝对路径，然后停止。不要打印结果，不要写到别的路径。`

export interface RootPromptInput {
  readonly instruction: string
  readonly instructionFile: string | undefined
  readonly resultPath: string
}

/** Prompt for the session that turns a user instruction into the root definition. */
export function buildRootPrompt(input: RootPromptInput): string {
  return `${SHARED}

## 任务：根定义

输入：${input.instructionFile === undefined ? '用户指令（见下）' : `用户指令文件 ${input.instructionFile}（内容见下）`}。

输出：一句话定义，加一段简短 rationale。

要求：

- 根节点定义被验收对象本身，不是验收工具。
- 用一句话写清对象和判别谓语。
- 根定义来自用户原话，保留用户原话的语义空间；不要一开始就写成操作清单。
- 参考用户认可的例子：“学术论文是一种以可复核证据让读者相信并采用作者核心判断的论证文本。”
- 把根句拆成合取项；每个合取项是一个一级方面。
- 根定义需要满足：一句话；至少 20 个字符；包含定义谓语（是、指、作为、即、意味着）；与用户指令至少共享一个两字以上的片段。
- 不合格时按错误提示修正一次；仍不合格停止。
- 这个任务只定义根节点，不生成候选。

用户指令原文：

"""
${input.instruction}
"""

输出 JSON 形状：

{"definition": "一句话定义", "rationale": "简短说明"}

写到：${input.resultPath}
`
}

export interface ExpandPromptInput {
  readonly parentId: string
  readonly parentDefinition: string
  readonly parentLevel: number
  readonly existingChildren: readonly { readonly id: string; readonly definition: string }[]
  readonly examples: readonly string[]
  readonly source: 'production' | 'simulation'
  readonly isRoot: boolean
  readonly resultPath: string
}

/** Prompt for the session that proposes candidates under one parent. */
export function buildExpandPrompt(input: ExpandPromptInput): string {
  const children = input.existingChildren.length === 0
    ? '（无）'
    : input.existingChildren.map(child => `- ${child.id}：${child.definition}`).join('\n')
  const examples = input.examples
    .map((example, index) => `[${String(index + 1)}] ${example}`)
    .join('\n')
  return `${SHARED}

## 任务：生成候选

输入：父节点定义、父节点层级、现有子节点、真实例子、例子来源（production 或 simulation）。

父节点：${input.parentId}（层级 ${String(input.parentLevel)}）
父节点定义：${input.parentDefinition}

现有子节点：
${children}

例子来源：${input.source}${input.source === 'simulation' ? '（模拟只用于建图，不能混入真实结论）' : '（真实生产反馈，价值最高）'}

真实例子（每行一个，编号从 1 开始）：
${examples}

输出：候选树。

要求：

- 每个候选写 key、definition、parent、level、exampleIndex、trigger、rationale。
- level 等于父节点层级加一；parent 是本次父节点 id，或本次提交里的另一个 key；所有候选沿 parent 链走到本次父节点。
- 不预设总层数；不要求补全同一层；只提交例子支持的路径。
- exampleIndex 是例子编号；trigger 是该行原文摘录；两者必须对得上。
- ${input.isRoot ? '父节点是根节点：提交根槽位覆盖，每个根条件至少有一个候选，候选的定义必须真的覆盖该槽位。' : '父节点不是根节点，不需要提交根槽位。'}
- 候选一句话；说明它覆盖的失败方式，以及它与现有子节点的差别。
- rationale 必须写明：这个候选对应父定义里的哪一处内涵；那一处的哪条下位内涵由它承担；用哪个真实失败检验过它。
- 不重复现有子节点。
- 不写“怎么做”。
- 不用分类、清单、总结代替性质。
- 如果例子支持更具体的失败模式，先在父节点和叶子之间建立中间抽象层，再把叶子挂到中间层。
- 检查候选是否其实属于另一个父节点；是就改挂或拒绝。
- 这个任务只提出候选，不判定候选，不改状态。

输出 JSON 形状：

{"candidates": [{"key": "唯一键", "definition": "一句话", "parent": "${input.parentId} 或本次的另一个 key", "level": ${String(input.parentLevel + 1)}, "exampleIndex": 1, "trigger": "例子原文摘录", "rationale": "对应哪处内涵、哪条下位内涵、用哪个真实失败检验"}],
 "rootSlots": [{"slot": "根定义的一个合取项", "candidates": ["候选 key"]}]}

rootSlots 只在父节点是根节点时出现。

写到：${input.resultPath}
`
}

export interface ParentPromptInput {
  readonly parentId: string
  readonly parentDefinition: string
  readonly parentLevel: number
  readonly targetPath: string
  readonly rootSlots: readonly { readonly slot: string; readonly candidates: readonly string[] }[]
  readonly jointChildren: readonly { readonly id: string; readonly definition: string; readonly kind: 'candidate' | 'retired' }[]
  readonly formalChildren: readonly { readonly id: string; readonly definition: string }[]
  readonly retirementCases: readonly { readonly index: number; readonly evidence: string }[]
  readonly resultPath: string
}

/** Prompt for one parent session: its own verdict, its joint children, and new candidates. */
export function buildParentPrompt(input: ParentPromptInput): string {
  const joint = input.jointChildren.length === 0
    ? '（无）'
    : input.jointChildren.map(child => `- ${child.id}（${child.kind}）：${child.definition}`).join('\n')
  const formal = input.formalChildren.length === 0
    ? '（无）'
    : input.formalChildren.map(child => `- ${child.id}：${child.definition}`).join('\n')
  const slots = input.rootSlots.length === 0
    ? '（无）'
    : input.rootSlots.map(slot => `- ${slot.slot} ← ${slot.candidates.join(', ')}`).join('\n')
  const cases = input.retirementCases.length === 0
    ? '（本轮没有过往失败案例）'
    : input.retirementCases
      .map(item => `案例 ${String(item.index)}：${item.evidence}`)
      .join('\n')
  return `${SHARED}

## 任务：父项判定

输入：父节点定义、直接候选、正式子项、退休子项、过往失败案例、交付物。

父节点：${input.parentId}（层级 ${String(input.parentLevel)}）
父节点定义：${input.parentDefinition}
交付物路径：${input.targetPath}
根槽位覆盖：
${slots}

直接候选与退休子项（在本次会话里判定）：
${joint}

正式子项（各自独立判定；这里只用于检查覆盖）：
${formal}

过往失败案例（按顺序给 verdict）：
${cases}

输出：父项判定、每个直接候选或退休子项的判定、新候选、退休判定。

要求：

- 先判父项，再判每个直接候选和退休子项。
- 直接候选和退休子项都在本次会话里判定，不单独起会话。
- 正式子项独立判定，不在本次候选列表里；简报里的定义只用于检查覆盖。
- 如果候选的层级或父项不对，判为粒度错误，并在证据里指出正确的中间节点。
- 判完现有子项后，对本次失败在父定义里定位落在哪一处内涵；展开那处的下位内涵，看还有哪些没有被覆盖；对还没被现实检验过的内涵，主动寻找相似失败。用形式逻辑和经院哲学，不用分类标签。
- 检查每个失败方式是否已被直接候选、正式子项、退休子项或更深子项覆盖。
- 本次交付物命中未覆盖的失败方式时，提交 newCandidates：一句话定义，加交付物原文证据。
- 提交新候选时，父项必须判 fail。
- 新候选不重复已有子项的定义，包括正式子项。
- 汇报每个直接候选和退休子项的通过、失败或无法判定。
- 简报列出过往失败案例时，按顺序给每个案例一个 verdict，放在 retirementVerdicts；没有案例时不要提交该字段。
- 不自行决定转正或退休；只提交判定，运行层按阈值处理。
- 不要被已有候选限制；重新从父节点定义出发，找实质不同的失败方式。

输出 JSON 形状：

{"verdict": "pass | fail | inconclusive",
 "evidence": "父项判定依据",
 "candidates": [{"id": "子项 id", "verdict": "pass | fail | inconclusive", "evidence": "该子项的依据"}],
 "newCandidates": [{"definition": "一句话", "evidence": "交付物原文证据"}],
 "retirementVerdicts": ["pass | fail | inconclusive"]}

写到：${input.resultPath}
`
}
