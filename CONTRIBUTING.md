# Contributing to Web Agent Bridge

感谢你对本项目的兴趣！欢迎提交 Issue 和 Pull Request。

## 开发环境搭建

```bash
git clone https://github.com/<your-username>/web-agent-bridge.git
cd web-agent-bridge
npm install
```

## 开发流程

1. Fork 本仓库
2. 创建功能分支：`git checkout -b feature/my-feature`
3. 进行修改并确保通过类型检查：`npx tsc --noEmit`
4. 提交变更：`git commit -m 'feat: add some feature'`
5. 推送分支：`git push origin feature/my-feature`
6. 创建 Pull Request

## Commit 规范

使用 [Conventional Commits](https://www.conventionalcommits.org/)：

- `feat:` 新功能
- `fix:` Bug 修复
- `docs:` 文档更新
- `refactor:` 重构
- `test:` 测试相关
- `chore:` 构建/工具变更

## 添加新的 Web Agent 适配器

这是目前最有价值的贡献方向！请参考 README 中的 [添加新的 Web Agent 适配器](README.md#添加新的-web-agent-适配器) 部分。

每个适配器需要：

1. `extension/adapters/<agent-name>.js` — DOM 操作逻辑
2. 在 `extension/manifest.json` 中添加对应的 content_scripts
3. 在 `server/agent-card.ts` 中添加对应的 skill
4. 可选：添加 E2E 测试脚本

## 报告 Bug

请在 Issue 中包含：

- 你的操作系统和 Chrome 版本
- 重现步骤
- 预期行为 vs 实际行为
- 相关的控制台日志（浏览器 DevTools 和 Node.js 服务端）

## 行为准则

请保持友善和尊重。我们欢迎来自所有背景的贡献者。
