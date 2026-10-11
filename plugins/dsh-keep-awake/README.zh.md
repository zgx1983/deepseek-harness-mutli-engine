---
description: "为有 Agent、终端或归属后台任务运行的 DSH Session 增加 macOS 空闲休眠防护。"
kind: "package-bundle"
---

# dsh-keep-awake

[English](README.md) | 中文

## 概述

将此组合包安装到 profile 后，只要 Agent、终端命令或归属会话的后台任务仍在运行，macOS 就不会因空闲而休眠；显示器仍可关闭。该组合包默认不启用，仅在 macOS 上运行；手动休眠、关机和合盖仍由系统处理。

## 目录

- [使用组合包](#use-this-bundle)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制和后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-bundle"></a>
## 使用组合包

### 安装到 profile

在仓库根目录运行：

```sh
dsh plugin --profile web add ./plugins/dsh-keep-awake
```

安装后重启 profile。Desktop 的独立管理 profile 也可在包含此组合包后加载它。移除 CLI profile 中的组合包时，运行 `dsh plugin --profile web remove dsh-keep-awake`。

### 功能

任一受跟踪工作开始时，Host 会启动一个受管 `/usr/bin/caffeinate -i -w <host-pid>` 进程；所有工作结束后终止该进程。`-i` 阻止系统因空闲而休眠，同时允许显示器关闭；Host 退出时，`-w` 也会让辅助进程退出。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节</summary>

组合包通过 `cordis.patch.yml` 插入 `keep-awake` 配置行。`index.js` 将 Agent 状态、终端命令活动和归属后台任务事件汇总为 Host 级活动集合。插件加载时读取现有 Agent 和终端状态，之后根据集合变化通过 `ctx.subprocess` 启停辅助进程。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

[Profile 参考](../../apps/cli/reference/README.zh.md)说明组合包安装和 profile 组合方式。[Subprocess 包](../../packages/subprocess/subprocess/README.zh.md)说明受管子进程的所有权和关闭行为。

-----

<a id="model-experience"></a>
## 模型体验

间接；此组合包不增加模型可见行为。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制和后续工作

此组合包仅支持 macOS。它只在 DSH 工作活跃时阻止空闲休眠，不覆盖手动休眠、关机或合盖。如果 `caffeinate` 意外退出，Host 会记录错误，并在下一次活动状态更新时重试。
