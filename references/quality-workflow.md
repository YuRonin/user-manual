# 可用手册的验收与实践

## 页面与任务

页面不是按钮清单。通过 describe 的 guide 数组记录具体操作，每项含 id、title、instruction，可选 target（真实可见控件）和 taskId（已发布任务）。最多选择五个关键 target；页面截图编号与说明顺序对应。说明应包含入口、输入要求、结果与空状态。没有 guide 时仅作为总览，不能声称完整教程。

任务 instruction 中的按钮名必须与实际 UI 一致。动作句由结构化 action 生成；补充说明解释目的、输入和结果，避免重复动作句。每个关键转折或最终结果都应声明 capture；标号对应任务步骤号。完成声明必须绑定界面断言，不用 URL 相同来证明业务完成。

## 先检查数据与页面

新建任务、改过定位或数据前提不确定时，执行 manual plan-capture <id> --live 做真实只读预演；仅检查到写操作前，不发布截图或修改任务证据。已有新鲜采集证据的重复生成可跳过这一步。文本 preconditions 供读者阅读，step.requires 用可执行断言检查实际数据。例如技能结果可见、输入框可编辑。前提不满足时报告缺少什么，不猜测第一个结果、不盲目重试。

跨页动作声明 pageAfter，stateAfter 引用目的页状态；未显式指定后置状态时，相邻步骤切页可推断目的页。优先使用 role/name、label 或 testId；必要时用 within 限定范围。alternatives 只能填写已观察到的同一控件的替代定位，不允许宽泛 first-child。回退定位会留下记录，在线验证把它报告为不确定，供维护者修正。

## 已授权测试写操作

默认 write 停止，destructive 不执行。用户已授权测试实践且需要验证提交结果时，在登记的非生产 environment 中配置 task.writeAuthorization：origin、steps（精确步骤 id）、expiresAt、decisionRef（现有用户授权依据，不含凭证）。环境在 config.fixtures.environments 登记 origins。授权字段参与任务审批，运行时检查当前 origin 和有效期。

获授权的 write 采集不自动重试。出现 outcome-unknown 后，先检查现有结果；不要重新生成导致重复提交。plan-capture --live 和 verify --live 始终只执行安全步骤。授权到期不会影响已发布证据，但禁止再次写入。

如果已提交的结果存在，而最后状态断言或截图失败，先修正不稳定的界面断言并重新批准变更后的任务范围。用 `manual capture-task <id> --reconcile-url <已有会话URL> --prior-captures <此前截图ID, ...>` 只读核对该会话并补采最终截图。此命令要求提交前截图完整、任务定义与场景一致，并在既有会话中找到本次输入和完成状态；它不会重复任何任务动作。核对成功后运行 `manual generate task:<id> --offline --copy-default`，避免重新提交。

## 图片、验证和交付

交付前逐篇按读者的实际任务审阅，而不是仅以 Runtime 发布成功为准：

1. 标题写清用户要完成的结果；「开始前」列出真实权限、数据或素材要求。
2. 每步只描述一个可见动作，控件名称与截图一致；相邻两句不能重复同一动作（例如“点击发送”后又写“点击发送”）。
3. 关键输入给出可替换的示例或格式，不把测试数据写成唯一可用内容。
4. 完成标志对应最后一步的界面断言；若证据只到提交前，就写“提交后预期看到”，不能写“已验证”。
   规划出现 `completion-before-final-step` 时，检查任务模型里的 claim checkpoint；这是审阅提醒，不代表前一步的结果一定无效。
5. 登录失效、无数据、搜索不到结果等常见分支，至少说明如何返回或检查前提；没有观察到的错误行为不编造。
6. 截图紧跟相关步骤，核对标注位置和可读性；缺关键截图时把文档标为待补证据。

`--copy-default` 是省去模型文案等待的快速草稿路径。上述检查发现含糊、重复或错误完成声明时，修正任务模型或提供经过审阅的文案块，再交付。

只引用 images/annotated 发布图，原图、诊断图与认证缓存始终私有。查看最终发布图：标注是否对应说明、文字是否清楚、遮挡是否覆盖关键区域。image-heavily-redacted 提示改用演示数据或局部截图，不删除隐私保护。image-unannotated / step-image-missing 提示补关键图或解释为何无需截图。

verify --artifacts 仅证明文件与事实一致，onlineChecked=false；不能报告业务成功。verify --live 检查当前可回放界面。报告已执行步骤数量、绑定且通过的完成声明，以及停止点。没有绑定断言的业务结果始终是预期。

每次 Runtime 发布会更新 docs.outputDir/index.md 的 manual:catalog 区块，区块外人工文字保留；已有无标记的 index.md 保留并提示。交付时从该入口核对文档、图片与任务链接。

## 本地修改后安装

将已验证的源码安装到实际调用的 skill 目录，保留可恢复备份，不包含 .git 或业务数据；在安装目录执行 npm ci。按客户端安装别名：node bin/install-compat.js --client codex（或 claude / all）。再次实践必须调用安装目录的 bin/manual.js；报告源码与安装副本是否一致。
