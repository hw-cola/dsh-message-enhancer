# @dsh/message-enhancer

DSH Web 聊天增强插件，提供四组能力：

## 功能一：消息与计划索引标尺

在聊天输入框上方的 Dock 中添加一条垂直索引，用于快速扫描和定位当前已加载的用户消息与最终计划：

- 仅展示用户消息和 steering 消息，识别 `exit_plan_mode` 提交的最终计划；
- 刻度颜色按用户操作结果着色：确认执行=绿色、空反馈拒绝=红色、提交反馈或去聊天里说=暖黄色、普通消息=灰色；
- 悬浮或键盘聚焦时显示白色圆角预览卡片，支持轻量 Markdown 渲染，底部显示类型/时间；
- 点击刻度将对应聊天节点滚动到聊天区域中部；有更早历史时顶部显示 `···`，每次点击加载一页；
- 无可索引内容时隐藏；切到“轨迹”Tab 自动隐藏，切回“对话”Tab 恢复。

## 功能二：计划审批卡与历史计划卡

- 保留原生计划审批位置、Markdown 内容和审批协议，样式替换为主题自适应的中性卡片；
- 标题栏提供复制完整 Markdown 的图标按钮；审批卡默认展开为大视口阅读模式，顶部手柄可切换回默认高度；
- 卡片底部可直接输入需调整的内容，非空时“拒绝”变为“提交反馈”；Enter 提交、Shift+Enter 换行、中文输入法组合期间不会误提交；
- “去聊天里说”保留为图标按钮，用于取消评审回到自由聊天；
- 每次“去聊天里说”“拒绝/提交反馈”或“确认执行”后，聊天时间线都会保留该版计划的历史卡（固定高度、底部渐变虚化提示内容未完整展示）；
- 历史卡可“放大窗口”悬浮阅读，内容完整可滚动，点遮罩、关闭按钮或 Esc 收起；
- 关闭“实时计划”或确认执行后，最新一张计划卡显示“用户接收的计划”徽章。

## 功能三：回复完成提醒（提示音 + Windows 系统通知）

模型整轮回复正常完成时提醒你，适合切到别的窗口等回复的场景：

- 设置入口位于 **设置 → 通用设置**，提供“回复完成提示音”“提示音类型”“Windows 系统通知”三行设置，状态保存在 `localStorage`，刷新后保持；
- 提示音为预置音效（经典叮咚、轻快三音、柔和单音），切换类型时立即试听；
- 触发时机为整个回合完成（`completed` / `max-tokens`）；点“停止”、模型报错、计划被退回时不提醒；
- 系统通知走浏览器 Notification API，窗口最小化或切到别的应用也会弹；通知标记静音，声音统一由提示音播放避免双响；
- 权限被浏览器拒绝或页面非 localhost/https 访问时，设置行显示恢复指引；
- 刷新或切换会话后，以当前已完成的最近回合为基线，打开旧会话不会误响。

## 功能四：最后一条用户消息气泡编辑重发（fork 分支重新生成）

最后一条用户消息气泡的复制按钮左侧出现铅笔按钮，点击后气泡原位变成输入框，改完直接发送——模型基于编辑后的文本重新回答，旧回复不出现：

- 编辑按钮只出现在**最后一条**用户消息上；Enter 发送、Shift+Enter 换行、中文输入法组合期间不会误提交、Esc 取消；
- 发送走 DSH 原生 fork 机制：从该消息之前的 completed turn 边界创建子会话并自动切换、发送编辑文本，模型重新回答；单轮会话（无历史 turn）时改为新建会话重发；
- 原会话自动归档（可从归档恢复），任一环节失败均保留原会话，不造成数据丢失；
- 发送前自动把父会话当前的模型选择与权限预设同步到子会话，重发后不丢模型和权限；
- 模型回复中编辑按钮置灰并提示“正在回复中”；空会话或没有用户消息时不显示；切换会话后悬挂的编辑态自动取消；
- 仅编辑文本内容，图片不随消息回带；编辑中的输入内容会被暂存，DSH 重渲染气泡时自动重建，不会丢字。

## 安装

前置要求：本机已安装 [dsh](https://github.com/deepseek-ai/deepseek-harness) 与 [pnpm](https://pnpm.io/)（`dsh plugin` 通过 pnpm 安装插件）。

### 他人安装（GitHub 直装）

```sh
dsh plugin --profile web add "git+https://github.com/hw-cola/dsh-message-enhancer.git"
```

钉到指定版本（按 tag 锁定）：

```sh
dsh plugin --profile web add "git+https://github.com/hw-cola/dsh-message-enhancer.git#v1.8.0"
```

### 他人安装（npm）

```sh
dsh plugin --profile web add @dsh/message-enhancer
```

### 本地开发

```sh
dsh plugin --profile web add "link:${PATH}/dsh-message-enhancer"
```

> `${PATH}`为下载源码的路径

## 更新

```sh
dsh plugin --profile web update @dsh/message-enhancer
```

若 pnpm 对 git 依赖的更新不生效，先卸载再重新安装：

```sh
dsh plugin --profile web remove @dsh/message-enhancer
dsh plugin --profile web add "git+https://github.com/hw-cola/dsh-message-enhancer.git"
```

## 卸载

```sh
dsh plugin --profile web remove @dsh/message-enhancer
```

安装后请重启 `dsh web`（让插件的 cordis 补丁层生效）并刷新浏览器页面；卸载后刷新页面即可恢复原生布局。

> 兼容性：插件在 DSH `0.1.1-rc.2` 上开发测试。客户端 API 仍在迭代，DSH 大版本升级后若功能异常，请检查本仓库是否有对应适配版本。