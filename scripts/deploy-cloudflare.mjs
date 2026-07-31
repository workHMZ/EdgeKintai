#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(projectRoot, 'wrangler.jsonc');
const safeEnvFile = join(projectRoot, '.dev.vars.example');
const wranglerExecutable = join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
);
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const databaseName = 'edge-kintai-db';
const databaseIdPlaceholder = '00000000-0000-0000-0000-000000000000';
const setupSecretName = 'SETUP_TOKEN';
const weeklyHolidayCron = '0 18 * * 1';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function heading(message) {
  console.log(`\n==> ${message}`);
}

function combinedOutput(result) {
  return [result.stdout, result.stderr]
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n')
    .trim();
}

function commandError(label, result) {
  const exitDescription = result.signal
    ? `信号 ${result.signal}`
    : `退出码 ${result.status ?? 'unknown'}`;
  const detail = combinedOutput(result);
  return new Error(
    `${label}失败（${exitDescription}）${detail ? `\n${detail.slice(-4_000)}` : ''}`,
  );
}

function runInherited(label, executable, args, input) {
  heading(label);
  const safeArgs = executable === wranglerExecutable
    ? [...args, '--env-file', safeEnvFile]
    : args;
  const result = spawnSync(executable, safeArgs, {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8',
    input,
    stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
  });

  if (result.error) throw new Error(`${label}无法启动：${result.error.message}`);
  if (result.status !== 0) throw commandError(label, result);
}

function captureWrangler(args) {
  const result = spawnSync(wranglerExecutable, [...args, '--env-file', safeEnvFile], {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error(`Wrangler 无法启动：${result.error.message}`);
  return result;
}

function parseJsonOutput(label, result) {
  if (result.status !== 0) throw commandError(label, result);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label}返回了无法解析的 JSON`);
  }
}

function readConfiguration() {
  if (!existsSync(configPath)) throw new Error('wrangler.jsonc 不存在');
  const source = readFileSync(configPath, 'utf8');

  if (/"cpu_ms"\s*:/.test(source)) {
    throw new Error(
      'Workers Free 不支持自定义 limits.cpu_ms；请删除该字段并使用平台自动提供的 10 ms CPU 上限',
    );
  }

  const workerNames = [...source.matchAll(
    /^\s*"name"\s*:\s*"([^"]+)"\s*,\s*\r?\n\s*"main"\s*:/gm,
  )];
  const databaseNames = [...source.matchAll(/"database_name"\s*:\s*"([^"]+)"/g)];
  const databaseIds = [...source.matchAll(/"database_id"\s*:\s*"([^"]+)"/g)];
  const dbBindings = [...source.matchAll(/"binding"\s*:\s*"DB"/g)];
  const cronSchedules = [...source.matchAll(
    /"crons"\s*:\s*\[\s*"([^"]+)"\s*\]/g,
  )];

  if (workerNames.length !== 1 || !workerNames[0][1]) {
    throw new Error('wrangler.jsonc 必须包含唯一的 Worker name');
  }
  if (
    databaseNames.length !== 1
    || databaseNames[0][1] !== databaseName
    || databaseIds.length !== 1
    || dbBindings.length !== 1
  ) {
    throw new Error(
      `wrangler.jsonc 必须仅包含一个 DB 绑定，且 database_name 必须是 ${databaseName}`,
    );
  }
  if (cronSchedules.length !== 1 || cronSchedules[0][1] !== weeklyHolidayCron) {
    throw new Error(
      `wrangler.jsonc 必须包含唯一的每周节假日刷新计划 ${weeklyHolidayCron}`,
    );
  }

  const databaseId = databaseIds[0][1];
  if (databaseId !== databaseIdPlaceholder && !uuidPattern.test(databaseId)) {
    throw new Error('wrangler.jsonc 中的 database_id 既不是 placeholder，也不是有效 UUID');
  }

  return {
    source,
    workerName: workerNames[0][1],
    databaseId,
  };
}

function listDatabases() {
  const result = captureWrangler(['d1', 'list', '--json']);
  const databases = parseJsonOutput('列出 D1 数据库', result);
  if (!Array.isArray(databases)) throw new Error('Wrangler D1 list 结果不是数组');
  return databases;
}

function findNamedDatabase(databases) {
  const matches = databases.filter((database) => database?.name === databaseName);
  if (matches.length > 1) {
    throw new Error(`Cloudflare 账户中存在多个名为 ${databaseName} 的 D1，无法安全选择`);
  }
  if (matches.length === 0) return null;

  const database = matches[0];
  if (typeof database.uuid !== 'string' || !uuidPattern.test(database.uuid)) {
    throw new Error(`D1 ${databaseName} 没有返回有效 UUID`);
  }
  return database;
}

function atomicWriteConfiguration(source) {
  const temporaryPath = join(
    dirname(configPath),
    `.${basename(configPath)}.${process.pid}.${Date.now()}.tmp`,
  );

  try {
    writeFileSync(temporaryPath, source, {
      encoding: 'utf8',
      mode: statSync(configPath).mode,
    });
    renameSync(temporaryPath, configPath);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function bindDatabaseId(expectedUuid) {
  const current = readConfiguration();
  if (current.databaseId === expectedUuid) {
    console.log(`D1 ${databaseName} 已绑定，保持 wrangler.jsonc 不变。`);
    return;
  }
  if (current.databaseId !== databaseIdPlaceholder) {
    throw new Error(
      `wrangler.jsonc 已绑定另一个 D1（${current.databaseId}），为避免覆盖已有配置，部署已停止`,
    );
  }

  let replacementCount = 0;
  const updated = current.source.replace(
    /("database_id"\s*:\s*")00000000-0000-0000-0000-000000000000(")/g,
    (_match, prefix, suffix) => {
      replacementCount += 1;
      return `${prefix}${expectedUuid}${suffix}`;
    },
  );
  if (replacementCount !== 1) {
    throw new Error(`预期替换 1 个 database_id placeholder，实际为 ${replacementCount} 个`);
  }

  atomicWriteConfiguration(updated);
  console.log(`已将 D1 ${databaseName} 的 UUID 写入 wrangler.jsonc。`);
}

function ensureLogin() {
  let result = captureWrangler(['whoami', '--json']);
  if (result.status !== 0) {
    if (!process.stdin.isTTY) {
      throw new Error(
        'Wrangler 尚未登录，且当前不是交互式终端。请先运行 npx wrangler login。',
      );
    }
    runInherited('Wrangler 尚未登录，打开授权流程', wranglerExecutable, ['login']);
    result = captureWrangler(['whoami', '--json']);
  }

  const identity = parseJsonOutput('确认 Wrangler 登录', result);
  const accounts = identity?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('Wrangler 登录没有可用的 Cloudflare 账户');
  }

  const selectedAccountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (selectedAccountId) {
    if (
      !/^[0-9a-f]{32}$/i.test(selectedAccountId)
      || !accounts.some((account) => account?.id === selectedAccountId)
    ) {
      throw new Error(
        'CLOUDFLARE_ACCOUNT_ID 无效，或当前 Wrangler 登录无权访问该账户',
      );
    }
  } else if (accounts.length !== 1) {
    throw new Error(
      '当前登录可访问多个 Cloudflare 账户；请使用 Wrangler auth profile 仅授权目标账户，或显式设置 CLOUDFLARE_ACCOUNT_ID',
    );
  }

  console.log('Wrangler 登录已确认。');
}

function isMissingWorker(result, workerName) {
  const plain = combinedOutput(result).replace(/\u001b\[[0-9;]*m/g, '');
  return plain.includes(`Worker "${workerName}"`)
    && plain.includes('not found')
    && plain.includes('wrangler deploy');
}

function listSecrets(workerName) {
  const result = captureWrangler([
    'secret',
    'list',
    '--name',
    workerName,
    '--format',
    'json',
  ]);

  if (result.status !== 0) {
    if (isMissingWorker(result, workerName)) return { workerExists: false, secrets: [] };
    throw commandError('列出 Worker Secrets', result);
  }

  const secrets = parseJsonOutput('列出 Worker Secrets', result);
  if (!Array.isArray(secrets)) throw new Error('Wrangler secret list 结果不是数组');
  return { workerExists: true, secrets };
}

function ensureSetupSecret(workerName) {
  const { workerExists, secrets } = listSecrets(workerName);
  const alreadyConfigured = secrets.some((secret) => secret?.name === setupSecretName);
  if (alreadyConfigured) {
    console.log(`${setupSecretName} 已存在，保持原值，不进行轮换。`);
    return;
  }

  if (!workerExists) {
    console.log(`Worker ${workerName} 尚不存在；Wrangler 将先创建草稿 Worker 以安全保存 Secret。`);
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `${setupSecretName} 尚未配置。首次随机值只能在交互式终端显示，以避免泄露到 CI 日志；请在本地终端重新运行 npm run deploy:cf`,
    );
  }

  const generatedSecret = randomBytes(32).toString('hex');
  runInherited(
    `首次创建 ${setupSecretName}`,
    wranglerExecutable,
    ['secret', 'put', setupSecretName, '--name', workerName],
    `${generatedSecret}\n`,
  );

  console.log(`\n${setupSecretName} 已加密上传。请立即保存下方随机值；它不会写入项目文件，也不会再次显示：`);
  console.log(generatedSecret);
}

function main() {
  if (process.argv.includes('--check')) {
    readConfiguration();
    if (!existsSync(safeEnvFile)) throw new Error('.dev.vars.example 不存在');
    console.log('Deploy helper configuration check passed.');
    return;
  }

  console.log('EdgeKintai Cloudflare 幂等部署');
  console.log('此脚本不读取 .dev.vars，不删除资源，也不轮换已存在的 Secret。');

  readConfiguration();
  runInherited('1/7 运行项目验证', npmExecutable, ['run', 'verify']);

  if (!existsSync(wranglerExecutable)) {
    throw new Error('Wrangler 本地可执行文件不存在，请先运行 npm ci');
  }

  heading('2/7 确认 Wrangler 登录');
  ensureLogin();

  heading(`3/7 复用或创建 APAC D1 ${databaseName}`);
  const configuredBeforeCreate = readConfiguration();
  let database = findNamedDatabase(listDatabases());

  if (database && configuredBeforeCreate.databaseId !== databaseIdPlaceholder) {
    if (configuredBeforeCreate.databaseId !== database.uuid) {
      throw new Error(
        `wrangler.jsonc 的 D1 UUID 与账户中同名数据库不一致：${configuredBeforeCreate.databaseId} != ${database.uuid}`,
      );
    }
  } else if (!database && configuredBeforeCreate.databaseId !== databaseIdPlaceholder) {
    throw new Error(
      `wrangler.jsonc 已配置 D1 UUID ${configuredBeforeCreate.databaseId}，但当前 Cloudflare 账户中找不到 ${databaseName}；为避免创建孤立资源，部署已停止`,
    );
  }

  if (!database) {
    runInherited(
      `创建 D1 ${databaseName}（location hint: apac）`,
      wranglerExecutable,
      [
        'd1',
        'create',
        databaseName,
        '--location',
        'apac',
        // The script performs its own narrowly scoped, atomic placeholder
        // replacement. Never let Wrangler rewrite other config fields.
        '--update-config=false',
      ],
    );
    database = findNamedDatabase(listDatabases());
    if (!database) throw new Error(`D1 ${databaseName} 创建后仍无法找到`);
  } else {
    console.log(`已找到 D1 ${databaseName}，将复用现有数据库。`);
  }

  heading('4/7 安全绑定 D1 UUID');
  bindDatabaseId(database.uuid);

  runInherited(
    '5/7 应用远程 D1 migrations',
    wranglerExecutable,
    ['d1', 'migrations', 'apply', 'DB', '--remote'],
  );

  heading('6/7 检查首次设置 Secret');
  const { workerName } = readConfiguration();
  ensureSetupSecret(workerName);

  runInherited('7/7 部署 Worker 和 Static Assets', wranglerExecutable, ['deploy']);

  console.log('\nEdgeKintai 部署完成。');
  console.log('请打开 Wrangler 输出的 workers.dev URL，使用 SETUP_TOKEN 创建首个管理员。');
}

try {
  main();
} catch (error) {
  console.error(`\n部署已中止：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
