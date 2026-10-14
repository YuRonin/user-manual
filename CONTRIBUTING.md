# 参与 DocWitness

感谢帮助改进 DocWitness。提交问题时，请说明使用的 Node.js 版本、操作系统、目标 Next.js 路由类型，以及执行的 `manual` 命令。请附上可复现步骤、预期结果和实际结果；日志、截图和配置中先移除令牌、Cookie、个人信息及私有项目地址。

提交变更前，在仓库根目录运行：

```bash
npm ci
npm run test:unit
```

涉及浏览器采集、截图或帮助中心输出的变更，还应安装 Chromium 并运行：

```bash
npx playwright install chromium
npm run test:browser
```

请在变更说明里写清影响的命令或文档、验证结果，以及仍需人工核对的行为。手册中的产品事实和截图须有真实浏览器证据；示例、Fixture 和流程示意应明确标注。
