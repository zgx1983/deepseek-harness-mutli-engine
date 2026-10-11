# Agent Note：桌面端收起的侧边栏预览覆盖到会话之上

Status: implemented

[English](2026-10-09-sidebar-hover-preview.md) | 中文

## 问题

macOS 与 Windows 桌面端收起侧边栏后不保留轨道：`AppFrame` 把收起的列求解为零宽，并把重新打开的控件移入窗口 chrome。于是想看工作区浏览器、最近会话分区或全局面板列表，都必须真正展开一次——改变网格轨道、让中栏重排、触发整段列过渡；仅仅为「看一眼边缘后面有什么」就付出一次完整布局转变。Web 布局没有这个缺口，因为收起的侧栏保留 56px 图标轨道。[macOS 隐藏标题栏 Agent Note](2026-09-13-macos-hidden-titlebar-vibrancy.zh.md) 拥有本预览所开启的收起态与 `shell.leading` 座的约定。

## 决策

**预览归框架所有；侧栏只是重新读取自己的 `wide` 标记。** `sidebarPeeking` 与 `narrowExpanded` 同放在布局 store 中，因为二者都是框架的呈现状态而非用户偏好。`AppFrame` 由 `collapsedWidth === 0` 推出 `peekEligible`，因此 Web 从不预览；它把 `peeking` 与作为占用方宽度的 `SIDEBAR_DEFAULT` 一并传给侧栏。`SidebarRoot` 把 `peeking` 映射到 `wide`，按传入宽度绘制而不是按自己冻结的上次展开宽度，并且不参与收起的交叉淡出。

**预览呈现的是同一个既有列，而不是第二个列。** 该列仍是网格项目，留在收起后的零宽轨道内，只是画得比轨道更宽：AppFrame 给该列行内预览宽度，AppFrame.module.css 以 `position: relative`、层级 17 把它提到中栏之上。右栏那种锚定式的绝对定位面板不能照搬到这里——绝对定位会让该列退出网格流，中栏随即被自动放置进那条零宽轨道，会话整片空白。预览不占用轨道，也不写入宽度偏好：网格模板、中栏宽度和每个打了 `data-window-drag` 标记的行都原地不动，因此 Electron 按几何合成的拖拽区域从不变化，框架的拖拽区重采集脉冲也就保持空闲。填充改用不透明的 `--dsw-alias-bg-base` 并以 `--dsw-elevation-panel` 分离，而不是模糊的半透明填充——被滤镜命中的祖先会成为本列中固定定位设置面板的包含块。

**层级取 17**：位于它所取代的 `shell.leading` 控件（15）之上、`shell.overlay`（20）之下，于是菜单、提示条、对话框以及右侧面板的全屏呈现（40）都保持原有位置。

**触发是一次停留，消失分两级。** 指针进入左缘条带（自 `--dsh-frame-top-clearance` 之下起，因此永不盖住红绿灯）或 `shell.leading` 控件时启动 150ms 计时；只有 `pointerModality()` 报告当前是指针输入、且 `modalSelector()` 在顶层没有发现任何占用者时才打开预览。指针移出后 200ms 隐藏——沿用 `POINTER_GRACE_MS` 的手部移动速度理由——但面板内的第一次按下会停用移出隐藏，此后要靠在外部按下经 `useDismissOnOutsidePointer` 才消失。这个分裂是必需的：本列的菜单会 portal 到 `document.body`（`ui-workspace` 的行菜单与搜索菜单），移出事件无法区分「正走向我自己的菜单」和「离开这一列」。

**预览期间按下侧栏开关会把预览提交下来。** store 的 `toggleSidebar` 在 `sidebarPeeking` 置起时写入一次真实展开，而不是盲目翻转偏好；提交遵循「收起即忘记拖动宽度」这条既有规则，因此提交后的列宽是 `SIDEBAR_DEFAULT`。`setSidebar`、数值发生变化的 `setViewportWidth` 与 `openRightbar` 会清除预览；`closeRightbar` 与面板选择不清除。

## 备选方案

**把侧栏列做成 Factory 的第二渲染位。** 独立渲染位置需要各自的 store 句柄和一个第二份活着的工作区浏览器：两套滚动位置、两套目录展开集、两份额外的目录流占位，而没有人真的想要重复这一列。

**照右栏在无轨道时的做法，把预览列绝对定位到框架左边缘。** 它让该列离开网格流，于是中栏占据收起轨道、会话以零宽渲染；本预览的第一版实现正是如此。

**悬停时直接展开真实轨道。** 每次停留都会让中栏重排并移动该列所属的被打标记 chrome 行，于是每次悬停都要付出一次网格过渡加一次 Electron 拖拽区重采集。

**把预览渲染进 `shell.overlay`。** overlay 属于另一个 slot owner；在两个渲染点之间移动子树会重新挂载它，重挂载浏览区域不重新获取任何东西，却丢掉它的局部状态。

**从 `ui-primitives` 导出 `usePointerGrace`。** 它是 `Menu` 与 `HoverCard` 的内部关闭计时器；让框架自带一个具名停留时长，比为一个调用方加宽共享原子更合适。

**经 `useModalLayer` 处理 Escape。** 预览不是模态层；指针驱动的移出与外部按下已经覆盖它，而注册它会把顶层 Escape 仲裁从对话框和菜单手里夺走。

**为键盘提供触发入口。** 键盘用户通过既有开关到达侧栏，那是他们可以导航的持久展开；一个只能靠焦点唤起的悬停面板会把焦点困在两个渲染点之间。

## 结果

纯键盘操作的会话需要先有一次指针按下，悬停预览才会武装，因为文档输入模态跟随最后一次输入。预览按 `SIDEBAR_DEFAULT` 绘制，永不使用被忘记的拖动宽度。列自己的开关在预览期间保留 `toggle.open` 名称，因为按下它是提交而非隐藏。Windows 上左缘条带是唯一入口：它的重新打开控件位于标题栏行内，框架在那里不挂载 `shell.leading`。以全屏呈现的右侧面板仍然覆盖整个框架，也覆盖预览条带。覆盖测试位于 `packages/client/ui-layout/tests/layout-store.client.spec.ts`、`packages/client/ui-layout/tests/app-frame.client.spec.tsx`，以及 `packages/client/ui-sidebar/tests/sidebar-root.client.spec.tsx` 的 `previewing a closed sidebar` 分组；未预览时出厂侧栏快照渲染的标记不变。
