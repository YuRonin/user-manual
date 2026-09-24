'use strict';

/*
 * `manual generate` 的端到端测试。
 *
 * 重点不在「能不能生成 Markdown」，而在**事实校验挡不挡得住 AI 润色时的越界**。
 * 每一条禁止改动的事实都单独测一遍。
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const fx = require('./fixtures');
const { startServer } = require('./server');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    failures.push({ name, error: e });
    process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`);
  }
}

// 异步 spawn：测试服务器跑在本进程，spawnSync 会阻塞事件循环导致死锁
function run(cmd, root, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, cmd, ...args, '--project-root', root], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`超时: ${cmd}`)); }, 120000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

function draftPath(root, id) { return path.join(root, '.manual', 'drafts', `${id}.md`); }
function finalPath(root, id) { return path.join(root, 'docs', 'manual', `${id}.md`); }
function readDraft(root, id) { return fs.readFileSync(draftPath(root, id), 'utf8'); }

/** 把润色后的内容写到临时文件，返回路径。 */
function writePolished(root, id, content) {
  const p = path.join(root, `${id}.polished.md`);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

/**
 * 建一个走完 init → inspect → describe → capture 的项目。
 * chat 页面带真实截图与完整分析，可以直接 generate。
 */
async function prepareProject(baseUrl) {
  const root = fx.captureFixture();
  let r = await run('init', root, ['--base-url', baseUrl]);
  assert.strictEqual(r.status, 0, `init 失败: ${r.stderr}`);
  r = await run('inspect', root, []);
  assert.strictEqual(r.status, 0, `inspect 失败: ${r.stderr}`);

  const describeInput = path.join(root, 'describe.json');
  fs.writeFileSync(describeInput, JSON.stringify({
    pages: [{
      id: 'chat',
      title: '工作台',
      purpose: '用户可以在这个页面与 AI 助手进行对话，并且能够对历史会话进行管理。',
      detectedActions: ['输入问题后点击「发送」', '点击「新对话」创建会话', '在左侧列表查看历史会话'],
    }],
  }), 'utf8');
  r = await run('describe', root, ['--input', describeInput]);
  assert.strictEqual(r.status, 0, `describe 失败: ${r.stderr}`);

  r = await run('capture', root, ['chat']);
  assert.strictEqual(r.status, 0, `capture 失败: ${r.stderr}`);

  return root;
}

async function main() {
  const server = await startServer();
  process.stdout.write(`\nmanual generate  (测试服务器 ${server.baseUrl})\n`);

  // ------------------------------------------------------------ 阶段一：草稿
  await test('生成事实草稿到 .manual/drafts/<id>.md', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const r = await run('generate', root, ['chat', '--no-screenshot']);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(fs.existsSync(draftPath(root, 'chat')), '草稿未生成');

      const draft = readDraft(root, 'chat');
      assert.match(draft, /^# 工作台$/m, '缺少页面标题');
      assert.match(draft, /`\/chat`/, '缺少路由');
      assert.match(draft, /「发送」/, '缺少 UI 原文');
      // 草稿只有事实，不该出现正式文档才有的东西
      assert.ok(!fs.existsSync(finalPath(root, 'chat')), '阶段一不应产出正式文档');
    } finally {
      fx.cleanup(root);
    }
  });

  await test('页面只有原始截图：不生成带图草稿，提示原图不能进入手册', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const r = await run('generate', root, ['chat', '--json']);
      assert.strictEqual(r.status, 1, r.stdout);
      const out = JSON.parse(r.stdout);
      assert.match(out.errors.join('\n'), /unsafe-page-artifact/);
      assert.match(out.errors.join('\n'), /--no-screenshot/);
      assert.ok(!fs.existsSync(draftPath(root, 'chat')), '被阻止时不应写出草稿');
      // 原图留在 .manual 下，文档目录里没有任何原图
      assert.ok(fs.existsSync(path.join(root, '.manual', 'artifacts', 'raw', 'pages', 'chat.png')));
      assert.ok(!fs.existsSync(path.join(root, 'docs', 'manual', 'images', 'raw')));
    } finally {
      fx.cleanup(root);
    }
  });

  await test('事实比对：改截图路径与删掉截图都判为截图引用改动', async () => {
    const { extractFacts, compareFacts } = require('../src/generate/facts');
    const draft = '# 工作台\n\n![工作台](images/annotated/chat.png)\n';
    for (const final of [draft.replace('images/annotated/chat.png', 'images/chat.png'), '# 工作台\n']) {
      const result = compareFacts(extractFacts(draft), extractFacts(final));
      assert.strictEqual(result.ok, false);
      assert.ok(result.violations.some((v) => v.kind === 'image'));
    }
  });

  await test('文字版定稿里插入原图：被拦截，--fallback-draft 也不能引入', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      await run('generate', root, ['chat', '--no-screenshot']);
      const withRaw = readDraft(root, 'chat') + '\n![工作台](../../.manual/artifacts/raw/pages/chat.png)\n';
      let r = await run('generate', root, ['chat', '--finalize', writePolished(root, 'chat', withRaw)]);
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /截图引用被改动/);
      assert.ok(!fs.existsSync(finalPath(root, 'chat')));

      r = await run('generate', root, ['chat', '--finalize', writePolished(root, 'chat', withRaw), '--fallback-draft']);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(!/!\[/.test(fs.readFileSync(finalPath(root, 'chat'), 'utf8')), 'fallback 只能回退到草稿原文');
    } finally {
      fx.cleanup(root);
    }
  });

  await test('草稿事实文件缺失或被篡改为原图：定稿被发布门槛阻止', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      await run('generate', root, ['chat', '--no-screenshot']);
      const factsFile = path.join(root, '.manual', 'drafts', 'chat.facts.json');
      const draft = readDraft(root, 'chat');
      fs.rmSync(factsFile);
      let r = await run('generate', root, ['chat', '--finalize', writePolished(root, 'chat', draft)]);
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /缺少草稿事实文件/);

      // 手工把草稿和 facts 都改成引用原图：统一门槛仍按产物位置阻止
      const rawHref = '../../.manual/artifacts/raw/pages/chat.png';
      const tampered = draft.replace('访问地址', `![工作台](${rawHref})\n\n访问地址`);
      fs.writeFileSync(draftPath(root, 'chat'), tampered);
      fs.writeFileSync(factsFile, JSON.stringify({ pageId: 'chat', images: [{ artifactPath: '.manual/artifacts/raw/pages/chat.png', markdownHref: rawHref }] }));
      r = await run('generate', root, ['chat', '--finalize', writePolished(root, 'chat', tampered), '--json']);
      assert.strictEqual(r.status, 1);
      assert.match(r.stdout, /forbidden-artifact|invalid-artifact-path/);
      assert.ok(!fs.existsSync(finalPath(root, 'chat')));
    } finally {
      fx.cleanup(root);
    }
  });

  await test('--json 给出受保护事实清单', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const r = await run('generate', root, ['chat', '--no-screenshot', '--json']);
      assert.strictEqual(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);

      assert.strictEqual(out.stage, 'draft');
      assert.strictEqual(out.facts.title, '工作台');
      assert.strictEqual(out.facts.route, '/chat');
      assert.strictEqual(out.facts.actionCount, 3);
      assert.deepStrictEqual(out.protected.images, []);
      assert.strictEqual(out.facts.screenshot, null);
      assert.ok(out.protected.uiTerms.includes('发送'));
      assert.ok(out.protected.uiTerms.includes('新对话'));
      assert.ok(out.protected.codeSpans.includes('/chat'));
      assert.ok(out.styleGuidePath.endsWith(path.join('references', 'manual-writing-style.md')));
      assert.match(out.nextCommand, /--finalize/);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('generate 将 forward index 源码上下文加入草稿与 JSON 输出', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const r = await run('generate', root, ['chat', '--no-screenshot', '--json']);
      assert.strictEqual(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);

      assert.deepStrictEqual(out.indexContext.entry, ['app/chat/page.tsx']);
      assert.deepStrictEqual(out.indexContext.files, ['app/chat/page.tsx']);
      assert.deepStrictEqual(out.indexContext.components, []);
      assert.deepStrictEqual(out.indexContext.hooks, []);
      assert.deepStrictEqual(out.indexContext.apis, []);
      assert.deepStrictEqual(out.indexContext.scenarios, []);
      assert.match(readDraft(root, 'chat'), /<!-- 关联源码: app\/chat\/page\.tsx -->/);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('索引缺失或损坏时 generate 回退页面 YAML', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      fs.rmSync(path.join(root, '.manual', 'index'), { recursive: true });
      let r = await run('generate', root, ['chat', '--no-screenshot', '--json']);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.strictEqual(JSON.parse(r.stdout).indexContext, null);

      fs.mkdirSync(path.join(root, '.manual', 'index'), { recursive: true });
      fs.writeFileSync(path.join(root, '.manual', 'index', 'forward.json'), '{broken', 'utf8');
      fs.writeFileSync(path.join(root, '.manual', 'index', 'reverse.json'), '{}', 'utf8');
      r = await run('generate', root, ['chat', '--no-screenshot', '--json']);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.strictEqual(JSON.parse(r.stdout).indexContext, null);
    } finally {
      fx.cleanup(root);
    }
  });

  // ------------------------------------------------------------ 阶段三：定稿
  await test('合规的中文润色可以通过并输出正式文档', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      await run('generate', root, ['chat', '--no-screenshot']);

      // 只改句式与语序：去掉「用户可以」「能够」「并且」，事实一个没动
      const polished = [
        '# 工作台',
        '',
        '在这个页面与 AI 助手对话，也可以管理历史会话。',
        '',
        '访问地址：`/chat`',
        '',
        '## 主要操作',
        '',
        '1. 输入问题后点击「发送」',
        '2. 点击「新对话」创建会话',
        '3. 在左侧列表查看历史会话',
        '',
      ].join('\n');

      const r = await run('generate', root, ['chat', '--finalize', writePolished(root, 'chat', polished)]);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.match(r.stdout, /事实校验通过/);

      const final = fs.readFileSync(finalPath(root, 'chat'), 'utf8');
      assert.match(final, /在这个页面与 AI 助手对话/);
      assert.ok(!final.includes('用户可以'), '翻译腔应该已经被润掉');
      // 草稿保留，便于回溯问题出在哪一阶段
      assert.ok(fs.existsSync(draftPath(root, 'chat')));
    } finally {
      fx.cleanup(root);
    }
  });

  // ------------------------------------------------------------ 事实校验：逐条设防
  const violationCases = [
    {
      name: '改了 UI 原文（「新对话」→「开启新会话」）',
      mutate: (d) => d.replace('「新对话」', '「开启新会话」'),
      expect: /UI 名称/,
    },
    {
      name: '编造了草稿里没有的按钮',
      mutate: (d) => d + '\n点击「导出」保存记录。\n',
      expect: /草稿里没有的 UI 名称/,
    },
    {
      name: '把 UI 原文润没了（「发送」消失）',
      mutate: (d) => d.replace('1. 输入问题后点击「发送」', '1. 输入问题后提交'),
      expect: /UI 名称在定稿里消失/,
    },
    {
      // 页面发布图管线就绪前草稿是文字版；删图/改路径由上方 compareFacts 用例覆盖
      name: '凭空加入截图',
      mutate: (d) => d.replace('## 主要操作', '![工作台](images/annotated/chat.png)\n\n## 主要操作'),
      expect: /截图引用被改动/,
    },
    {
      name: '改了路由',
      mutate: (d) => d.replace('`/chat`', '`/chat/index`'),
      expect: /路由/,
    },
    {
      name: '编造了响应时间',
      mutate: (d) => d.replace('访问地址', '发送后通常 3 秒内返回结果。\n\n访问地址'),
      expect: /草稿里没有的数字/,
    },
    {
      name: '增加了一个原本不存在的步骤',
      mutate: (d) => d.replace(
        '3. 在左侧列表查看历史会话',
        '3. 在左侧列表查看历史会话\n4. 在设置里调整模型参数'
      ),
      expect: /操作步骤数量/,
    },
    {
      name: '调换了操作顺序',
      mutate: (d) =>
        d.replace('1. 输入问题后点击「发送」\n2. 点击「新对话」创建会话',
          '1. 点击「新对话」创建会话\n2. 输入问题后点击「发送」'),
      expect: /顺序/,
    },
    {
      name: '改了页面标题',
      mutate: (d) => d.replace('# 工作台', '# AI 对话工作台'),
      expect: /页面标题被改了/,
    },
  ];

  for (const c of violationCases) {
    await test(`拦截：${c.name}`, async () => {
      const root = await prepareProject(server.baseUrl);
      try {
        await run('generate', root, ['chat', '--no-screenshot']);
        const mutated = c.mutate(readDraft(root, 'chat'));

        const r = await run('generate', root, ['chat', '--finalize', writePolished(root, 'chat', mutated)]);
        assert.strictEqual(r.status, 1, `应当拒绝定稿，实际退出码 ${r.status}\n${r.stdout}`);
        assert.match(r.stderr, /事实校验未通过/);
        assert.match(r.stderr, c.expect, `报错未命中预期:\n${r.stderr}`);
        assert.ok(
          !fs.existsSync(finalPath(root, 'chat')),
          '事实校验没过时绝不能输出正式文档'
        );
      } finally {
        fx.cleanup(root);
      }
    });
  }

  await test('纯粹的中文润色（不碰事实）全部放行', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      await run('generate', root, ['chat', '--no-screenshot']);
      const draft = readDraft(root, 'chat');
      // 把用途段改得彻底不同，但事实（标题/路由/图片/步骤/UI 原文）一个没动
      const polished = draft.replace(
        '用户可以在这个页面与 AI 助手进行对话，并且能够对历史会话进行管理。',
        '在这里和 AI 助手对话，也可以管理历史会话。'
      );
      const r = await run('generate', root, ['chat', '--finalize', writePolished(root, 'chat', polished)]);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.match(fs.readFileSync(finalPath(root, 'chat'), 'utf8'), /在这里和 AI 助手对话/);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('--fallback-draft：校验不过时用草稿原文定稿，事实优先', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      await run('generate', root, ['chat', '--no-screenshot']);
      const mutated = readDraft(root, 'chat').replace('「新对话」', '「开启新会话」');

      const r = await run('generate', root, [
        'chat', '--finalize', writePolished(root, 'chat', mutated), '--fallback-draft',
      ]);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.match(r.stdout, /按 --fallback-draft 用草稿原文定稿/);

      const final = fs.readFileSync(finalPath(root, 'chat'), 'utf8');
      assert.match(final, /「新对话」/, '应保留草稿里的真实 UI 原文');
      assert.ok(!final.includes('开启新会话'), '不能让被改坏的 UI 名称进正式文档');
    } finally {
      fx.cleanup(root);
    }
  });

  // ------------------------------------------------------------ 前置条件
  await test('没截图就 generate：要求先 capture', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      await run('describe', root, ['--id', 'slow', '--title', '慢页面', '--purpose', '演示用。']);
      const r = await run('generate', root, ['slow']);
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /还没有截图/);
      assert.match(r.stderr, /manual capture slow/);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('--no-screenshot 允许生成纯文字草稿', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      await run('describe', root, ['--id', 'slow', '--title', '慢页面', '--purpose', '演示用。']);
      const r = await run('generate', root, ['slow', '--no-screenshot']);
      assert.strictEqual(r.status, 0, r.stderr);
      const draft = readDraft(root, 'slow');
      assert.match(draft, /# 慢页面/);
      assert.ok(!/!\[/.test(draft), '纯文字草稿不该有图片引用');
    } finally {
      fx.cleanup(root);
    }
  });

  await test('没做源码分析就 generate：要求先 describe', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const r = await run('generate', root, ['login']);
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /源码分析/);
      assert.match(r.stderr, /manual describe/);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('截图文件被删了：报错而不是生成坏链接', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      fs.rmSync(path.join(root, '.manual', 'artifacts', 'raw', 'pages', 'chat.png'));
      const r = await run('generate', root, ['chat']);
      assert.strictEqual(r.status, 1);
      assert.ok(!fs.existsSync(draftPath(root, 'chat')), '不能生成带坏链接的草稿');
    } finally {
      fx.cleanup(root);
    }
  });

  await test('includeInManual: false 的页面不生成手册', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      await run('describe', root, ['--id', 'chat', '--include-in-manual', 'false']);
      const r = await run('generate', root, ['chat', '--no-screenshot']);
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /不在手册范围内/);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('没出草稿就 --finalize：提示先跑阶段一', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const p = writePolished(root, 'chat', '# 工作台\n');
      const r = await run('generate', root, ['chat', '--finalize', p]);
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /找不到事实草稿/);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('正式文档已存在时不覆盖，--force 才覆盖', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      await run('generate', root, ['chat', '--no-screenshot']);
      const draft = readDraft(root, 'chat');
      const p = writePolished(root, 'chat', draft);

      let r = await run('generate', root, ['chat', '--finalize', p]);
      assert.strictEqual(r.status, 0, r.stderr);

      r = await run('generate', root, ['chat', '--finalize', p]);
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /已存在/);

      r = await run('generate', root, ['chat', '--finalize', p, '--force']);
      assert.strictEqual(r.status, 0, r.stderr);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('未知 page id：列出可用页面', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const r = await run('generate', root, ['nope']);
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /找不到页面/);
      assert.match(r.stderr, /chat/);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('generate 不碰业务代码', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const before = fs.readFileSync(path.join(root, 'app', 'chat', 'page.tsx'), 'utf8');
      await run('generate', root, ['chat', '--no-screenshot']);
      const p = writePolished(root, 'chat', readDraft(root, 'chat'));
      await run('generate', root, ['chat', '--finalize', p]);
      assert.strictEqual(fs.readFileSync(path.join(root, 'app', 'chat', 'page.tsx'), 'utf8'), before);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('风格规范文件随 Skill 存在且可读', async () => {
    const guide = path.resolve(__dirname, '..', 'references', 'manual-writing-style.md');
    assert.ok(fs.existsSync(guide), '缺少 references/manual-writing-style.md');
    const text = fs.readFileSync(guide, 'utf8');
    // 用户点名要覆盖的禁用项都得在里面
    for (const banned of [
      '用户可以点击', '通过该功能', '值得注意的是', '从而提升',
      '进一步提升', '更好地', '高效地', '轻松地', '即可实现',
    ]) {
      assert.ok(text.includes(banned), `风格规范未覆盖禁用表达: ${banned}`);
    }
    for (const verb of ['点击', '选择', '输入', '打开', '返回', '上传', '下载', '查看']) {
      assert.ok(text.includes(verb), `风格规范未列出推荐动词: ${verb}`);
    }
  });

  await server.close();
  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  process.stderr.write(`测试运行器出错: ${e.stack || e}\n`);
  process.exitCode = 1;
});
