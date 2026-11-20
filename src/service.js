import { DomainError, invariant } from './errors.js';
import {
  CONTENT_SLOTS,
  PART_SLOTS,
  SLOT_BY_KEY,
  buildManifestText,
  entriesFromVersion,
  parseManifest,
  percent,
  requirePart,
  shortSha,
} from './domain.js';
import {
  attemptRound,
  evaluateSet,
  latestLive,
  makeAttempt,
  slotsForVersion,
} from './assembler.js';

import { SCENE, captureParts, captureScore } from './collector.js';

export { SCENE, captureParts, captureScore };

function latestVersion(store) {
  return store.versionList().at(-1) ?? null;
}

function partFile(store, partId) {
  return latestLive(store, 'part', partId);
}

/**
 * If the display slot currently shows the version we are about to invalidate,
 * the display is frozen immediately. Showing a set while its score is withdrawn
 * would mean the page mixes in stale content — exactly what this demo forbids.
 */
function freezeDisplayIfShowing(store, versionId, reason) {
  const display = store.displayPointer();
  if (!display?.versionId) return null;
  if (versionId && display.versionId !== versionId) return null;
  store.clearDisplay(reason);
  return { from: display.versionId, reason };
}

function publishVersion(store, { evaluation, kind, note }) {
  const version = {
    versionId: `v${store.state.counters.version + 1}`,
    sequence: store.state.counters.version + 1,
    title: evaluation.manifest?.title || SCENE.title,
    note: evaluation.manifest?.note || SCENE.note,
    createdAt: store.nextAt(),
    fixedShaList: evaluation.fixedShaList,
    slots: slotsForVersion(store, evaluation),
    manifest: evaluation.manifest,
    sourceRound: attemptRound(store),
    kind,
    note,
  };
  const previous = latestVersion(store);
  if (previous) {
    store.retireVersion(previous.versionId, {
      reason: `由 ${version.versionId} 取代，凭证仍可下载`,
      supersededBy: version.versionId,
    });
  }
  store.publish({ version, display: true });
  store.issueVoucher({
    voucherId: `DL-${String(store.state.counters.voucher + 1).padStart(4, '0')}`,
    versionId: version.versionId,
    issuedAt: store.nextAt(),
    origin: '发行时自动出具',
    retiredAtIssue: false,
    fixedShaList: version.fixedShaList,
  });
  return version;
}

export function assemble(store) {
  const evaluation = evaluateSet(store);
  const attempt = makeAttempt(store, evaluation, { kind: 'assemble' });

  if (!evaluation.complete) {
    const latest = latestVersion(store);
    const frozen = freezeDisplayIfShowing(
      store,
      latest?.versionId ?? null,
      '组装未通过：展示站已冻结，不再拼入旧声部',
    );
    const stored = {
      ...attempt,
      switched: Boolean(frozen),
      switchedFrom: frozen?.from ?? null,
    };
    store.recordAttempt(stored);
    return {
      ok: false,
      attempt: stored,
      frozen,
      error: {
        code: 'set-incomplete',
        message: frozen
          ? `谱件不齐（${stored.satisfied}/${stored.required}），展示站已从 ${frozen.from} 冻结`
          : `谱件不齐（${stored.satisfied}/${stored.required}），未发行任何版本`,
        status: 422,
      },
    };
  }

  const latest = latestVersion(store);
  if (latest && !store.isRetired(latest.versionId)) {
    const samePins = JSON.stringify(latest.fixedShaList) === JSON.stringify(evaluation.fixedShaList);
    if (samePins) {
      const stored = { ...attempt, note: `内容与 ${latest.versionId} 相同，无需重复发行` };
      store.recordAttempt(stored);
      return { ok: true, attempt: stored, version: null, note: stored.note };
    }
  }

  store.recordAttempt(attempt);
  const version = publishVersion(store, { evaluation, kind: 'assemble', note: '齐全后发行' });
  return {
    ok: true,
    attempt: { ...store.getAttempt(attempt.attemptId), publishedVersionId: version.versionId },
    version,
    note: `已发行 ${version.versionId}`,
  };
}

/**
 * Score-only resend. The prior manifest is reused only while *every* other pin
 * still matches the live captures; otherwise the request is refused, because
 * accepting it would publish a set that mixes a fresh score with old parts.
 */
export function resendScore(store, payload = {}) {
  const manifestFile = latestLive(store, 'manifest');
  invariant(manifestFile, 'no-manifest', '没有可沿用的文件清单，无法只补发总谱', 409);
  const parsed = parseManifest(store.readContent(manifestFile.sha256).toString('utf8'));
  invariant(parsed.ok, 'manifest-invalid', '现有文件清单结构无效，不能只补发总谱', 409);

  const mismatches = [];
  for (const definition of PART_SLOTS) {
    const live = partFile(store, definition.partId);
    const pinned = parsed.entriesBySlot[definition.slot];
    if (!live) mismatches.push(`${definition.label}：没有在库声部`);
    else if (!pinned) mismatches.push(`${definition.label}：清单未列`);
    else if (live.sha256 !== pinned.sha256) {
      mismatches.push(`${definition.label}：清单固定 ${shortSha(pinned.sha256)}…，在库为 ${shortSha(live.sha256)}…`);
    }
  }
  invariant(
    mismatches.length === 0,
    'manifest-stale',
    `补发总谱会混入旧声部，已拒绝：${mismatches.join('；')}`,
    409,
    { mismatches },
  );

  const scoreText = String(payload?.score?.content ?? 'Full Score — 总谱补发（快照 C，修正排版）\n');
  invariant(scoreText.length > 0, 'empty-score', '总谱内容为空', 400);
  const scoreCapture = store.collect({
    label: payload.label || '采集批：总谱补发（快照 C）',
    files: [
      {
        role: 'score',
        partId: null,
        name: payload?.score?.name || parsed.entriesBySlot.score.name,
        content: scoreText,
      },
    ],
  });
  const scoreFile = scoreCapture.files[0];
  const rebuilt = buildManifestText({
    title: parsed.title,
    note: parsed.note,
    entries: CONTENT_SLOTS.map((definition) =>
      definition.slot === 'score'
        ? {
            slot: 'score',
            role: 'score',
            partId: null,
            name: scoreFile.name,
            sha256: scoreFile.sha256,
            bytes: scoreFile.bytes,
          }
        : parsed.entriesBySlot[definition.slot],
    ),
  });
  const manifestCapture = store.collect({
    label: '采集批：补发后的文件清单（快照 C）',
    files: [{ role: 'manifest', partId: null, name: 'manifest.resend.json', content: rebuilt }],
  });
  const result = assemble(store);
  return {
    ok: result.ok,
    mode: 'score-resend',
    collection: scoreCapture.collection,
    scoreFile,
    manifestFile: manifestCapture.files[0],
    manifestNote: '新文件清单只替换总谱条目，五个声部仍引用原固定 sha256',
    assemble: result,
    error: result.error ?? null,
  };
}

/**
 * Revise one part.
 *
 * freeze    — the whole set is frozen: current version is retired, display is
 *             cleared, and nothing may be shown until a complete set is
 *             reassembled. No manifest is rewritten here on purpose.
 * reference — the new version pins a new file for that part and references the
 *             exact file versions of every other slot; if any pin is no longer
 *             retained the revision is rejected rather than falling back.
 */
export function revisePart(store, payload = {}) {
  const definition = requirePart(payload.partId);
  const content = String(payload.content ?? '');
  invariant(content.length > 0, 'empty-part', '修订后的声部内容为空', 400);
  const mode = payload.mode === 'reference' ? 'reference' : 'freeze';
  const baseVersion = latestVersion(store);

  if (mode === 'freeze') {
    const capture = store.collect({
      label: payload.label || `采集批：${definition.label} 修订（整套冻结）`,
      files: [
        {
          role: 'part',
          partId: definition.partId,
          name: payload.name || `${definition.partId}.part.rev.txt`,
          content,
        },
      ],
    });
    const retired = baseVersion
      ? store.retireVersion(baseVersion.versionId, { reason: `声部 ${definition.label} 修订，整套冻结` })
      : null;
    const frozen = baseVersion
      ? freezeDisplayIfShowing(store, baseVersion.versionId, `整套冻结：${definition.label} 修订中`)
      : null;
    // Whole-set freeze: every live score and manifest goes too, so no later
    // retry can pin the pre-revision parts through an older manifest.
    const stale = store
      .fileList()
      .filter((file) => !file.withdrawn && (file.role === 'manifest' || file.role === 'score'));
    for (const file of stale) {
      store.withdrawFile(file.fileId, '整套冻结：随旧版本一并作废，待重新采集补齐');
    }
    const evaluation = evaluateSet(store);
    const attempt = makeAttempt(store, evaluation, {
      kind: 'revise-freeze',
      note: `整套冻结：${definition.label} 修订，旧发行版停用，等待重新组装`,
    });
    store.recordAttempt({ ...attempt, switched: Boolean(frozen), switchedFrom: frozen?.from ?? null });
    return {
      ok: true,
      mode,
      outcome: 'frozen',
      partId: definition.partId,
      collection: capture.collection,
      file: capture.files[0],
      retired: retired?.retirement ?? null,
      frozen,
      baseVersionId: baseVersion?.versionId ?? null,
      attempt: store.getAttempt(attempt.attemptId),
      note: '整套冻结完成：旧内容不再参与展示，需重新采集齐全后才能上线',
    };
  }

  invariant(baseVersion, 'no-version', '还没有可按清单引用的发行版本', 409);
  const baseEntries = entriesFromVersion(baseVersion);
  const capture = store.collect({
    label: payload.label || `采集批：${definition.label} 修订（按清单引用）`,
    files: [
      {
        role: 'part',
        partId: definition.partId,
        name: payload.name || `${definition.partId}.part.rev.txt`,
        content,
      },
    ],
  });
  const newFile = capture.files[0];
  const entries = baseEntries.map((entry) =>
    entry.slot === definition.slot
      ? { ...entry, name: newFile.name, sha256: newFile.sha256, bytes: newFile.bytes }
      : entry,
  );
  const manifestText = buildManifestText({ title: baseVersion.title, note: baseVersion.note, entries });
  const manifestCapture = store.collect({
    label: '采集批：修订后的文件清单',
    files: [{ role: 'manifest', partId: null, name: 'manifest.rev.json', content: manifestText }],
  });
  const manifestFile = manifestCapture.files[0];

  const verification = [];
  for (const entry of baseEntries) {
    if (entry.slot === definition.slot) continue;
    const pinned = baseVersion.slots[entry.slot];
    const holder = store.fileList().find((file) => file.fileId === pinned.fileId);
    const contentCheck = store.verifyContent(pinned.sha256);
    if (!holder) {
      verification.push({ slot: entry.slot, label: SLOT_BY_KEY.get(entry.slot)?.label, ok: false, message: `固定文件 ${pinned.fileId} 不在台账中` });
    } else if (holder.withdrawn) {
      verification.push({ slot: entry.slot, label: SLOT_BY_KEY.get(entry.slot)?.label, ok: false, message: `固定文件 ${pinned.fileId} 已撤回` });
    } else if (!contentCheck.ok) {
      verification.push({ slot: entry.slot, label: SLOT_BY_KEY.get(entry.slot)?.label, ok: false, message: contentCheck.message });
    } else {
      verification.push({ slot: entry.slot, label: SLOT_BY_KEY.get(entry.slot)?.label, ok: true, message: `固定 ${shortSha(pinned.sha256)}…` });
    }
  }
  const failed = verification.filter((item) => !item.ok);
  if (failed.length > 0) {
    const evaluation = {
      complete: false,
      required: CONTENT_SLOTS.length + 1,
      satisfied: CONTENT_SLOTS.length + 1 - failed.length,
      percent: percent(CONTENT_SLOTS.length + 1 - failed.length, CONTENT_SLOTS.length + 1),
      missingSlots: failed.map((item) => item.slot),
      problems: failed.map((item) => ({
        code: 'reference-unavailable',
        slot: item.slot,
        label: item.label,
        message: `按清单引用失败：${item.message}，拒绝回退旧版本`,
      })),
      withdrawnEvidence: [],
      manifest: null,
      resolved: {},
      fixedShaList: [],
    };
    const attempt = makeAttempt(store, evaluation, {
      kind: 'revise-reference',
      note: `按清单引用修订 ${definition.label} 被拒绝`,
    });
    store.recordAttempt(attempt);
    return {
      ok: false,
      mode,
      outcome: 'rejected',
      partId: definition.partId,
      attempt: store.getAttempt(attempt.attemptId),
      verification,
      error: { code: 'reference-unavailable', message: '按清单引用无法满足，未发行新版本', status: 422 },
    };
  }

  const evaluation = evaluateSet(store);
  if (!evaluation.complete) {
    const attempt = makeAttempt(store, evaluation, {
      kind: 'revise-reference',
      note: '按清单引用后组装未通过',
    });
    store.recordAttempt(attempt);
    return {
      ok: false,
      mode,
      outcome: 'incomplete',
      partId: definition.partId,
      attempt: store.getAttempt(attempt.attemptId),
      verification,
      error: { code: 'set-incomplete', message: '按清单引用后仍不齐全，未发行', status: 422 },
    };
  }

  const attempt = makeAttempt(store, evaluation, {
    kind: 'revise-reference',
    note: `按清单引用修订 ${definition.label}`,
  });
  store.recordAttempt(attempt);
  const version = publishVersion(store, {
    evaluation,
    kind: 'revise-reference',
    note: `仅 ${definition.label} 换版，其余槽位引用 ${baseVersion.versionId} 的固定文件`,
  });
  return {
    ok: true,
    mode,
    outcome: 'republished',
    partId: definition.partId,
    version: versionSummary(store, version, store.displayPointer()?.versionId ?? null),
    attempt: store.getAttempt(attempt.attemptId),
    verification,
    baseVersionId: baseVersion.versionId,
    manifestFile,
    note: `已发行 ${version.versionId}；其余槽位仍引用 ${baseVersion.versionId} 的固定 sha256`,
  };
}

/**
 * One entry point for "补齐总谱并重试组装":
 *  - no live manifest  -> capture a fresh score + manifest from the live parts;
 *  - manifest but no live score -> score-only resend against the pinned manifest;
 *  - otherwise -> just re-run assembly.
 */
export function retryAssembly(store, payload = {}) {
  const liveScore = latestLive(store, 'score');
  const liveManifest = latestLive(store, 'manifest');
  let mode;
  let capture = null;
  if (!liveManifest) {
    mode = 'capture-score-and-manifest';
    // The live manifest is gone: rebuild one that pins the *newest* live part
    // captures. Without that, the older manifest would pin the previous part
    // version and assembly would (correctly) refuse the mixed set.
    const hadVersion = store.versionList().length > 0;
    capture = captureScore(store, {
      ...payload,
      score: {
        name: payload?.score?.name || 'score.full.txt',
        content:
          payload?.score?.content ||
          (hadVersion
            ? 'Full Score — 冻结后补齐重发（快照 E）\n'
            : 'Full Score — 总谱（快照 B，晚于声部送达）\n'),
      },
    });
  } else if (!liveScore) {
    mode = 'resend-score';
    const result = resendScore(store, payload);
    return { ok: result.ok, mode, scoreFile: result.scoreFile, manifestFile: result.manifestFile, assemble: result.assemble, error: result.error ?? null };
  } else {
    mode = 'assemble-only';
  }
  const assembled = assemble(store);
  return {
    ok: assembled.ok,
    mode,
    capture,
    assemble: assembled,
    error: assembled.error ?? null,
  };
}

/**
 * Read one file out of a published version. The slot is always resolved through
 * that version's pinned SHA-256, so an old part can never be read into a newer
 * set (and a newer part can never leak into an older version).
 */
export function readVersionFile(store, versionId, slot) {
  const version = store.getVersion(versionId);
  invariant(version, 'version-not-found', `找不到发行版本 ${versionId}`, 404);
  const pinned = version.slots[slot];
  invariant(pinned, 'slot-not-in-version', `版本 ${versionId} 不含槽位 ${String(slot)}`, 404);
  const buffer = store.readContent(pinned.sha256);
  return {
    versionId,
    slot,
    label: SLOT_BY_KEY.get(slot)?.label ?? slot,
    name: pinned.name,
    sha256: pinned.sha256,
    bytes: buffer.length,
    buffer,
    situation: store.isRetired(versionId) ? 'retired' : store.displayPointer()?.versionId === versionId ? 'display' : 'off-display',
  };
}

export function issueVoucher(store, payload = {}) {
  const versions = store.versionList();
  invariant(versions.length > 0, 'no-version', '还没有任何发行版本，无法出具下载凭证', 409);
  const requested = payload.versionId ? store.getVersion(payload.versionId) : latestVersion(store);
  invariant(requested, 'version-not-found', `找不到发行版本 ${String(payload.versionId)}`, 404);
  const voucher = {
    voucherId: `DL-${String(store.state.counters.voucher + 1).padStart(4, '0')}`,
    versionId: requested.versionId,
    issuedAt: store.nextAt(),
    origin: store.isRetired(requested.versionId) ? '作废版本留档' : '展示站下载',
    retiredAtIssue: store.isRetired(requested.versionId),
    fixedShaList: requested.fixedShaList,
  };
  store.issueVoucher(voucher);
  return {
    ok: true,
    voucher: store.getVoucher(voucher.voucherId),
    versionId: requested.versionId,
    note: store.isRetired(requested.versionId)
      ? `版本 ${requested.versionId} 已作废，下载凭证保留，仍可核对或取回该版固定内容`
      : `已为 ${requested.versionId} 出具下载凭证`,
  };
}

export function downloadPlan(store, voucherId) {
  const voucher = store.getVoucher(voucherId);
  invariant(voucher, 'voucher-not-found', `找不到下载凭证 ${voucherId}`, 404);
  const version = store.getVersion(voucher.versionId);
  invariant(version, 'voucher-version-missing', `凭证指向的版本 ${voucher.versionId} 不在台账中`, 409);
  const display = store.displayPointer();
  const situation = store.isRetired(version.versionId)
    ? 'retired'
    : display?.versionId === version.versionId
      ? 'display'
      : 'off-display';
  return {
    voucherId,
    versionId: version.versionId,
    situation,
    stillValid: situation !== 'retired',
    title: version.title,
    files: Object.entries(version.slots).map(([slot, file]) => ({
      slot,
      label: SLOT_BY_KEY.get(slot)?.label ?? slot,
      name: file.name,
      sha256: file.sha256,
      shortSha: shortSha(file.sha256),
      bytes: file.bytes,
    })),
  };
}

export function voucherDownload(store, voucherId, slot) {
  const plan = downloadPlan(store, voucherId);
  const file = plan.files.find((item) => item.slot === slot);
  invariant(file, 'slot-not-in-voucher', `下载凭证 ${voucherId} 不含槽位 ${String(slot)}`, 404);
  try {
    const buffer = store.readContent(file.sha256);
    store.recordServe({
      voucherId,
      versionId: plan.versionId,
      key: slot,
      sha256: file.sha256,
      ok: true,
      reason: plan.situation === 'retired' ? '作废版本留档凭证' : null,
    });
    return { ok: true, file, buffer, situation: plan.situation };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    store.recordServe({
      voucherId,
      versionId: plan.versionId,
      key: slot,
      sha256: file.sha256,
      ok: false,
      reason: error.code,
    });
    throw error;
  }
}

function versionSummary(store, version, displayId) {
  if (!version) return null;
  const retirement = store.getRetirement(version.versionId);
  return {
    versionId: version.versionId,
    sequence: version.sequence,
    title: version.title,
    note: version.note,
    createdAt: version.createdAt,
    kind: version.kind ?? null,
    isDisplay: version.versionId === displayId,
    retiredAt: retirement?.at ?? null,
    supersededBy: retirement?.supersededBy ?? null,
    retiredReason: retirement?.reason ?? null,
    slots: Object.entries(version.slots).map(([slot, file]) => ({
      slot,
      label: SLOT_BY_KEY.get(slot)?.label ?? slot,
      partId: SLOT_BY_KEY.get(slot)?.partId ?? null,
      name: file.name,
      sha256: file.sha256,
      shortSha: shortSha(file.sha256),
      bytes: file.bytes,
      source: file.source ?? null,
    })),
    manifest: version.manifest,
    vouchers: store
      .voucherList()
      .filter((voucher) => voucher.versionId === version.versionId)
      .map((voucher) => ({
        voucherId: voucher.voucherId,
        issuedAt: voucher.issuedAt,
        origin: voucher.origin,
        stillValid: !store.isRetired(voucher.versionId),
      })),
  };
}

function summariseAttempt(attempt) {
  return {
    attemptId: attempt.attemptId,
    kind: attempt.kind,
    round: attempt.round,
    at: attempt.at,
    complete: attempt.complete,
    satisfied: attempt.satisfied,
    required: attempt.required,
    percent: attempt.percent,
    missingSlots: attempt.missingSlots,
    problems: attempt.problems,
    note: attempt.note,
    switched: Boolean(attempt.switched),
    switchedFrom: attempt.switchedFrom ?? null,
    publishedVersionId: attempt.publishedVersionId ?? null,
  };
}

export function buildStatus(store) {
  const display = store.displayPointer();
  const versions = store.versionList();
  const latest = versions.at(-1) ?? null;
  const attempts = store.attemptList();
  const files = store.fileList();
  const parts = PART_SLOTS.map((definition) => {
    const file = partFile(store, definition.partId);
    return {
      slot: definition.slot,
      partId: definition.partId,
      label: definition.label,
      name: file?.name ?? null,
      fileId: file?.fileId ?? null,
      sha256: file?.sha256 ?? null,
      shortSha: file ? shortSha(file.sha256) : null,
      source: file ? store.getCollection(file.collectionId)?.label ?? null : null,
    };
  });
  const score = latestLive(store, 'score');
  const manifest = latestLive(store, 'manifest');
  const evaluation = evaluateSet(store);
  return {
    scene: { title: SCENE.title, note: SCENE.note, sourceLabels: SCENE.sourceLabels, now: store.nextAt() },
    evaluation: {
      complete: evaluation.complete,
      satisfied: evaluation.satisfied,
      required: evaluation.required,
      percent: evaluation.percent,
      missingSlots: evaluation.missingSlots,
      problems: evaluation.problems,
      resolved: evaluation.resolved,
      manifest: evaluation.manifest
        ? { name: evaluation.manifest.name, shortSha: evaluation.manifest.shortSha, entryCount: evaluation.manifest.entryCount }
        : null,
    },
    capture: {
      collections: store.collectionList().map((collection) => ({
        collectionId: collection.collectionId,
        label: collection.label,
        at: collection.at,
        fileCount: collection.fileIds.length,
      })),
      files: files.map((file) => ({
        fileId: file.fileId,
        collectionId: file.collectionId,
        collectionLabel: store.getCollection(file.collectionId)?.label ?? null,
        role: file.role,
        partId: file.partId,
        name: file.name,
        sha256: file.sha256,
        shortSha: shortSha(file.sha256),
        bytes: file.bytes,
        capturedAt: file.capturedAt,
        deduped: file.deduped,
        withdrawn: file.withdrawn,
        withdrawnAt: file.withdrawnAt ?? null,
        withdrawnReason: file.withdrawnReason ?? null,
      })),
      contentStats: store.contentStats(),
      ledgerEvents: store.events.length,
    },
    streaming: {
      parts,
      score: score
        ? {
            name: score.name,
            fileId: score.fileId,
            sha256: score.sha256,
            shortSha: shortSha(score.sha256),
            source: store.getCollection(score.collectionId)?.label ?? null,
          }
        : null,
      manifest: manifest
        ? {
            name: manifest.name,
            fileId: manifest.fileId,
            sha256: manifest.sha256,
            shortSha: shortSha(manifest.sha256),
            source: store.getCollection(manifest.collectionId)?.label ?? null,
          }
        : null,
      withdrawn: files
        .filter((file) => file.withdrawn)
        .map((file) => ({
          fileId: file.fileId,
          role: file.role,
          partId: file.partId,
          name: file.name,
          shortSha: shortSha(file.sha256),
          withdrawnAt: file.withdrawnAt,
          reason: file.withdrawnReason,
        })),
    },
    lastAttempt: attempts.at(-1) ? summariseAttempt(attempts.at(-1)) : null,
    attempts: attempts.map(summariseAttempt),
    display: display?.versionId
      ? {
          versionId: display.versionId,
          at: display.at,
          reason: display.reason,
          version: versionSummary(store, store.getVersion(display.versionId), display.versionId),
        }
      : { versionId: null, at: display?.at ?? null, reason: display?.reason ?? '尚未上线任何版本', version: null },
    latestVersion: versionSummary(store, latest, display?.versionId ?? null),
    versions: versions.map((version) => versionSummary(store, version, display?.versionId ?? null)),
    retiredVersions: versions
      .filter((version) => store.isRetired(version.versionId))
      .map((version) => versionSummary(store, version, display?.versionId ?? null)),
    vouchers: store
      .voucherList()
      .map((voucher) => ({
        ...voucher,
        stillValid: !store.isRetired(voucher.versionId),
        downloads: store
          .servedList()
          .filter((event) => event.voucherId === voucher.voucherId)
          .map((event) => ({ at: event.at, key: event.key, ok: event.ok, reason: event.reason })),
      }))
      .sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : -1)),
    displayHistory: store.displayHistory(),
  };
}
