'use strict';

/*
 * CLI 命令注册表：bin/manual.js 的分发/帮助与 compat 别名安装共用这一份数据，
 * 避免两份手写命令列表各自漂移。只放可读元数据，模块在命中命令时才 require。
 *
 * group 决定帮助里的分组与文档位置：
 *   core      主流程，SKILL.md 正文与客户端别名只覆盖这一组
 *   task      任务型指南的建模与审阅
 *   run       Run 查看与继续
 *   advanced  单独采集、写操作恢复、发布事务、回收与迁移；按需在 references 中说明
 *   legacy    兼容入口：仍可执行，但不出现在帮助与主文档中，迁移窗口结束后移除
 */

const GROUPS = [
  { id: 'core', title: '主流程' },
  { id: 'task', title: '任务型指南' },
  { id: 'run', title: 'Run 查看与继续' },
  { id: 'advanced', title: '高级与维护' },
];

const COMMANDS = [
  { name: 'init', group: 'core', module: 'init', summary: '初始化当前项目的用户手册配置，生成 .manual/config.yaml' },
  { name: 'inspect', group: 'core', module: 'inspect', summary: '扫描项目路由，建立页面模型，生成 .manual/project.yaml 与 pages/' },
  { name: 'describe', group: 'core', module: 'describe', summary: '把页面的源码分析结果（标题/用途/操作）写回页面模型' },
  { name: 'auth', group: 'core', module: 'auth', summary: '登录并管理可跨 worktree 复用的浏览器认证档案' },
  { name: 'generate', group: 'core', module: 'generate', summary: '规划并执行：按需采集 → 事实草稿 → 模型文案 → 发布门槛 → 发布（可 --plan 预览）' },
  { name: 'update', group: 'core', module: 'update', summary: '根据源码变化增量更新已发布手册（可 --plan 预览影响与原因）' },
  { name: 'verify', group: 'core', module: 'verify', summary: '验证已发布手册：离线产物检查或 --live 在线回放' },
  { name: 'site', group: 'core', module: 'site', summary: '把已发布手册渲染成静态帮助中心网站（首页目录 + 正文页 + WebP 截图）' },
  { name: 'doctor', group: 'core', module: 'doctor', summary: '只读检查 Node、依赖、浏览器、配置与认证缓存环境' },
  { name: 'task-guide', group: 'task', module: 'task-guide', summary: '从一句任务目标找入口页面，生成只读建模工作表' },
  { name: 'discover-tasks', group: 'task', module: 'discover-tasks', summary: '从页面证据提出候选用户任务，等待人工确认' },
  { name: 'approve-tasks', group: 'task', module: 'approve-tasks', summary: '人工确认、调整或拒绝候选用户任务' },
  { name: 'review-task', group: 'task', module: 'review-task', summary: '只读审阅目标覆盖、完成证据与逐步截图；--preview 生成读者视图' },
  { name: 'status', group: 'run', module: 'status', summary: '查看 Run 的任务状态、等待原因、失败与缓存命中说明（只读）' },
  { name: 'resume', group: 'run', module: 'resume', summary: '继续 Run；可同时提交模型响应（--request/--input），输入变化时用 --replan' },
  { name: 'capture', group: 'advanced', module: 'capture', summary: '只采集页面、任务或 Scenario 证据，不生成文档' },
  { name: 'plan-capture', group: 'advanced', module: 'plan-capture', summary: '查看任务的安全截图计划；--live 做只读预演' },
  { name: 'capture-task', group: 'advanced', module: 'capture-task', summary: '写操作结果核对与续采（--reconcile-url / --continue-url）' },
  { name: 'publication', group: 'advanced', module: 'publication', summary: '查看与恢复中断的发布事务（status / repair）' },
  { name: 'gc', group: 'advanced', module: 'gc', summary: '按保留策略回收未引用的临时文件、原图与旧 Run（默认只列出，--apply 执行）' },
  { name: 'migrate', group: 'advanced', module: 'migrate', summary: '显式迁移旧项目到 v2 模型（--dry-run / --apply / --rollback）' },
  { name: 'run-submit', group: 'legacy', module: 'run-submit', summary: '兼容：提交模型响应；请改用 resume --request --input' },
  { name: 'generate-task', group: 'legacy', module: 'generate-task', summary: '兼容：分步生成任务指南；请改用 generate task:<id>' },
  { name: 'migrate-artifacts', group: 'legacy', module: 'migrate-artifacts', summary: '兼容：检查旧页面原图并复制到非发布产物目录' },
];

// 已规划但尚未实现的子命令：命中时给出明确说明，而不是「未知命令」
const PLANNED = [];

function findCommand(name) {
  return COMMANDS.find((command) => command.name === name) || null;
}

function loadCommand(command) {
  return require(`../commands/${command.module}`);
}

/** 帮助与文档可见的命令（不含兼容入口）。 */
function visibleCommands() {
  return COMMANDS.filter((command) => command.group !== 'legacy');
}

module.exports = { GROUPS, COMMANDS, PLANNED, findCommand, loadCommand, visibleCommands };
