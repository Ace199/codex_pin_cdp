# Chat Pin for Codex Desktop

这是一个针对 Windows 和 macOS Codex Desktop 的本地 UI 注入器。它不修改 Codex 安装包，也不读取或复制 Cookie、登录数据或聊天数据库。

## 启动

```powershell
npm start
```

启动器会打开一个使用项目内独立配置目录的 Codex 窗口，并通过私有 CDP 管道注入界面。首次使用该独立窗口时，可能需要在窗口中自行登录。保持启动器窗口运行；关闭启动器会停止其管理的 Codex 窗口。

启动器参照 Codex Taskboard 的桌面端启动方式定位官方应用：Windows 查找 Microsoft Store 包内的 `app\\ChatGPT.exe`，macOS 依次查找 `/Applications` 和 `~/Applications` 下的 `ChatGPT.app`、`Codex.app`，然后直接向桌面端传递独立 profile 与私有 CDP pipe 参数。`resources\\codex.exe`（macOS 中为 `Contents/Resources/codex`）是 CLI，不用于启动桌面界面。

应用安装在非默认位置时可显式指定。macOS 可传 `.app` 路径或内部可执行文件；Windows 传桌面端 `ChatGPT.exe`：

```powershell
node scripts/pin-launcher.mjs --launch --watch --app-path "C:\\path\\to\\ChatGPT.exe"
```

```bash
node scripts/pin-launcher.mjs --launch --watch --app-path "/custom/Codex.app"
```

也可以使用环境变量 `CODEX_PIN_APP_PATH`。`explorer.exe shell:AppsFolder\\<AUMID>` 适合普通启动，但不能建立本项目所需、绑定到当前 Node 进程的私有 CDP pipe，因此不作为注入启动路径。

## 当前功能

- 仅在最终助手回复的操作区追加 Pin 图标；不会在用户消息或代码块的复制按钮旁添加。
- 点击 Pin 后先把整条助手回复转换并保存为 Markdown，再用 Codex 原生“打开文件”侧栏页打开。
- 在侧栏未打开时的入口菜单和侧栏标签页“+”菜单底部，都会追加“打开 Pin 文件”；点击后直接打开当前任务对应的 Markdown。
- 原生文件 Tab 会固定在侧栏顶部；再次 Pin 同一会话时优先复用同名 Tab，避免新增重复页签。
- 精确文件名筛选会优先点击原生第一结果；仅在快速路径失败时进入慢索引兼容流程，成功提示会显示本次原生打开耗时。
- Pin 按会话隔离，写入项目下的 `pins/pin_<会话ID>.md`。无法取得可靠会话 ID 时使用稳定路由摘要；取消置顶不会删除对应文件。
- 启动器会将 `pins/pin_*.md` 写入本机 `.git/info/exclude`，避免 Pin 内容进入 Git；仓库 `.ignore` 再将这些文件暴露给 ripgrep/Codex 文件筛选器。旧版 `temp/pin_*.md` 会自动迁移。
- 标题、段落、粗体、斜体、删除线、引用、列表、代码块、链接、图片和表格会转换为 Markdown；复杂的自定义渲染仍可能降级为文本。
- 写盘或原生打开失败会显示短暂错误提示，不会遮挡或替换 Codex 的聊天界面。
- 本版本不注入独立 Pin 页面；菜单中的“打开 Pin 文件”只是打开原生 Markdown 文件，不会创建自定义页面。

## 当前限制

- 每个 Codex 会话只有一个活动 Pin；尚未提供会话内多 Pin 或多 Tab。
- 回复与发送控件通过可访问名称和 DOM 结构识别；Codex 更新界面后可能需要调整选择器。
- 当前版本不实现修改模式、划线标注、右键菜单、引用胶囊和原回复精确回链。
- 原生文件页的打开动作依赖当前 Codex 版本的侧栏菜单、文件筛选器和结果行布局；Codex 大版本更新后需要重新验证。
