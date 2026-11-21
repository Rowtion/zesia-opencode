# 在 OpenCode V2 安装 ZESIA 指定回复咨询

本入口安装 OpenCode 的可选原生适配器，并复用 ZESIA 公共 Skill 和 Runtime。OpenCode 和浏览器需要在同一台设备。安装不会发起咨询。

## 让当前 Agent 安装

先运行 `opencode --version`。该适配器使用 OpenCode V2 插件 API，已核验的最低版本是 2.3.2。若仍在 V1，请向用户说明需要升级，并由用户决定是否升级。升级说明见 [OpenCode 官方迁移指南](https://opencode.ai/docs/migrate-v1/)。

1. 从下列正式发行版下载资产及同名 `.sha256` 文件。核对 SHA-256 后将资产解压至空的临时目录。只接受包内普通文件和目录，发现重复路径、跳出目录路径或链接时停止。
   - [公共 Agent Plugin 0.4.14](https://github.com/Rowtion/zesia-skill/releases/tag/v0.4.14) 中的 `zesia-agent-plugin-0.4.14.zip`。
   - [共享 Setup 1.1.0](https://github.com/Rowtion/zesia-skill/releases/tag/setup-v1.1.0) 中匹配设备的 `zesia-setup-1.1.0-<target>.zip`。Apple 芯片 Mac 使用 `darwin-arm64`，Intel Mac 使用 `darwin-x64`。如果已经有 Node 20+，也可使用 `node` 脚本包。
   - [OpenCode V2 原生适配器 0.1.0](https://github.com/Rowtion/zesia-opencode/releases/tag/native-v0.1.0) 中的 `zesia-opencode-consult-0.1.0.tgz`。
2. 将公共包内完整的 `skills/zesia-consult/` 安装到 OpenCode 支持的 Skill 目录。用户范围默认用 `~/.config/opencode/skills/zesia-consult`。如果 OpenCode 使用自定义配置目录，采用它实际扫描的位置。遇到已有同名 Skill 时，原样保留并请用户选择范围或确认迁移。
3. 使用 Setup 自带的 Node 和其中的 `zesia-setup.mjs` 运行下列命令。把两处路径换成校验后的绝对路径，Windows 使用 Setup 同目录的 `node.exe`。Setup 会按机器平台校验并安装共享 Runtime，并打开首次引导。引导结果为 `seen` 时，之前已显示过。

   ```text
   <setup-node> <path-to-zesia-setup.mjs> agent-plugin "<安装后的 zesia-consult 目录>" --locale zh
   ```
4. 将适配器压缩包解到持久、用户可写的位置，例如 `~/.local/share/zesia/opencode/native/0.1.0/`。解包后的 `package/` 内应有 `package.json`、`tui.mjs` 和 `session-consult.mjs`。在 OpenCode V2 用户配置文件 `cli.json` 的 `plugins` 数组追加这个 `package/` 目录的绝对路径。用户配置文件通常是 `~/.config/opencode/cli.json`。保留原插件与其他设置，同一路径已经存在时直接复用。见 [OpenCode CLI 插件配置](https://opencode.ai/docs/cli/plugins/)。
5. 结束安装后请用户重开本机 OpenCode TUI，再验证命令面板有 **Review a reply with ZESIA** 和 **Show ZESIA opinion in this session**。安装、命令发现和咨询分别报告。等待用户自行选择回复和批准。

## 从指定回复跑到原会话

1. 在会话 A 生成一条可共享的回复，输入 `/zesia` 选择那条回复。知道 ID 时也可输入 `/zesia <回复 ID>`。
2. 在 `zesia.dev/consult` 核对实际材料。由你点击批准。可以在等待时切到会话 B。
3. 回到会话 A，输入 `/zesia-result` 查看意见。回执已经保存到会话 A。你继续和会话 A 对话时，OpenCode 会把已入队的意见交给原 Agent，ZESIA 随后标记 Agent 已收到。
