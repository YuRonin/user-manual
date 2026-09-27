'use strict';

/*
 * 故障注入检查点（仅测试使用）。
 *
 * 同时设置 MANUAL_TEST_FAULTS=1 与 MANUAL_TEST_FAULT=<检查点> 时，进程在该检查点以 137 退出，
 * 模拟被强杀；恢复必须由全新进程只凭持久化状态完成。生产环境不设置这两个变量，检查点为空操作。
 *
 *   task-running        任务已记 running，handler 尚未开始
 *   raw-captured        raw 截图已写入 staging，Capture 尚未提交
 *   capture-committed   Capture 与投影已提交，任务尚未记 succeeded
 *   rewrite-requested   模型请求文件已写入，任务尚未记 waiting_input
 *   doc-renamed         正式文档已原子替换，发布记录尚未写入
 *   release-committed   发布记录已写入，current 指针尚未更新
 */

const CHECKPOINTS = ['task-running', 'raw-captured', 'capture-committed', 'rewrite-requested', 'doc-renamed', 'release-committed'];

function checkpoint(name) {
  if (process.env.MANUAL_TEST_FAULTS !== '1') return;
  if (process.env.MANUAL_TEST_FAULT !== name) return;
  process.exit(137);
}

/** 发布 journal 的故障钩子。 */
function publicationHooks() {
  return {
    'after:document-installed': () => checkpoint('doc-renamed'),
    'after:release-committed': () => checkpoint('release-committed'),
  };
}

module.exports = { CHECKPOINTS, checkpoint, publicationHooks };
