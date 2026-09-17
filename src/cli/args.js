'use strict';

/*
 * 极简 argv 解析。支持 `--flag value`、`--flag=value`、以及布尔开关。
 * 布尔开关必须显式登记在 BOOLEAN_FLAGS 里，否则 `--yes --lang en-US` 会把
 * `--lang` 误当成 `--yes` 的值。
 */

/*
 * 布尔开关必须登记在这里（或由调用方通过 `booleans` 补充）。
 * 漏登记的后果很隐蔽：`--prune` 会把后面那个参数吃成自己的值，或者拿到空字符串
 * 而被判成 falsy，开关静默失效。
 */
const BOOLEAN_FLAGS = new Set(['force', 'yes', 'json', 'help', 'version', 'prune']);

/** camelCase 化：--base-url → baseUrl。 */
function camelize(name) {
  return name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * @param {string[]} argv  已去掉 node 和脚本路径的参数数组
 * @param {{ known?: Set<string>, booleans?: Iterable<string> }} [options]
 *        `booleans` 用于补充本命令独有的开关，会与 BOOLEAN_FLAGS 合并。
 * @returns {{ values: Record<string, string|boolean>, positional: string[], unknownFlags: string[] }}
 */
function parseArgs(argv, { known = null, booleans = null } = {}) {
  const bools = booleans ? new Set([...BOOLEAN_FLAGS, ...booleans]) : BOOLEAN_FLAGS;
  const values = {};
  const positional = [];
  const unknownFlags = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const body = token.slice(2);
    const eq = body.indexOf('=');
    const rawName = eq === -1 ? body : body.slice(0, eq);
    const name = camelize(rawName);

    if (known && !known.has(name)) {
      unknownFlags.push(`--${rawName}`);
      // 仍然按语法吃掉它的值，避免值被错当成位置参数
      if (eq === -1 && !bools.has(name) && argv[i + 1] && !argv[i + 1].startsWith('--')) i++;
      continue;
    }

    if (eq !== -1) {
      values[name] = body.slice(eq + 1);
      continue;
    }

    if (bools.has(name)) {
      values[name] = true;
      continue;
    }

    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      // 给了参数名但没给值：留空字符串，交给校验层报「缺少 xxx」
      values[name] = '';
    } else {
      values[name] = next;
      i++;
    }
  }

  return { values, positional, unknownFlags };
}

module.exports = { parseArgs, camelize, BOOLEAN_FLAGS };
