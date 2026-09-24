'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { parseArgs } = require('../cli/args');
const { loadConfig, configPathFor } = require('../config/load');
const { planMigration, applyMigration, rollbackMigration } = require('../store/migrate');

const KNOWN_FLAGS = new Set(['projectRoot', 'dryRun', 'apply', 'manifest', 'rollback', 'json', 'help']);
const HELP = `
manual migrate —— 把旧项目显式迁移到 v2 模型（可重复执行）

用法:
  manual migrate --dry-run [--manifest <计划.json>] [--json]
  manual migrate --apply [--manifest <计划.json>] [--json]
  manual migrate --rollback <迁移 id> [--json]

--dry-run   只读：列出实体版本变化、拟生成的 ID、无法证明的验证项、仍被公开引用的原图、
            需要重新采集的对象，以及 facts 与正式文档的冲突。不写项目内任何文件；
            给了 --manifest 时把计划写到该文件（固定 ID 映射与输入 hash）。
--apply     执行迁移。给了 --manifest 就使用那份计划；计划生成后项目文件变了会返回
            migration-input-changed。中途失败再次 --apply 会从 journal 继续；已迁移的项目
            再次 --apply 不做任何改动。完成后 config.version 变为 2，旧版工具会拒绝写入。
--rollback  用迁移时的完整备份恢复定义、配置与 current 指针。
`.trim();

function output(payload, json) {
  if (json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  return payload.ok ? 0 : 1;
}

function fail(errors, json, extra = {}) {
  const list = Array.isArray(errors) ? errors : [errors];
  if (!json) list.forEach((error) => process.stderr.write(`[manual migrate] ${error}\n`));
  return output({ ok: false, errors: list, ...extra }, json);
}

function summarize(plan) {
  return {
    entities: plan.entities.length,
    legacyCaptures: plan.legacyCaptures.length,
    unverifiable: plan.unverifiable.length,
    recapture: plan.recapture.length,
    rawPublicRefs: plan.rawPublicRefs.length,
    factConflicts: plan.facts.filter((f) => f.action === 'conflict').length,
  };
}

function run(argv) {
  const { values, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS, booleans: ['dryRun', 'apply'] });
  const json = values.json === true;
  if (values.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (unknownFlags.length) return fail(`未知参数: ${unknownFlags.join(', ')}`, json);
  const modes = [values.dryRun === true, values.apply === true, values.rollback !== undefined].filter(Boolean).length;
  if (modes !== 1) return fail('需要且只能指定 --dry-run、--apply 或 --rollback <id> 之一。', json);

  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) return fail(loaded.errors, json);
  const rawConfig = yaml.load(fs.readFileSync(configPathFor(projectRoot), 'utf8'));

  try {
    if (values.dryRun) {
      const plan = planMigration(projectRoot, loaded.config, rawConfig);
      if (values.manifest) {
        const target = path.resolve(values.manifest);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(plan, null, 2) + '\n');
      }
      if (!json) {
        const s = summarize(plan);
        process.stdout.write(`[manual migrate] 计划 ${plan.id}（config v${plan.config.from} → v${plan.config.to}，projectId ${plan.projectId}）\n`);
        process.stdout.write(`  实体 ${s.entities}，legacy Capture ${s.legacyCaptures}，无法证明的验证 ${s.unverifiable}，需重新采集 ${s.recapture}，公开原图引用 ${s.rawPublicRefs}，facts 冲突 ${s.factConflicts}\n`);
        process.stdout.write('  这是只读计划，没有修改任何文件。\n');
      }
      return output({ ok: true, mode: 'dry-run', summary: summarize(plan), plan }, json);
    }
    if (values.apply) {
      const manifest = values.manifest ? JSON.parse(fs.readFileSync(path.resolve(values.manifest), 'utf8')) : null;
      const result = applyMigration(projectRoot, loaded.config, rawConfig, { manifest });
      if (!json) {
        process.stdout.write(result.alreadyMigrated
          ? `[manual migrate] 项目已迁移（${result.migrationId}），没有改动。\n`
          : `[manual migrate] 迁移 ${result.migrationId} 完成；备份在 ${result.backup?.backupDir}。\n`);
      }
      return output({ ok: true, mode: 'apply', ...result }, json);
    }
    const result = rollbackMigration(projectRoot, loaded.config, values.rollback);
    if (!json) process.stdout.write(`[manual migrate] 已按备份恢复 ${result.restored.length} 个文件。\n`);
    return output({ ok: true, mode: 'rollback', ...result }, json);
  } catch (error) {
    return fail(`${error.code || 'migration-failed'}: ${error.message}`, json, { code: error.code || 'migration-failed' });
  }
}

module.exports = { run, HELP, KNOWN_FLAGS };
