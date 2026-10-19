# 自研包

此目录只存放本仓库自行开发和维护的包。当前尚无功能包，不创建占位扩展。
第三方扩展仅在[根 README](../README.md#第三方扩展推荐)中推荐，不复制到此目录。

## 新增包约定

每个实际功能包使用一个 `packages/<目录名>/` 目录，并包含：

- `package.json`：独立包名、版本、描述及运行依赖。目录名不必等于 npm 包名。
- `README.md`：用途、安装方式、配置、前置条件及验证命令。
- 实际实现和与功能相匹配的测试。
- 发布前明确许可证和发布文件范围。

Pi 扩展包应通过 `package.json` 的 `pi` 字段明确声明实际提供的资源（extensions、skills、prompts、themes），不声明不存在的资源。按需设置 `files`，保证资源及运行所需文件进入发布产物。

宿主提供的 `@earendil-works/pi-*` 和 `typebox`，仅在使用时按 Pi 文档声明为 `peerDependencies`（`"*"`），不要放入运行依赖或打包进扩展。其他实际被代码使用的运行依赖由对应包自己声明；“推荐一起安装”不属于代码依赖。

各包独立版本、独立安装、独立发布。根目录只负责 npm workspaces，不提供 Pi 聚合入口。未准备发布的包应设置 `private: true`。

## 开发与验证

新增真实 workspace 后，在仓库根目录运行 `npm install`，同步根 `package-lock.json`。不要在各包中维护独立锁文件。

构建、类型检查和测试命令随具体功能包引入，并记录在该包 README；骨架阶段不提供空测试或虚假的通过状态。发布前应执行该包的验证命令和 `npm pack --dry-run --workspace <包名>`，检查发布文件。

本地试用时，先按该包说明安装依赖并完成必要构建，再将包目录通过 Pi 的本地路径机制加载。Pi 不会替本地路径包安装依赖；将仓库加入 npm workspaces 也不会自动启用扩展。

参考：[Pi Packages](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md)。实现具体扩展时，以目标 Pi 版本的随附文档为准。
