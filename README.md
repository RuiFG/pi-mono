# pi-mono

RuiFG 的 Pi 自研扩展仓库，同时记录日常使用的第三方扩展推荐。

参考 [jvm/pi-mono](https://github.com/jvm/pi-mono) 的 monorepo 组织方式：自研包集中开发，各包独立安装、独立发布。这里不是 Pi 核心的 fork，也不是所有推荐扩展的聚合安装包。

## 当前状态

仓库目前仅包含 npm workspaces 骨架，尚无自研功能包。

- `packages/` 只放自行开发、维护的包。
- 第三方扩展仅在本文推荐，按需通过 Pi 原生机制安装。
- 不提供安装器、套餐管理、自动更新或外部服务部署。
- 根包设置 `private: true`，不发布到 npm；安装根仓库不会自动启用所有扩展。

## 仓库结构

```text
pi-mono/
├── packages/
│   └── README.md          # 新增自研包的约定
├── .gitignore
├── package.json           # private + npm workspaces
├── package-lock.json
└── README.md
```

## 自研包

暂无。新增功能包后，在这里维护用途、文档链接和安装方式。

开发约定见 [packages/README.md](./packages/README.md)。

### 本地开发

准备支持 npm workspaces 的 Node.js/npm；开发具体扩展时，还需安装目标版本的 Pi。

```bash
git clone https://github.com/RuiFG/pi-mono.git
cd pi-mono
npm ci
```

当前没有外部 npm 依赖，`npm ci` 仅验证并准备根项目，不会安装 Pi 或推荐扩展。构建和测试工具随首个实际功能包引入；骨架阶段不声称有功能测试覆盖。

## 第三方扩展推荐

以下扩展由各自上游维护，不属于本仓库的自研代码或必装依赖。按需安装，不需要全部启用。

安装前请查看上游说明、所支持的 Pi 版本和授权要求。扩展会执行代码；推荐不等同于安全审计或兼容性保证。下面的命令在终端执行，默认安装到用户级 Pi 环境，而不是当前仓库。

### 已核对 npm 来源的扩展

| 扩展及上游 | 用途 | 安装命令 |
| --- | --- | --- |
| [@juicesharp/rpiv-ask-user-question](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question) | 结构化提问与选项交互 | `pi install npm:@juicesharp/rpiv-ask-user-question` |
| [@juicesharp/rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) | 任务列表与进度跟踪 | `pi install npm:@juicesharp/rpiv-todo` |
| [pi-codex-image-gen](https://github.com/jvm/pi-mono/tree/main/packages/pi-codex-image-gen) | 图像生成与编辑；需按上游说明配置认证 | `pi install npm:pi-codex-image-gen` |
| [pi-lens](https://github.com/apmantza/pi-lens) | LSP、代码导航与诊断；语言工具要求见上游 | `pi install npm:pi-lens` |
| [pi-live-models](https://github.com/wait4xx/pi-live-models) | 动态模型发现与目录覆盖；需相应提供商配置 | `pi install npm:pi-live-models` |
| [pi-subagents](https://github.com/nicobailon/pi-subagents) | 子代理委派与工作流；需可用的模型配置 | `pi install npm:pi-subagents` |
| [pi-web-access](https://github.com/nicobailon/pi-web-access) | 搜索与网页等内容获取；提供商认证要求见上游 | `pi install npm:pi-web-access` |

已核对上述 npm 包的名称、仓库元数据和 Pi 资源声明；未在本仓库执行安装或组合兼容性测试。命令不固定版本，默认由上游 npm `latest` 标签决定安装版本。这不意味着每次启动 Pi 都会自动升级，也不保证所有上游最新版始终相互兼容。

`pi-lens` 与 `pi-web-access` 的 npm 包已声明其 `dist` 资源入口，不要给安装包名追加 `:dist`。

### 待补充分发来源的集成

| 项目 | 用途 | 当前说明 |
| --- | --- | --- |
| OpenViking 接入扩展 | 持久上下文与记忆接入 | 具体 Pi 扩展的公开来源和安装入口待核对；不能把服务端项目或同名包直接当作 Pi 扩展。需自行准备服务及访问配置。 |
| `orca-agent-status.ts` | Orca 代理状态集成 | 单文件扩展的上游来源、分发和宿主要求待核对；暂不提供自动安装命令。 |

以上项目仅保留推荐记录，不复制本机文件、不提交服务地址或凭据，也不编造 npm 包名。

### 安装后的管理

```bash
pi list
pi config
```

`pi list` 查看已配置的包，`pi config` 管理资源启用状态。包已配置或安装完成，不代表扩展已正常加载，也不代表服务连接和认证已通过；按各自上游说明验证功能。

更新和卸载交给当前 Pi 版本的原生命令。更新前查阅 `pi update --help`，不要将 `pi update` 无参数理解为仅更新扩展。本仓库不修改或接管个人 Pi 配置。

## 许可证与发布

骨架阶段尚未选定本仓库自研代码的许可证；公开可见不代表授予开源许可。加入并发布实际功能包前，应明确对应许可证、包名及发布范围。第三方扩展始终遵循各自上游许可证。
