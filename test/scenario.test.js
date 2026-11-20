import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Store, sha256 } from '../src/store.js';
import { DomainError } from '../src/errors.js';
import { CONTENT_SLOTS, PART_SLOTS, TOTAL_REQUIRED, parseManifest } from '../src/domain.js';
import { evaluateSet } from '../src/assembler.js';
import {
  captureParts,
  captureScore,
  captureSuite,
  withdraw,
} from '../src/collector.js';
import * as service from '../src/service.js';
import {
  assemble,
  buildStatus,
  downloadPlan,
  issueVoucher,
  resendScore,
  retryAssembly,
  revisePart,
  voucherDownload,
} from '../src/service.js';

function newStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-workbench-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { store: new Store(dir), dir };
}

function lastAttempt(store) {
  return store.attemptList().at(-1);
}

function slotProblem(attempt, code) {
  return attempt.problems.find((problem) => problem.code === code) ?? null;
}

// ---------------------------------------------------------------- 正常路径

test('声部先发：采集只按内容入库，组装判定一套不齐', (t) => {
  const { store } = newStore(t);
  const capture = captureParts(store);

  assert.equal(capture.captured, PART_SLOTS.length);
  assert.equal(store.fileList().length, 5);
  assert.equal(store.contentStats().blobs, 5);

  const result = assemble(store);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'set-incomplete');
  assert.equal(result.attempt.satisfied, 5);
  assert.equal(result.attempt.required, TOTAL_REQUIRED);
  assert.deepEqual(result.attempt.missingSlots.sort(), ['manifest', 'score']);
  assert.equal(store.versionList().length, 0);
  assert.equal(buildStatus(store).display.versionId, null);
});

test('同一内容重复采集只占一个内容库对象，但留两批采集凭证', (t) => {
  const { store } = newStore(t);
  captureParts(store);
  const first = [...new Set(store.fileList().map((file) => file.sha256))].sort();
  captureParts(store, { label: '重复投递' });
  const second = store.fileList().map((file) => file.sha256).sort();

  assert.deepEqual(second, [...first, ...first].sort());
  assert.equal(store.contentStats().blobs, 5);
  assert.equal(store.collectionList().length, 2);
  assert.equal(store.fileList().length, 10);
  assert.ok(store.fileList().slice(5).every((file) => file.deduped === true));
});

test('总谱与文件清单后发：齐全后发行，展示站切到该版本并自动出具凭证', (t) => {
  const { store } = newStore(t);
  captureParts(store);
  captureScore(store);

  const result = assemble(store);
  assert.equal(result.ok, true);
  assert.equal(result.version.versionId, 'v1');
  assert.equal(result.version.fixedShaList.length, TOTAL_REQUIRED);
  assert.equal(store.versionList().length, 1);

  const status = buildStatus(store);
  assert.equal(status.display.versionId, 'v1');
  assert.equal(status.latestVersion.isDisplay, true);
  assert.equal(status.vouchers.length, 1);
  assert.equal(status.vouchers[0].versionId, 'v1');
  assert.equal(status.attempts.at(-1).complete, true);
  assert.equal(status.attempts.at(-1).satisfied, TOTAL_REQUIRED);
});

test('清单固定的 sha256 是采集时算出的真实哈希，可逐项回读校验', (t) => {
  const { store } = newStore(t);
  captureSuite(store);
  assemble(store);

  const version = store.versionList().at(-1);
  for (const file of Object.values(version.slots)) {
    const buffer = store.readContent(file.sha256);
    assert.equal(sha256(buffer), file.sha256);
    assert.equal(buffer.length, file.bytes);
  }
  const manifestBytes = store.readContent(version.slots.manifest.sha256).toString('utf8');
  const parsed = parseManifest(manifestBytes);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.missingSlots.length, 0);
  assert.deepEqual(
    CONTENT_SLOTS.map((definition) => parsed.entriesBySlot[definition.slot].sha256),
    CONTENT_SLOTS.map((definition) => version.slots[definition.slot].sha256),
  );
});

test('内容相同再组装不会重复发行', (t) => {
  const { store } = newStore(t);
  captureSuite(store);
  const first = assemble(store);
  const second = assemble(store);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.version, null);
  assert.match(second.note, /无需重复发行/);
  assert.equal(store.versionList().length, 1);
});

test('总谱撤回后补发：旧版本作废，新版本发行，旧版本下载凭证仍可取回原内容', (t) => {
  const { store } = newStore(t);
  captureSuite(store);
  assemble(store);
  const v1 = store.versionList().at(-1);
  const oldScoreSha = v1.slots.score.sha256;
  const oldVoucher = store.voucherList().at(-1);

  const withdrawal = withdraw(store, { kind: 'score' });
  assert.equal(withdrawal.file.withdrawn, true);
  assert.equal(withdrawal.evidence.sha256, oldScoreSha);

  const afterWithdraw = assemble(store);
  assert.equal(afterWithdraw.ok, false);
  assert.deepEqual(afterWithdraw.attempt.missingSlots, ['score']);
  assert.ok(lastAttempt(store).problems.some((problem) => problem.code === 'reference-unavailable'));
  assert.equal(buildStatus(store).display.versionId, null);
  assert.equal(buildStatus(store).display.reason, '组装未通过：展示站已冻结，不再拼入旧声部');

  const resend = resendScore(store);
  assert.equal(resend.ok, true);
  assert.equal(resend.assemble.version.versionId, 'v2');
  assert.notEqual(resend.scoreFile.sha256, oldScoreSha);
  assert.equal(store.displayPointer().versionId, 'v2');
  assert.ok(store.isRetired('v1'));

  // 作废版本的凭证还在，且取回的是 v1 时期固定下来的旧总谱内容。
  const plan = downloadPlan(store, oldVoucher.voucherId);
  assert.equal(plan.situation, 'retired');
  assert.equal(plan.stillValid, false);
  const download = voucherDownload(store, oldVoucher.voucherId, 'score');
  assert.equal(sha256(download.buffer), oldScoreSha);
  assert.equal(download.buffer.toString('utf8').includes('快照 B'), true);
  assert.equal(
    store.servedList().some((event) => event.voucherId === oldVoucher.voucherId && event.ok),
    true,
  );
});

test('补发总谱时若声部已变，拒绝把旧声部混入新的一套', (t) => {
  const { store } = newStore(t);
  captureSuite(store);
  assemble(store);

  // 声部换版但清单尚未更新：此时「只补发总谱」会让旧清单固定旧声部。
  captureParts(store, {
    label: '声部快照 B',
    parts: PART_SLOTS.map((part) => ({
      partId: part.partId,
      content: part.partId === 'va' ? '中提琴 — 换版，快照 B\n' : `${part.label} — 第 1–48 小节，快照 A\n`,
    })),
  });

  assert.throws(
    () => resendScore(store),
    (error) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, 'manifest-stale');
      assert.equal(error.status, 409);
      assert.match(error.message, /旧声部/);
      return true;
    },
  );
  // 被拒绝时不得写入新总谱/新清单，展示站保持 v1。
  assert.equal(store.versionList().length, 1);
  assert.equal(buildStatus(store).display.versionId, 'v1');
});

test('修订声部（按清单引用）：只有目标声部换版，其余槽位沿用固定文件', (t) => {
  const { store } = newStore(t);
  captureSuite(store);
  assemble(store);
  const v1 = store.versionList().at(-1);
  const v1Hashes = Object.fromEntries(Object.entries(v1.slots).map(([slot, file]) => [slot, file.sha256]));

  const result = revisePart(store, {
    partId: 'vn1',
    mode: 'reference',
    content: '小提琴 I — 弓法修订（按清单引用）\n',
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'republished');
  assert.equal(result.verification.length, CONTENT_SLOTS.length - 1);
  assert.ok(result.verification.every((item) => item.ok));

  const v2 = store.versionList().at(-1);
  assert.equal(v2.versionId, 'v2');
  assert.notEqual(v2.slots.vn1.sha256, v1Hashes.vn1);
  for (const slot of ['score', 'vn2', 'va', 'vc', 'cb']) {
    assert.equal(v2.slots[slot].sha256, v1Hashes[slot], `${slot} 应继续引用 v1 的固定内容`);
    assert.equal(v2.slots[slot].fileId, v1.slots[slot].fileId);
  }
  assert.equal(store.isRetired('v1'), true);
  assert.equal(store.displayPointer().versionId, 'v2');
  assert.equal(downloadPlan(store, v1.vouchers?.[0]?.voucherId ?? store.voucherList()[0].voucherId).situation, 'retired');
});

test('修订声部（整套冻结）：旧版本停用、展示站清空，必须重新组装齐全', (t) => {
  const { store } = newStore(t);
  captureSuite(store);
  assemble(store);
  const v1Voucher = store.voucherList().at(-1);

  const result = revisePart(store, {
    partId: 'vn2',
    mode: 'freeze',
    content: '小提琴 II — 分谱重排（整套冻结）\n',
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'frozen');
  assert.equal(store.isRetired('v1'), true);
  assert.equal(store.displayPointer().versionId, null);

  const attempt = lastAttempt(store);
  assert.equal(attempt.complete, false);
  // 整套冻结把总谱与清单一起作废：仅五个声部在库，因此 5/7。
  assert.equal(attempt.satisfied, TOTAL_REQUIRED - 2);
  assert.deepEqual(attempt.missingSlots.sort(), ['manifest', 'score']);
  assert.ok(attempt.problems.some((problem) => problem.code === 'slot-withdrawn'));

  // 冻结期间旧凭证仍可下载旧版本固定内容。
  const plan = downloadPlan(store, v1Voucher.voucherId);
  assert.equal(plan.situation, 'retired');
  const download = voucherDownload(store, v1Voucher.voucherId, 'vn2');
  assert.equal(sha256(download.buffer), v1Voucher.fixedShaList[2]);

  // 补齐后可再次发行。
  const retry = retryAssembly(store);
  assert.equal(retry.ok, true);
  assert.equal(retry.mode, 'capture-score-and-manifest');
  assert.equal(store.versionList().length, 2);
  assert.equal(store.displayPointer().versionId, 'v2');
});

test('从空目录经网页接口跑完「采集未齐 → 补发重试 → 查看版本」', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { createApp } = await import('../server.js');
  const { server } = createApp({ dataDir: dir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const post = async (pathname, body = {}) => {
    const response = await fetch(base + pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const get = async (pathname) => {
    const response = await fetch(base + pathname);
    return { status: response.status, body: await response.json() };
  };

  const empty = await get('/api/status');
  assert.equal(empty.body.status.capture.files.length, 0);
  assert.equal(empty.body.status.display.versionId, null);

  const parts = await post('/api/capture/parts');
  assert.equal(parts.status, 201);
  assert.equal(parts.body.result.captured, 5);
  assert.equal(parts.body.status.evaluation.satisfied, 5);
  assert.deepEqual(parts.body.status.evaluation.missingSlots.sort(), ['manifest', 'score']);
  assert.equal(parts.body.status.versions.length, 0);
  assert.equal(parts.body.status.display.versionId, null);

  const retry = await post('/api/retry');
  assert.equal(retry.status, 200);
  assert.equal(retry.body.mode, 'capture-score-and-manifest');
  assert.equal(retry.body.status.display.versionId, 'v1');
  assert.equal(retry.body.status.versions.length, 1);
  assert.equal(retry.body.status.vouchers.length, 1);

  const versions = await get('/api/status');
  const voucherId = versions.body.status.vouchers[0].voucherId;
  const download = await fetch(`${base}/api/download/${voucherId}/score`);
  assert.equal(download.status, 200);
  const body = Buffer.from(await download.arrayBuffer());
  assert.equal(download.headers.get('x-content-sha256'), sha256(body));

  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /data-evidence-result="business"/);
  assert.match(html, /采集未齐谱件/);
  assert.match(html, /补发总谱并重试/);
  assert.match(html, /查看发行版本/);
});

// ---------------------------------------------------------------- 异常路径

test('空台账直接组装：不发行、给出 0/7 与全部缺失项', (t) => {
  const { store } = newStore(t);
  const result = assemble(store);
  assert.equal(result.ok, false);
  assert.equal(result.error.status, 422);
  assert.equal(result.attempt.satisfied, 0);
  assert.equal(result.attempt.percent, 0);
  assert.deepEqual(result.attempt.missingSlots.sort(), ['cb', 'manifest', 'score', 'va', 'vc', 'vn1', 'vn2']);
  assert.equal(store.versionList().length, 0);
});

test('清单引用的内容被撤回后，读取时不回退同名旧声部', (t) => {
  const { store } = newStore(t);
  captureSuite(store);
  assemble(store);
  const v1 = store.versionList().at(-1);

  withdraw(store, { kind: 'part', partId: 'vc' });
  const result = assemble(store);
  assert.equal(result.ok, false);
  const problem = slotProblem(result.attempt, 'reference-unavailable');
  assert.ok(problem);
  assert.equal(problem.slot, 'vc');
  assert.equal(problem.expectedSha256, v1.slots.vc.sha256);
  assert.equal(buildStatus(store).display.versionId, null);

  // 内容库中的旧声部仍在，但组装判定拒绝把它当作该槽位的满足项。
  assert.equal(sha256(store.readContent(v1.slots.vc.sha256)), v1.slots.vc.sha256);
  assert.equal(evaluateSet(store).missingSlots.includes('vc'), true);
});

test('清单被篡改成不存在的 sha256：判定为固定内容缺失，而不是按文件名放行', (t) => {
  const { store } = newStore(t);
  captureSuite(store);
  const tampered = 'f'.repeat(64);
  const parts = PART_SLOTS.map((part) => {
    const live = store.fileList().find((file) => file.partId === part.partId && !file.withdrawn);
    return {
      slot: part.partId,
      role: 'part',
      partId: part.partId,
      name: live.name,
      sha256: part.partId === 'va' ? tampered : live.sha256,
      bytes: live.bytes,
    };
  });
  const score = store.fileList().find((file) => file.role === 'score');
  const manifestText = JSON.stringify({
    schema: 'score-manifest/v1',
    title: '篡改清单',
    note: '',
    files: [
      { slot: 'score', role: 'score', partId: null, name: score.name, sha256: score.sha256, bytes: score.bytes },
      ...parts,
    ],
  });
  store.collect({
    label: '篡改清单',
    files: [{ role: 'manifest', partId: null, name: 'manifest.tampered.json', content: manifestText }],
  });

  const result = assemble(store);
  assert.equal(result.ok, false);
  assert.equal(result.attempt.missingSlots.includes('va'), true);
  const problem = slotProblem(result.attempt, 'reference-unavailable');
  assert.equal(problem.expectedSha256, tampered);
  assert.equal(result.attempt.satisfied, 6);
});

test('非法清单（结构错误）被拒，不会误判齐全', (t) => {
  const { store } = newStore(t);
  captureParts(store);
  store.collect({
    label: '坏清单',
    files: [{ role: 'manifest', partId: null, name: 'manifest.bad.json', content: '{"schema":"wrong","files":[]}' }],
  });
  const result = assemble(store);
  assert.equal(result.ok, false);
  const problem = slotProblem(result.attempt, 'manifest-invalid');
  assert.ok(problem);
  assert.equal(result.attempt.missingSlots.includes('manifest'), true);
});

test('没有文件清单时只补发总谱会被拒绝', (t) => {
  const { store } = newStore(t);
  captureParts(store);
  assert.throws(
    () => resendScore(store),
    (error) => error instanceof DomainError && error.code === 'no-manifest' && error.status === 409,
  );
});

test('撤回不存在的文件 / 未知类型给出明确错误', (t) => {
  const { store } = newStore(t);
  assert.throws(
    () => withdraw(store, { kind: 'score' }),
    (error) => error.code === 'no-score' && error.status === 409,
  );
  assert.throws(
    () => withdraw(store, { kind: 'nope' }),
    (error) => error.code === 'invalid-withdraw-kind' && error.status === 400,
  );
  captureSuite(store);
  assert.throws(
    () => withdraw(store, { kind: 'part', partId: 'nope' }),
    (error) => error.code === 'unknown-part' && error.status === 400,
  );
});

test('下载凭证与内容缺失的错误路径', (t) => {
  const { store } = newStore(t);
  captureSuite(store);
  assemble(store);
  assert.throws(
    () => downloadPlan(store, 'DL-9999'),
    (error) => error.code === 'voucher-not-found' && error.status === 404,
  );
  const voucher = store.voucherList().at(-1);
  assert.throws(
    () => voucherDownload(store, voucher.voucherId, 'nope'),
    (error) => error.code === 'slot-not-in-voucher' && error.status === 404,
  );

  // 内容库中人为抽掉一份被固定内容：下载必须失败并留下失败记录，不回落旧内容。
  const removed = store.versionList().at(-1).slots.vn2.sha256;
  fs.rmSync(store.contentPath(removed));
  assert.throws(
    () => voucherDownload(store, voucher.voucherId, 'vn2'),
    (error) => error.code === 'content-missing' && error.status === 409,
  );
  const served = store.servedList().at(-1);
  assert.equal(served.ok, false);
  assert.equal(served.reason, 'content-missing');
});

test('凭证必须指向真实存在的版本', (t) => {
  const { store } = newStore(t);
  assert.throws(
    () => issueVoucher(store, {}),
    (error) => error.code === 'no-version' && error.status === 409,
  );
  captureSuite(store);
  assemble(store);
  assert.throws(
    () => issueVoucher(store, { versionId: 'v99' }),
    (error) => error.code === 'version-not-found' && error.status === 404,
  );
  const issued = issueVoucher(store, { versionId: 'v1' });
  assert.equal(issued.voucher.versionId, 'v1');
});

test('按清单引用修订时，若某固定内容已被撤回则拒绝发行', (t) => {
  const { store } = newStore(t);
  captureSuite(store);
  assemble(store);
  withdraw(store, { kind: 'part', partId: 'vc' });

  const result = revisePart(store, {
    partId: 'vn1',
    mode: 'reference',
    content: '小提琴 I — 残缺引用测试\n',
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.error.code, 'reference-unavailable');
  assert.ok(result.verification.some((item) => !item.ok && item.slot === 'vc'));
  assert.equal(store.versionList().length, 1);
});

test('未知声部与空内容被拒绝', (t) => {
  const { store } = newStore(t);
  assert.throws(
    () => revisePart(store, { partId: 'zz', content: 'x' }),
    (error) => error.code === 'unknown-part',
  );
  captureSuite(store);
  assemble(store);
  assert.throws(
    () => revisePart(store, { partId: 'vn1', mode: 'reference', content: '   '.replace(/ /g, '') }),
    (error) => error.code === 'empty-part',
  );
});

test('台账可从 JSONL 回放：重启后哈希、版本与凭证保持一致', (t) => {
  const { store, dir } = newStore(t);
  captureSuite(store);
  assemble(store);
  const before = buildStatus(store);

  const reopened = new Store(dir);
  const after = buildStatus(reopened);
  assert.equal(after.display.versionId, before.display.versionId);
  assert.deepEqual(after.latestVersion.slots.map((slot) => slot.sha256), before.latestVersion.slots.map((slot) => slot.sha256));
  assert.equal(after.vouchers.length, before.vouchers.length);
  assert.equal(reopened.fileList().length, store.fileList().length);
  assert.deepEqual(reopened.events.map((event) => event.seq), store.events.map((event) => event.seq));
});

test('读取旧版本文件时按该版本固定的 sha256 解析，不会读到新声部', (t) => {
  const { store } = newStore(t);
  captureSuite(store);
  assemble(store);
  const v1 = store.versionList().at(-1);
  const v1Part = store.readContent(v1.slots.vn1.sha256).toString('utf8');

  revisePart(store, { partId: 'vn1', mode: 'reference', content: '小提琴 I — 新声部（不应混入旧版本）\n' });
  const v2 = store.versionList().at(-1);
  assert.notEqual(v1.slots.vn1.sha256, v2.slots.vn1.sha256);

  const { readVersionFile } = service;
  const old = readVersionFile(store, 'v1', 'vn1');
  const fresh = readVersionFile(store, 'v2', 'vn1');
  assert.equal(old.buffer.toString('utf8'), v1Part);
  assert.equal(old.sha256, v1.slots.vn1.sha256);
  assert.equal(old.situation, 'retired');
  assert.match(fresh.buffer.toString('utf8'), /新声部/);
  assert.equal(fresh.situation, 'display');

  assert.throws(
    () => readVersionFile(store, 'v1', 'ax'),
    (error) => error.code === 'slot-not-in-version' && error.status === 404,
  );
});
