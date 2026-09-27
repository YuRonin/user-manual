'use strict';

/*
 * CLI 命令注册表：bin/manual.js 的分发/帮助与 compat 别名安装共用这一份数据，
 * 避免两份手写命令列表各自漂移。只放可读元数据，模块在命中命令时才 require。
 */

const COMMANDS = [
  { name: 'auth', module: 'auth', summary: '登录并管理可跨 worktree 复用的浏览器认证档案' },
  { name: 'init', module: 'init', summary: '初始化当前项目的用户手册配置，生成 .manual/config.yaml' },
  { name: 'inspect', module: 'inspect', summary: '扫描项目路由，建立页面模型，生成 .manual/project.yaml 与 pages/' },
  { name: 'describe', module: 'describe', summary: '把页面的源码分析结果（标题/用途/操作）写回页面模型' },
  { name: 'capture', module: 'capture', summary: '用真实浏览器采集页面或任务证据（只推进到证据提交）' },
  { name: 'generate', module: 'generate', summary: '规划并执行：按需采集 → 事实草稿 → 文案 → 发布门槛 → 发布（可 --plan 预览）' },
  { name: 'update', module: 'update', summary: '根据源码变化增量更新已发布手册（可 --plan 预览影响与原因）' },
  { name: 'status', module: 'status', summary: '查看 Run 的任务状态、等待原因、失败与缓存命中说明（只读）' },
  { name: 'resume', module: 'resume', summary: '从任务快照继续执行 Run；输入变化时用 --replan 创建新 Run' },
  { name: 'run-submit', module: 'run-submit', summary: '提交宿主模型对交接请求的响应，解除等待' },
  { name: 'approve-tasks', module: 'approve-tasks', summary: '人工确认、调整或拒绝候选用户任务' },
  { name: 'discover-tasks', module: 'discover-tasks', summary: '从页面证据提出候选用户任务，等待人工确认' },
  { name: 'plan-capture', module: 'plan-capture', summary: '为已批准任务生成可审阅的安全截图计划' },
  { name: 'capture-task', module: 'capture-task', summary: '按安全边界执行任务步骤并采集原始证据' },
  { name: 'generate-task', module: 'generate-task', summary: '生成并校验任务型指南' },
  { name: 'verify', module: 'verify', summary: '验证任务文档、图片和结构化事实' },
  { name: 'publication', module: 'publication', summary: '查看与恢复中断的发布事务（status / repair）' },
  { name: 'migrate', module: 'migrate', summary: '显式迁移旧项目到 v2 模型（--dry-run / --apply / --rollback）' },
  { name: 'migrate-artifacts', module: 'migrate-artifacts', summary: '检查旧页面原图并安全复制到非发布产物目录' },
  { name: 'gc', module: 'gc', summary: '按保留策略回收未引用的临时文件、原图与旧 Run（默认只列出，--apply 执行）' },
  { name: 'doctor', module: 'doctor', summary: '只读检查 Node、依赖、浏览器、配置与认证缓存环境' },
];

// 已规划但尚未实现的子命令：命中时给出明确说明，而不是「未知命令」
const PLANNED = [];

function findCommand(name) {
  return COMMANDS.find((command) => command.name === name) || null;
}

function loadCommand(command) {
  return require(`../commands/${command.module}`);
}

module.exports = { COMMANDS, PLANNED, findCommand, loadCommand };
