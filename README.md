# Chat Pin for Codex Desktop

这是一个针对 Windows 和 macOS Codex Desktop 的本地 UI 注入器。它不修改 Codex 安装包，也不读取或复制 Cookie、登录数据或聊天数据库。

## 启动

```powershell
npm start
```

Windows 也可以直接双击项目根目录的 `ChatGPT_Pin.cmd`，或使用安装到桌面/开始菜单的“Codex Chat Pin”快捷方式。启动脚本使用纯 ASCII 文件名和内容，以兼容不同 Windows 命令行代码页。快捷方式使用复制到项目 `assets/codex.ico` 的 Codex 官方应用图标。快捷方式仍会显示启动终端；保持终端运行，关闭它即可停止专用 Pin 实例。

启动器会打开一个使用项目内独立配置目录的 Codex 窗口，并通过私有 CDP 管道注入界面。首次使用该独立窗口时，可能需要在窗口中自行登录。保持启动器窗口运行；关闭启动器会停止其管理的 Codex 窗口。

启动器参照 Codex Taskboard 的桌面端启动方式定位官方应用：Windows 查找 Microsoft Store 包内的 `app\\ChatGPT.exe`，macOS 依次查找 `/Applications` 和 `~/Applications` 下的 `ChatGPT.app`、`Codex.app`，然后直接向桌面端传递独立 profile 与私有 CDP pipe 参数。`resources\\codex.exe`（macOS 中为 `Contents/Resources/codex`）是 CLI，不用于启动桌面界面。

部分 Windows 安装会拒绝 Node 直接创建 WindowsApps 内的桌面进程并返回 `spawn EPERM`。遇到该错误时，启动器会自动通过注册的 Codex AUMID 激活应用，传入相同的独立 profile，并使用随机的 `127.0.0.1` CDP WebSocket 端口继续注入。可用 `--windows-activation` 主动测试该路径。此端口没有额外身份验证，因此启动器运行期间只能运行受信任的本机程序。

默认独立 profile 位于项目的 `.codex-pin-profile`；测试或多实例场景可通过 `CODEX_PIN_PROFILE` 指定其他目录。

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
- 当 Codex 没有为右上角侧栏图标暴露稳定的可访问名称时，启动器会使用原生侧栏快捷键展开右侧区域，再继续打开文件。
- 原生文件 Tab 会固定在侧栏顶部；再次 Pin 同一会话时优先复用同名 Tab，避免新增重复页签。
- 精确文件名筛选会优先点击原生第一结果；仅在快速路径失败时进入慢索引兼容流程，成功提示会显示本次原生打开耗时。
- Pin 按会话隔离，主副本写入本项目的 `pins/pin_<会话ID>.md`。无法取得可靠会话 ID 时使用稳定路由摘要；取消置顶不会删除对应文件。
- 当 Codex 当前任务使用另一个本地工作区时，启动器会在该工作区的 `pins/` 目录生成同名 Pin 镜像，并让原生文件筛选器打开镜像；因此不再要求当前任务工作区必须是 Chat Pin 项目本身。
- 主副本和工作区镜像分别写入其 Git 仓库本机的 `.git/info/exclude`，避免 Pin 内容进入 Git；不会修改目标项目的 `.gitignore`。原生打开时会短暂移除对应本地排除规则，结束后立即恢复。非 Git 工作区没有本地排除文件，镜像会作为普通文件保留在工作区的 `pins/` 目录。旧版 `temp/pin_*.md` 会自动迁移。
- 标题、段落、粗体、斜体、删除线、引用、列表、代码块、链接、图片和表格会转换为 Markdown；代码块会剔除 Codex 的“纯文本/复制代码”等工具栏文字，并尽量保留 Python、JavaScript 等语言标记。复杂的自定义渲染仍可能降级为文本。
- 打开当前任务的 Pin Markdown 后，会在“查看源代码”左侧显示“修订”按钮。开启后，输入框上方持续显示修订目标；输入框只显示用户自己的修改要求，文件修改约束会在点击发送时由启动器附加，让 Codex 直接编辑当前工作区中的 Pin 文件，而不是从回复正文重新提取并覆盖 Markdown。
- 每轮修订发送前都会在独立 profile 的 `revision-history/` 中保存本地快照；最终助手回复完成后会比较文件哈希。文件确实变化时，工作区镜像会同步回本项目的 Pin 主副本；没有变化时会明确提示，不会把普通回答误报为成功修订。
- 修订模式只绑定当前任务和当前 Pin 文件；切换任务后会安全关闭。修订期间再次 Pin 新回复会要求确认，以免意外覆盖正在修改的文档。
- 写盘或原生打开失败会显示短暂错误提示，不会遮挡或替换 Codex 的聊天界面。
- 本版本不注入独立 Pin 页面；菜单中的“打开 Pin 文件”只是打开原生 Markdown 文件，不会创建自定义页面。

## 当前限制

- 每个 Codex 会话只有一个活动 Pin；尚未提供会话内多 Pin 或多 Tab。
- 回复与发送控件通过可访问名称和 DOM 结构识别；Codex 更新界面后可能需要调整选择器。
- 当前版本不实现划线标注、右键菜单、引用胶囊、原回复精确回链、差异预览和一键恢复。
- 工作区镜像只在修订事务完成或关闭修订模式时反向同步；未开启修订模式时，在原生文件页中的手动编辑不会自动同步到 Pin 主副本。
- 修订模式依赖 Codex 实际执行文件修改；它不会绕过 Codex 的权限确认。如果模型只给出说明而没有修改目标文件，插件会报告“文件没有发生变化”。
- 原生文件页的打开动作依赖当前 Codex 版本的侧栏菜单、文件筛选器和结果行布局；Codex 大版本更新后需要重新验证。
