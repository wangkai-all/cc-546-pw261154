import { DomainError, invariant } from './errors.js';
import {
  PART_SLOTS,
  buildManifestText,
  requirePart,
  shortSha,
} from './domain.js';
import { latestLive } from './assembler.js';
import { sha256 } from './store.js';

export const SCENE = Object.freeze({
  title: '晨雾中的弦乐组曲',
  note: '虚构作品，仅用于本地演示。声部先发，总谱与文件清单随后。',
  sourceLabels: ['本地采集箱：快照 A', '本地采集箱：快照 B', '本地采集箱：快照 C'],
});

function partsSnapshot(store, overrides) {
  const overrideMap = new Map((overrides ?? []).map((entry) => [entry?.slot, entry]));
  return PART_SLOTS.map((definition) => {
    const live = latestLive(store, 'part', definition.partId);
    if (!live) {
      throw new DomainError('parts-incomplete', `缺少声部 ${definition.label}，无法生成文件清单`, 409);
    }
    const override = overrideMap.get(definition.slot);
    return {
      slot: definition.slot,
      role: 'part',
      partId: definition.partId,
      name: override?.name ?? live.name,
      sha256: override?.sha256 ?? live.sha256,
      bytes: override?.bytes ?? live.bytes,
    };
  });
}

/**
 * Collection process. It never judges completeness: it only turns bytes into
 * content-addressed captures. The same bytes always land on the same SHA-256,
 * so duplicate deliveries are stored once and recorded as separate captures.
 */
export function captureParts(store, payload = {}) {
  const inputs =
    Array.isArray(payload.parts) && payload.parts.length > 0
      ? payload.parts
      : PART_SLOTS.map((part) => ({
          partId: part.partId,
          content: `${part.label} — 第 1–48 小节，快照 A\n`,
        }));
  const seen = new Set();
  const files = [];
  for (const input of inputs) {
    const definition = requirePart(input?.partId);
    invariant(!seen.has(definition.partId), 'duplicate-part', `声部 ${definition.label} 在同一批中重复`, 400);
    seen.add(definition.partId);
    const content = String(input?.content ?? '');
    invariant(content.length > 0, 'empty-part', `声部 ${definition.label} 的内容为空`, 400);
    files.push({
      role: 'part',
      partId: definition.partId,
      name: input?.name || `${definition.partId}.part.txt`,
      content,
    });
  }
  invariant(files.length === PART_SLOTS.length, 'parts-incomplete', '声部采集批必须覆盖全部五个声部', 400);
  const result = store.collect({ label: payload.label || '采集批：五个声部（快照 A）', files });
  return {
    ok: true,
    mode: 'parts',
    collection: result.collection,
    files: result.files,
    captured: result.files.length,
    note: '声部已按内容入库；本批不含总谱与文件清单，因此这一套尚不齐全',
  };
}

/** The manifest is generated from the exact live part captures, not by name. */
export function captureScore(store, payload = {}) {
  const scoreText = String(payload?.score?.content ?? 'Full Score — 总谱（快照 B，晚于声部送达）\n');
  invariant(scoreText.length > 0, 'empty-score', '总谱内容为空', 400);
  const scoreName = payload?.score?.name || 'score.full.txt';
  const scoreBytes = Buffer.byteLength(scoreText, 'utf8');
  const entries = [
    {
      slot: 'score',
      role: 'score',
      partId: null,
      name: scoreName,
      sha256: sha256(Buffer.from(scoreText, 'utf8')),
      bytes: scoreBytes,
    },
    ...partsSnapshot(store, payload.manifestEntries),
  ];
  const manifestText = buildManifestText({
    title: payload.title || SCENE.title,
    note: payload.note || SCENE.note,
    entries,
  });
  const result = store.collect({
    label: payload.label || '采集批：总谱 + 文件清单（快照 B）',
    files: [
      { role: 'score', partId: null, name: scoreName, content: scoreText },
      { role: 'manifest', partId: null, name: payload.manifestName || 'manifest.json', content: manifestText },
    ],
  });
  return {
    ok: true,
    mode: 'score',
    collection: result.collection,
    files: result.files,
    captured: result.files.length,
    manifestEntries: entries,
    note: '总谱与文件清单已入库；清单为每个声部固定了 sha256',
  };
}

export function captureSuite(store, payload = {}) {
  const parts = captureParts(store, payload.parts ? { parts: payload.parts, label: payload.partsLabel } : {});
  const score = captureScore(store, {
    score: payload.score,
    title: payload.title,
    note: payload.note,
    label: payload.scoreLabel,
    manifestEntries: payload.manifestEntries,
    manifestName: payload.manifestName,
  });
  return { ok: true, mode: 'suite', parts, score, captured: parts.captured + score.captured };
}

/**
 * Withdrawal is recorded, never erased: the capture, its hash, time and reason
 * all stay in the journal so the evidence survives.
 */
export function withdraw(store, payload = {}) {
  let file;
  if (payload.kind === 'score') {
    const score = latestLive(store, 'score');
    invariant(score, 'no-score', '当前没有可撤回的总谱', 409);
    file = store.withdrawFile(score.fileId, payload.reason || '总谱发现排版错误，先撤回').file;
  } else if (payload.kind === 'manifest') {
    const manifest = latestLive(store, 'manifest');
    invariant(manifest, 'no-manifest', '当前没有可撤回的文件清单', 409);
    file = store.withdrawFile(manifest.fileId, payload.reason || '文件清单作废').file;
  } else if (payload.kind === 'part') {
    const definition = requirePart(payload.partId);
    const part = latestLive(store, 'part', definition.partId);
    invariant(part, 'no-part', `当前没有可撤回的声部 ${definition.label}`, 409);
    file = store.withdrawFile(part.fileId, payload.reason || `${definition.label} 撤回`).file;
  } else {
    throw new DomainError('invalid-withdraw-kind', '撤回类型必须是 score、manifest 或 part', 400);
  }
  return {
    ok: true,
    kind: payload.kind,
    file,
    evidence: {
      fileId: file.fileId,
      sha256: file.sha256,
      shortSha: shortSha(file.sha256),
      withdrawnAt: file.withdrawnAt,
      reason: file.withdrawnReason,
    },
  };
}
