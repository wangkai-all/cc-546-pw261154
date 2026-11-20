const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  lastAction: null,
  log: [],
};

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const pct = (value) => `${Number(value ?? 0).toFixed(1)}%`;
const bytes = (n) => (typeof n === 'number' ? `${n} B` : '—');

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = { ok: false, error: { code: 'bad-response', message: '响应不是 JSON' } };
  }
  if (payload.status) state.status = payload.status;
  if (!response.ok && payload.ok !== false) {
    payload.ok = false;
  }
  return { response, payload };
}

function note(text, tone = 'dim') {
  state.log.unshift({ text, tone, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
  state.log = state.log.slice(0, 40);
  renderLog();
}

function renderLog() {
  $('log').innerHTML = state.log
    .map((entry) => `<li><span class="tag ${entry.tone}">${esc(entry.at)}</span> <b>${esc(entry.text)}</b></li>`)
    .join('') || '<li class="muted">暂无操作。</li>';
}

function setEvidence(lines) {
  const box = $('evidence');
  box.innerHTML = lines
    .map((line) => {
      if (typeof line === 'string') return `<div class="evidence-line">${esc(line)}</div>`;
      return `<div class="evidence-line ${line.tone ?? ''}">${esc(line.text)}</div>`;
    })
    .join('');
}

function meter(percent, tone) {
  const width = Math.max(0, Math.min(100, Number(percent) || 0));
  return `<div class="meter ${tone}"><i style="width:${width}%"></i></div>`;
}

function slotRow(entry, { missing = false, badge = null } = {}) {
  const label = entry.label ?? entry.slot;
  const name = entry.name ?? '—';
  const sha = entry.shortSha ?? (entry.sha256 ? entry.sha256.slice(0, 12) + '…' : '—');
  return `
    <div class="slot ${missing ? 'missing' : ''}">
      <span class="label">${esc(label)}</span>
      <span class="name">${esc(name)}</span>
      <span class="sha">${esc(sha)}${badge ? ` <span class="tag ${badge.tone}">${esc(badge.text)}</span>` : ''}</span>
    </div>`;
}

function renderCapture(status) {
  const view = $('capture-view');
  const parts = status?.streaming?.parts ?? [];
  const score = status?.streaming?.score;
  const manifest = status?.streaming?.manifest;
  const files = status?.capture?.files ?? [];
  const withdrawn = status?.streaming?.withdrawn ?? [];

  if (files.length === 0) {
    view.innerHTML = `<div class="empty">台账为空。点「采集未齐谱件」写入五个声部。</div>`;
    return;
  }

  const stats = status.capture.contentStats;
  const rows = parts
    .map((part) => slotRow(part, { missing: !part.name, badge: part.name ? { text: '已入库', tone: 'ok' } : { text: '缺席', tone: 'bad' } }))
    .join('');
  const scoreRow = slotRow(
    { label: '总谱', name: score?.name ?? '（未送达）', shortSha: score?.shortSha },
    { missing: !score, badge: score ? { text: '已入库', tone: 'ok' } : { text: '缺席', tone: 'bad' } },
  );
  const manifestRow = slotRow(
    { label: '文件清单', name: manifest?.name ?? '（未送达）', shortSha: manifest?.shortSha },
    { missing: !manifest, badge: manifest ? { text: '已入库', tone: 'ok' } : { text: '缺席', tone: 'bad' } },
  );

  view.innerHTML = `
    <div class="row"><span class="k">采集批</span><span class="v">${status.capture.collections.length} 批 / ${files.length} 个文件</span><span class="tag dim">按内容寻址</span></div>
    <div class="row"><span class="k">内容库</span><span class="v">${stats.blobs} 个唯一 SHA-256 内容 · ${bytes(stats.capturedBytes)}</span><span class="tag dim">去重后</span></div>
    <div class="row"><span class="k">台账事件</span><span class="v">${status.capture.ledgerEvents} 条（追加式 JSONL）</span><span class="tag dim">可回放</span></div>
    <div class="slot-list">
      ${scoreRow}
      ${rows}
      ${manifestRow}
    </div>
    ${
      withdrawn.length
        ? `<div>
             <div class="small muted" style="margin:6px 0 4px">撤回记录（保留在台账中）</div>
             ${withdrawn
               .map(
                 (item) => `<div class="slot missing">
                   <span class="label">${esc(item.role === 'score' ? '总谱' : item.role === 'manifest' ? '文件清单' : item.partId)}</span>
                   <span class="name">${esc(item.name)}</span>
                   <span class="sha">${esc(item.shortSha)}… <span class="tag warn">已撤回</span></span>
                 </div>`,
               )
               .join('')}
           </div>`
        : ''
    }
    <div class="small muted">采集进程对齐全性不作判断：它只认内容哈希，同名不同内容会得到不同 SHA-256。</div>
  `;
}

function renderAssembly(status) {
  const view = $('assembly-view');
  const attempt = status?.lastAttempt;
  const evaluation = status?.evaluation ?? attempt;
  if (!status?.capture?.files?.length) {
    view.innerHTML = `<div class="empty">还没有采集内容，组装无从谈起。</div>`;
    return;
  }
  const missing = new Set(evaluation?.missingSlots ?? []);
  const satisfied = evaluation?.satisfied ?? 0;
  const required = evaluation?.required ?? 7;
  const percent = evaluation?.percent ?? (required ? (satisfied / required) * 100 : 0);
  const tone = evaluation?.complete ? 'ok' : 'bad';
  const attemptTone = attempt?.complete ? 'ok' : 'bad';
  const attemptInfo = attempt
    ? `<div class="row"><span class="k">最近一轮</span><span class="v">第 ${attempt.round} 轮 · ${attempt.satisfied}/${attempt.required}（${pct(attempt.percent)}）· ${esc(attempt.kind)}</span><span class="tag ${attemptTone}">${attempt.complete ? '通过' : '阻塞'}</span></div>`
    : '<div class="row"><span class="k">最近一轮</span><span class="v muted">尚未点过组装（以下为按当前台账实时判定）</span><span class="tag dim">即时</span></div>';
  const resolved = evaluation?.resolved ?? {};
  const slotLabels = { score: '总谱', manifest: '文件清单' };
  for (const part of status.streaming.parts ?? []) slotLabels[part.slot] = part.label;
  const slotDefs = ['score', ...(status.streaming.parts ?? []).map((part) => part.slot), 'manifest'].map(
    (slot) => ({
      slot,
      label: slotLabels[slot] ?? slot,
      name: resolved[slot]?.name ?? '—',
      shortSha: resolved[slot]?.sha256 ? `${resolved[slot].sha256.slice(0, 12)}…` : '—',
    }),
  );
  const blocked = evaluation?.problems ?? [];

  view.innerHTML = `
    <div class="row">
      <span class="k">当前判定</span>
      <span class="v">${evaluation?.complete ? '齐全' : '不齐'} · ${satisfied}/${required}（${pct(percent)}）</span>
      <span class="tag ${tone}">${evaluation?.complete ? '可发行' : '阻塞'}</span>
    </div>
    ${meter(percent, tone)}
    ${attemptInfo}
    <div class="slot-list">
      ${slotDefs
        .map((definition) =>
          slotRow(definition, {
            missing: missing.has(definition.slot),
            badge: missing.has(definition.slot) ? { text: '缺', tone: 'bad' } : { text: '满足', tone: 'ok' },
          }),
        )
        .join('')}
    </div>
    ${
      blocked.length
        ? `<div>
             <div class="small muted" style="margin:6px 0 4px">阻塞原因（${blocked.length}）</div>
             ${blocked
               .map(
                 (problem) => `<div class="row"><span class="k">${esc(problem.label ?? problem.slot)}</span>
                 <span class="v small">${esc(problem.message)}</span><span class="tag bad">${esc(problem.code)}</span></div>`,
               )
               .join('')}
           </div>`
        : '<div class="row"><span class="k">校验</span><span class="v small">清单固定内容全部存在且哈希一致，允许发行。</span><span class="tag ok">全部可校验</span></div>'
    }
    <div class="small muted">组装进程只认清单固定的 SHA-256；不按文件名回退，也不把旧声部混入新的一套。</div>
  `;
}

function renderDisplay(status) {
  const view = $('display-view');
  const display = status?.display;
  const latest = status?.latestVersion;
  const version = display?.version;
  if (!version) {
    view.innerHTML = `
      <div class="empty">展示站当前没有可上线的版本。${display?.reason ? `<br><span class="small">${esc(display.reason)}</span>` : ''}</div>
      ${latest ? `<div class="row"><span class="k">最新发行</span><span class="v">${esc(latest.versionId)} · ${esc(latest.createdAt)}</span><span class="tag warn">${latest.retiredAt ? '已作废' : '未上线'}</span></div>` : ''}
    `;
    return;
  }
  view.innerHTML = `
    <div class="row"><span class="k">展示版本</span><span class="v">${esc(version.versionId)} · ${esc(version.title)}</span><span class="tag ok">已上线</span></div>
    <div class="row"><span class="k">固定内容</span><span class="v">${version.slots.length} 个槽位 · ${version.slots.reduce((sum, slot) => sum + (slot.bytes ?? 0), 0)} B</span><span class="tag dim">${esc(version.createdAt)}</span></div>
    <div class="slot-list">
      ${version.slots.map((slot) => slotRow(slot)).join('')}
    </div>
    <div class="download-row">
      ${version.vouchers.map((voucher) => `<a class="tag ok" href="/api/download/${encodeURIComponent(voucher.voucherId)}/score">下载 ${esc(voucher.voucherId)} 总谱</a>`).join('')}
    </div>
    <div class="small muted">${esc(display.reason)}</div>
  `;
}

function renderVersions(status, expanded) {
  const view = $('versions-view');
  const versions = status?.versions ?? [];
  if (!expanded) {
    view.innerHTML = `<div class="empty">点「查看发行版本」展开历史版本、作废凭证与固定哈希。</div>`;
    return;
  }
  if (versions.length === 0) {
    view.innerHTML = `<div class="empty">还没有发行过任何版本。</div>`;
    return;
  }
  view.innerHTML = versions
    .slice()
    .reverse()
    .map((version) => {
      const retired = Boolean(version.retiredAt);
      return `
        <div class="version-card ${version.isDisplay ? 'display' : ''} ${retired ? 'retired' : ''}">
          <div class="version-head">
            <h3>${esc(version.versionId)}</h3>
            <span class="vmeta">${esc(version.createdAt)} · 第 ${version.sequence} 个版本</span>
            <span class="spacer"></span>
            ${version.isDisplay ? '<span class="tag ok">展示中</span>' : ''}
            ${retired ? `<span class="tag warn">已作废 · 由 ${esc(version.supersededBy ?? '—')} 取代</span>` : ''}
          </div>
          <div class="slot-list">
            ${version.slots.map((slot) => slotRow(slot)).join('')}
          </div>
          <div class="vouchers">
            ${
              version.vouchers.length
                ? version.vouchers
                    .map(
                      (voucher) => `<div class="voucher">
                        <span class="tag ${retired ? 'warn' : 'ok'}">${esc(voucher.voucherId)}</span>
                        <span class="muted">${esc(voucher.origin)} · ${esc(voucher.issuedAt)}</span>
                        <span class="download-row">
                          ${version.slots
                            .map(
                              (slot) =>
                                `<a href="/api/download/${encodeURIComponent(voucher.voucherId)}/${encodeURIComponent(slot.slot)}"><button type="button">${esc(slot.label)}</button></a>`,
                            )
                            .join('')}
                        </span>
                      </div>`,
                    )
                    .join('')
                : '<span class="small muted">该版本尚无下载凭证。</span>'
            }
          </div>
        </div>`;
    })
    .join('');
}

function renderAll({ expandVersions = null } = {}) {
  if (!state.status) return;
  renderCapture(state.status);
  renderAssembly(state.status);
  renderDisplay(state.status);
  if (expandVersions !== null) {
    state.showVersions = expandVersions;
  }
  renderVersions(state.status, state.showVersions);
  $('scene-now').textContent = state.status.scene?.now ?? '—';
}

function summarise(status) {
  const attempt = status.evaluation ?? status.lastAttempt;
  return {
    satisfied: attempt?.satisfied ?? 0,
    required: attempt?.required ?? 7,
    percent: pct(attempt?.percent ?? 0),
    missing: attempt?.missingSlots ?? [],
    display: status.display?.versionId ?? null,
    versions: status.versions?.length ?? 0,
    vouchers: status.vouchers?.length ?? 0,
    files: status.capture?.files?.length ?? 0,
    blobs: status.capture?.contentStats?.blobs ?? 0,
  };
}

function evidenceFor(action, before, after, extra = []) {
  const lines = [
    { text: `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${action}`, tone: 'kv' },
  ];
  if (before) {
    lines.push({
      text: `操作前：齐全度 ${before.satisfied}/${before.required}（${before.percent}），缺 ${before.missing.join('、') || '无'}；展示站 ${before.display ?? '空'}；发行版本 ${before.versions}；凭证 ${before.vouchers}；采集文件 ${before.files}（唯一内容 ${before.blobs}）。`,
      tone: 'dim',
    });
  }
  lines.push({
    text: `操作后：齐全度 ${after.satisfied}/${after.required}（${after.percent}），缺 ${after.missing.join('、') || '无'}；展示站 ${after.display ?? '空'}；发行版本 ${after.versions}；凭证 ${after.vouchers}；采集文件 ${after.files}（唯一内容 ${after.blobs}）。`,
    tone: after.satisfied === after.required ? 'good' : 'bad',
  });
  for (const item of extra) lines.push(item);
  setEvidence(lines);
}

async function refresh() {
  const { payload } = await api('/api/status');
  if (payload.ok) {
    state.status = payload.status;
    renderAll();
  }
}

async function withBusy(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '处理中…';
  try {
    await fn();
  } catch (error) {
    note(`请求失败：${error.message}`, 'bad');
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

async function actionCaptureParts(button) {
  if (!state.status) state.status = (await api('/api/status')).payload.status;
  const before = summarise(state.status);
  const { payload } = await api('/api/capture/parts', { method: 'POST', body: {} });
  if (!payload.ok) {
    note(`采集失败：${payload.error?.message}`, 'bad');
    return;
  }
  state.status = payload.status ?? state.status;
  renderAll();
  const after = summarise(state.status);
  evidenceFor('采集未齐谱件（仅五个声部）', before, after, [
    { text: `采集批 ${payload.result.collection.collectionId}：「${payload.result.collection.label}」，写入 ${payload.result.captured} 个文件，唯一内容增至 ${after.blobs} 个。`, tone: 'dim' },
    { text: `总谱与文件清单仍未送达 → 组装判定 5/7，展示站保持空。`, tone: 'warn' },
    { text: `提示：点「补发总谱并重试」，采集进程会带上一份固定五个声部 sha256 的文件清单。`, tone: 'dim' },
  ]);
  note(`采集未齐谱件：写入 ${payload.result.captured} 个声部文件`, 'ok');
}

async function actionRetry(button) {
  if (!state.status) state.status = (await api('/api/status')).payload.status;
  const before = summarise(state.status);
  const { payload } = await api('/api/retry', { method: 'POST', body: {} });
  if (payload.status) state.status = payload.status;
  renderAll();
  const after = summarise(state.status);
  if (!payload.ok) {
    note(`补发失败：${payload.error?.message}`, 'bad');
    evidenceFor('补发总谱并重试（未通过）', before, after, [
      { text: `失败原因：${payload.error?.message ?? '未知'}`, tone: 'bad' },
    ]);
    return;
  }
  const version = payload.assemble?.version ?? null;
  const extra = [
    { text: `补发模式：${payload.mode}` , tone: 'dim' },
    { text: `采集批新增：${payload.capture ? `${payload.capture.captured} 个文件（总谱 + 文件清单）` : `${payload.scoreFile?.fileId ?? ''} 总谱 + ${payload.manifestFile?.fileId ?? ''} 清单`}`, tone: 'dim' },
  ];
  if (version) {
    extra.push({ text: `发行版本 ${version.versionId} 固定 ${version.fixedShaList.length} 个 SHA-256；展示站切到 ${version.versionId}。`, tone: 'good' });
  } else if (payload.assemble?.note) {
    extra.push({ text: `组装结果：${payload.assemble.note}`, tone: 'warn' });
  }
  evidenceFor('补发总谱并重试', before, after, extra);
  note(`补发总谱并重试：${version ? `发行 ${version.versionId}` : payload.assemble?.note ?? '完成'}`, version ? 'ok' : 'warn');
}

async function actionVersions(button) {
  const { payload } = await api('/api/status');
  state.status = payload.status;
  state.showVersions = true;
  renderAll({ expandVersions: true });
  const before = summarise(state.status);
  const versions = state.status.versions ?? [];
  const vouchers = state.status.vouchers ?? [];
  const retired = state.status.retiredVersions ?? [];
  evidenceFor('查看发行版本', before, before, [
    { text: `发行版本 ${versions.length} 个：${versions.map((version) => `${version.versionId}${version.retiredAt ? '(作废)' : version.isDisplay ? '(展示中)' : ''}`).join('、') || '无'}。`, tone: 'dim' },
    { text: `作废版本 ${retired.length} 个；下载凭证 ${vouchers.length} 张，其中作废版本凭证 ${vouchers.filter((voucher) => voucher.stillValid === false).length} 张仍保留。`, tone: retired.length ? 'warn' : 'dim' },
    { text: `展示站当前指针：${state.status.display?.versionId ?? '空'}${state.status.display?.reason ? `（${state.status.display.reason}）` : ''}。`, tone: 'dim' },
    ...versions.map((version) => ({
      text: `  ${version.versionId} ${version.retiredAt ? `作废于 ${version.retiredAt}` : version.isDisplay ? '展示中' : '未展示'} · 固定哈希 ${version.slots.map((slot) => `${slot.slot}:${slot.shortSha}`).join(' ')}`,
      tone: 'dim',
    })),
  ]);
  note(`查看发行版本：${versions.length} 个版本、${vouchers.length} 张凭证`, 'ok');
}

async function actionWithdraw(button) {
  const before = summarise(state.status);
  const { payload } = await api('/api/withdraw', { method: 'POST', body: { kind: 'score', reason: '总谱排版错误，先撤回' } });
  if (!payload.ok) {
    note(`撤回失败：${payload.error?.message}`, 'bad');
    return;
  }
  state.status = payload.status ?? state.status;
  renderAll();
  const after = summarise(state.status);
  const frozen = payload.after?.frozen;
  evidenceFor('撤回总谱（随后自动组装校验）', before, after, [
    { text: `撤回文件 ${payload.file.fileId} · SHA ${payload.evidence.shortSha}…，撤回证据写入台账（${payload.file.withdrawnAt}）。`, tone: 'warn' },
    { text: `随后的组装：${payload.after.attempt.satisfied}/${payload.after.attempt.required}，缺 ${payload.after.attempt.missingSlots.join('、') || '无'}；问题 ${payload.after.attempt.problems.map((problem) => problem.code).join('、') || '无'}。`, tone: 'bad' },
    frozen ? { text: `展示站从 ${frozen.from} 冻结 → 当前展示 ${after.display ?? '空'}；作废版本的下载凭证仍保留。`, tone: 'warn' } : { text: '展示站无变化。', tone: 'dim' },
  ]);
  note('撤回总谱：展示站冻结，旧凭证保留', 'warn');
}

async function actionRevise(mode, button) {
  if (!state.status) state.status = (await api('/api/status')).payload.status;
  const before = summarise(state.status);
  const body = {
    partId: 'vn1',
    mode,
    content: mode === 'freeze'
      ? `Violin I — 主题呈示修订版（冻结式，快照 D）\n`
      : `Violin I — 弓法修订版（按清单引用，快照 D）\n`,
    name: mode === 'freeze' ? 'vn1.part.rev-freeze.txt' : 'vn1.part.rev-ref.txt',
  };
  const { payload } = await api('/api/revise-part', { method: 'POST', body });
  if (payload.status) state.status = payload.status;
  renderAll();
  const after = summarise(state.status);
  if (!payload.ok) {
    evidenceFor(`修订声部（${mode === 'freeze' ? '整套冻结' : '按清单引用'}）被拒绝`, before, after, [
      { text: `拒绝原因：${payload.error?.message ?? payload.attempt?.problems?.[0]?.message ?? '未知'}`, tone: 'bad' },
      ...(payload.verification ?? [])
        .filter((item) => !item.ok)
        .map((item) => ({ text: `  ${item.label ?? item.slot}：${item.message}`, tone: 'bad' })),
    ]);
    note(`修订被拒绝：${payload.error?.code ?? 'unknown'}`, 'bad');
    return;
  }
  if (mode === 'freeze') {
    evidenceFor('修订声部（整套冻结）', before, after, [
      { text: `声部 vn1 已换为 ${(payload.file?.sha256 ?? '').slice(0, 12)}…（${payload.file?.name ?? ''}）；旧版本 ${payload.baseVersionId} 被作废，展示站清空。`, tone: 'warn' },
      { text: `当前组装 ${after.satisfied}/${after.required}，缺 ${after.missing.join('、') || '无'}；新文件清单尚未生成，必须重新采集齐全后才能上线。`, tone: 'bad' },
    ]);
    note('修订声部（整套冻结）：旧版本作废、展示站冻结', 'warn');
    return;
  }
  const version = payload.version;
  evidenceFor('修订声部（按清单引用）', before, after, [
    { text: `新版本 ${version.versionId} 只替换 vn1（${version.slots.find((slot) => slot.slot === 'vn1')?.shortSha}…），其余 ${version.slots.length - 1} 个槽位引用 ${payload.baseVersionId} 的固定文件。`, tone: 'good' },
    { text: `按清单引用校验：${payload.verification.filter((item) => item.ok).length}/${payload.verification.length} 个固定内容可校验；展示站切到 ${version.versionId}。`, tone: 'good' },
    { text: `旧版本 ${payload.baseVersionId} 已作废，其下载凭证仍保留并可下载固定内容。`, tone: 'dim' },
  ]);
  note(`修订声部（按清单引用）：发行 ${version.versionId}`, 'ok');
}

async function actionReset(button) {
  const { payload } = await api('/api/demo/reset', { method: 'POST', body: {} });
  if (!payload.ok) return;
  state.status = payload.status;
  state.showVersions = false;
  state.log = [];
  renderAll({ expandVersions: false });
  renderLog();
  setEvidence(['台账已清空；数据目录 .data/ 已重建。可重新从「采集未齐谱件」开始。']);
  note('清空台账', 'warn');
}

function bind() {
  $('btn-parts').addEventListener('click', (event) =>
    withBusy(event.currentTarget, () => actionCaptureParts(event.currentTarget)),
  );
  $('btn-retry').addEventListener('click', (event) =>
    withBusy(event.currentTarget, () => actionRetry(event.currentTarget)),
  );
  $('btn-versions').addEventListener('click', (event) =>
    withBusy(event.currentTarget, () => actionVersions(event.currentTarget)),
  );
  $('btn-withdraw').addEventListener('click', (event) =>
    withBusy(event.currentTarget, () => actionWithdraw(event.currentTarget)),
  );
  $('btn-revise-freeze').addEventListener('click', (event) =>
    withBusy(event.currentTarget, () => actionRevise('freeze', event.currentTarget)),
  );
  $('btn-revise-ref').addEventListener('click', (event) =>
    withBusy(event.currentTarget, () => actionRevise('reference', event.currentTarget)),
  );
  $('btn-reset').addEventListener('click', (event) =>
    withBusy(event.currentTarget, () => actionReset(event.currentTarget)),
  );
}

async function boot() {
  bind();
  await refresh();
  renderAll({ expandVersions: false });
  const status = state.status;
  if (status && status.capture.files.length === 0) {
    setEvidence([
      '台账为空：齐全度 0/7（0.0%），展示站 空，发行版本 0，下载凭证 0。',
      '下一步：点「采集未齐谱件」——只送达五个声部，总谱与文件清单缺席。',
    ]);
  }
}

boot();
