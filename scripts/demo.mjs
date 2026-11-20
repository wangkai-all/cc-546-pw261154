#!/usr/bin/env node
/**
 * 从空目录实际跑一遍题述场景，并打印每一步的计算结果（操作前 / 操作后）。
 *
 *   node scripts/demo.mjs            # 使用临时目录，结束后保留
 *   DATA_DIR=./.data-demo node scripts/demo.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { captureParts, captureScore, withdraw } from '../src/collector.js';
import {
  assemble,
  buildStatus,
  retryAssembly,
  revisePart,
  voucherDownload,
} from '../src/service.js';

function parseDirArg() {
  const inline = process.argv.find((arg) => arg.startsWith('--data='));
  return (
    inline?.slice('--data='.length) ||
    process.env.DATA_DIR ||
    fs.mkdtempSync(path.join(os.tmpdir(), 'score-demo-'))
  );
}

const dataDir = path.resolve(parseDirArg());
if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length > 0) {
  console.error(`数据目录非空，拒绝覆盖：${dataDir}`);
  process.exit(1);
}
const store = new Store(dataDir);

const snap = () => {
  const status = buildStatus(store);
  const evaluation = status.evaluation;
  return {
    satisfied: evaluation.satisfied,
    required: evaluation.required,
    percent: evaluation.percent,
    missing: evaluation.missingSlots,
    display: status.display.versionId,
    versions: status.versions.length,
    vouchers: status.vouchers.length,
    files: status.capture.files.length,
    blobs: status.capture.contentStats.blobs,
  };
};

const show = (label, before, after) => {
  const fmt = (s) =>
    `${s.satisfied}/${s.required}（${s.percent}%）缺[${s.missing.join(',') || '无'}] 展示站=${s.display ?? '空'} 版本=${s.versions} 凭证=${s.vouchers} 文件=${s.files} 唯一内容=${s.blobs}`;
  console.log(`\n■ ${label}`);
  console.log(`  操作前 ${fmt(before)}`);
  console.log(`  操作后 ${fmt(after)}`);
};

const step = (label, fn) => {
  const before = snap();
  const result = fn();
  const after = snap();
  show(label, before, after);
  return result;
};

console.log(`数据目录：${dataDir}`);
console.log('虚构场景：五个声部先到，总谱与文件清单后到；总谱撤回后补发；作废版本保留凭证。');
show('初始状态', snap(), snap());

step('① 采集未齐谱件（只送达五个声部）', () => captureParts(store));
step('② 补发总谱并重试（总谱 + 文件清单固定五个声部的 sha256）', () => retryAssembly(store));

const v1 = store.versionList().at(-1);
const v1Voucher = store.voucherList().at(-1);
const v1PartSha = v1.slots.vn1.sha256;

step('③ 撤回总谱（随后自动组装校验，展示站冻结）', () => {
  const withdrawn = withdraw(store, { kind: 'score' });
  return { withdrawn, assembled: assemble(store) };
});

step('④ 补发总谱并重试（总谱单件补发，沿用原清单其余槽位）', () => retryAssembly(store));

step('⑤ 修订声部 vn1（按清单引用：只换 vn1，其余槽位固定）', () =>
  revisePart(store, {
    partId: 'vn1',
    mode: 'reference',
    content: 'Violin I — 修订版（按清单引用）\n',
  }),
);

step('⑥ 修订声部 vn2（整套冻结：旧版本作废、展示站清空）', () =>
  revisePart(store, { partId: 'vn2', mode: 'freeze', content: 'Violin II — 修订版（整套冻结）\n' }),
);

step('⑦ 冻结后重新补齐并重试', () => retryAssembly(store));

console.log('\n■ 下载凭证核对');
console.log(`  v1 凭证 ${v1Voucher.voucherId} 目前状态：${store.isRetired('v1') ? '版本已作废，凭证保留' : '仍有效'}`);
const plan = store.voucherList().find((voucher) => voucher.versionId === 'v1');
const oldPart = voucherDownload(store, plan.voucherId, 'vn1');
console.log(
  `  用 v1 凭证取回 vn1：sha256=${oldPart.file.sha256.slice(0, 12)}…（${oldPart.buffer.length} B，与 v1 固定值一致：${oldPart.file.sha256 === v1PartSha}）`,
);
console.log(
  `  当前展示版本：${store.displayPointer()?.versionId ?? '空'}；最新版本：${store.versionList().at(-1)?.versionId}`,
);
console.log(`  台账：${store.events.length} 条事件；内容库：${store.contentStats().blobs} 个唯一内容。`);
console.log('\n启动网页：PORT=3000 node server.js，然后打开 http://127.0.0.1:3000');
