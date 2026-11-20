import { DomainError } from './errors.js';
import {
  ALL_SLOT_KEYS,
  CONTENT_SLOTS,
  SLOT_BY_KEY,
  TOTAL_REQUIRED,
  parseManifest,
  percent,
  shortSha,
} from './domain.js';

export function latestByCapture(files) {
  return (
    [...files].sort((a, b) => {
      if (a.capturedAt !== b.capturedAt) return a.capturedAt < b.capturedAt ? 1 : -1;
      return a.fileId < b.fileId ? 1 : -1;
    })[0] ?? null
  );
}

export function latestLive(store, role, partId = undefined) {
  return latestByCapture(
    store
      .fileList()
      .filter((file) => !file.withdrawn && file.role === role)
      .filter((file) => partId === undefined || file.partId === partId),
  );
}

function slotLabel(slot) {
  return SLOT_BY_KEY.get(slot)?.label ?? slot;
}

function issue(code, slot, message, extra = {}) {
  return { code, slot, label: slotLabel(slot), message, ...extra };
}

function slotFiles(store, definition) {
  return store
    .fileList()
    .filter((file) => file.role === definition.role && file.partId === definition.partId);
}

/**
 * The assembly verdict. Reads only, never falls back by filename:
 *
 *  - with a valid manifest, every content slot must be backed by the *exact*
 *    sha256 the manifest pins, that capture must still be live, and it must be
 *    the newest live capture for that slot (otherwise a newer part would be
 *    silently replaced by an older one — the exact mix this demo forbids);
 *  - without a valid manifest, completeness is reported from capture presence
 *    so the page can show "parts are in, score + manifest are missing".
 *
 * Any problem blocks the set; there is no best-effort assembly.
 */
export function evaluateSet(store) {
  const missingSlots = [];
  const problems = [];
  const withdrawnEvidence = [];

  for (const file of store.fileList()) {
    if (!file.withdrawn) continue;
    if (!['score', 'part', 'manifest'].includes(file.role)) continue;
    withdrawnEvidence.push({
      fileId: file.fileId,
      slot: file.role === 'score' ? 'score' : file.role === 'manifest' ? 'manifest' : file.partId,
      name: file.name,
      sha256: file.sha256,
      shortSha: shortSha(file.sha256),
      withdrawnAt: file.withdrawnAt,
      reason: file.withdrawnReason,
    });
  }

  const manifestFile = latestLive(store, 'manifest');
  let manifest = null;
  if (!manifestFile) {
    missingSlots.push('manifest');
    problems.push(issue('missing-slot', 'manifest', '尚未采集到文件清单，无法判定一套是否齐全'));
  } else {
    let text = null;
    try {
      text = store.readContent(manifestFile.sha256).toString('utf8');
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      problems.push(
        issue('manifest-unreadable', 'manifest', `文件清单无法读取：${error.message}`, {
          fileId: manifestFile.fileId,
        }),
      );
      missingSlots.push('manifest');
    }
    if (text !== null) {
      const parsed = parseManifest(text);
      if (!parsed.ok) {
        problems.push(
          issue('manifest-invalid', 'manifest', parsed.errors.map((item) => item.message).join('；'), {
            fileId: manifestFile.fileId,
            errors: parsed.errors,
          }),
        );
        missingSlots.push('manifest');
      } else {
        manifest = {
          fileId: manifestFile.fileId,
          name: manifestFile.name,
          bytes: manifestFile.bytes,
          sha256: manifestFile.sha256,
          shortSha: shortSha(manifestFile.sha256),
          title: parsed.title,
          note: parsed.note,
          entriesBySlot: parsed.entriesBySlot,
          entryCount: Object.keys(parsed.entriesBySlot).length,
        };
      }
    }
  }

  const resolved = {};
  for (const definition of CONTENT_SLOTS) {
    const slot = definition.slot;
    if (manifest) {
      const reference = manifest.entriesBySlot[slot];
      if (!reference) {
        missingSlots.push(slot);
        problems.push(issue('manifest-omits-slot', slot, `文件清单缺少 ${definition.label} 的条目`));
        continue;
      }
      const candidates = slotFiles(store, definition).filter(
        (file) => file.sha256 === reference.sha256,
      );
      const exact = candidates.find((file) => !file.withdrawn) ?? null;
      if (!exact) {
        missingSlots.push(slot);
        const withdrawn = candidates.find((file) => file.withdrawn) ?? null;
        problems.push(
          issue(
            'reference-unavailable',
            slot,
            withdrawn
              ? `${definition.label}：清单固定的内容已撤回，拒绝在读取时混入旧声部`
              : `${definition.label}：清单固定的内容未采集到，拒绝按同名文件降级读取`,
            {
              expectedSha256: reference.sha256,
              expectedShortSha: shortSha(reference.sha256),
              referenceName: reference.name,
              withdrawnFileId: withdrawn?.fileId ?? null,
            },
          ),
        );
        continue;
      }
      const newest = latestLive(store, definition.role, definition.partId);
      if (newest && newest.sha256 !== reference.sha256) {
        missingSlots.push(slot);
        problems.push(
          issue(
            'stale-pin',
            slot,
            `${definition.label}：清单固定的是较早采集 ${shortSha(reference.sha256)}…，较新采集 ${shortSha(newest.sha256)}… 未纳入清单，拒绝混入旧声部`,
            {
              pinnedSha256: reference.sha256,
              latestSha256: newest.sha256,
              latestFileId: newest.fileId,
            },
          ),
        );
        continue;
      }
      if (reference.name !== exact.name) {
        missingSlots.push(slot);
        problems.push(
          issue(
            'name-mismatch',
            slot,
            `${definition.label}：清单文件名 ${reference.name} 与实际采集 ${exact.name} 不一致`,
            { expectedName: reference.name, actualName: exact.name, fileId: exact.fileId },
          ),
        );
        continue;
      }
      const verified = store.verifyContent(reference.sha256);
      if (!verified.ok) {
        missingSlots.push(slot);
        problems.push(
          issue('content-unverifiable', slot, `${definition.label}：${verified.message}`, {
            sha256: reference.sha256,
          }),
        );
        continue;
      }
      resolved[slot] = {
        slot,
        role: definition.role,
        partId: definition.partId,
        label: definition.label,
        shortLabel: definition.shortLabel,
        name: exact.name,
        fileId: exact.fileId,
        sha256: reference.sha256,
        bytes: verified.bytes,
        source: store.getCollection(exact.collectionId)?.label ?? null,
      };
      continue;
    }

    // No usable manifest: presence-only report, still never complete.
    const live = latestLive(store, definition.role, definition.partId);
    if (live) {
      resolved[slot] = {
        slot,
        role: definition.role,
        partId: definition.partId,
        label: definition.label,
        shortLabel: definition.shortLabel,
        name: live.name,
        fileId: live.fileId,
        sha256: live.sha256,
        bytes: live.bytes,
        source: store.getCollection(live.collectionId)?.label ?? null,
      };
    } else {
      missingSlots.push(slot);
      const withdrawn = slotFiles(store, definition)
        .filter((file) => file.withdrawn)
        .sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1))[0];
      problems.push(
        withdrawn
          ? issue('slot-withdrawn', slot, `${definition.label}：现有采集已撤回，等待补发`, {
              fileId: withdrawn.fileId,
              sha256: withdrawn.sha256,
              withdrawnReason: withdrawn.withdrawnReason,
            })
          : issue('missing-slot', slot, `尚未采集到 ${definition.label}`),
      );
    }
  }

  const uniqueMissing = [...new Set(missingSlots)];
  const complete = uniqueMissing.length === 0 && problems.length === 0;
  const satisfied = Math.max(0, ALL_SLOT_KEYS.length - uniqueMissing.length);
  return {
    complete,
    required: TOTAL_REQUIRED,
    satisfied,
    percent: percent(satisfied, TOTAL_REQUIRED),
    missingSlots: uniqueMissing,
    problems,
    withdrawnEvidence,
    manifest: manifest
      ? {
          fileId: manifest.fileId,
          name: manifest.name,
          bytes: manifest.bytes,
          sha256: manifest.sha256,
          shortSha: manifest.shortSha,
          title: manifest.title,
          note: manifest.note,
          entryCount: manifest.entryCount,
        }
      : null,
    resolved,
    fixedShaList: complete
      ? [...CONTENT_SLOTS.map((definition) => resolved[definition.slot].sha256), manifest.sha256]
      : [],
  };
}

export function slotsForVersion(store, evaluation) {
  const slots = {};
  for (const definition of CONTENT_SLOTS) {
    const entry = evaluation.resolved[definition.slot];
    slots[definition.slot] = {
      name: entry.name,
      sha256: entry.sha256,
      bytes: entry.bytes,
      fileId: entry.fileId,
      source: entry.source,
    };
  }
  slots.manifest = {
    name: evaluation.manifest.name,
    sha256: evaluation.manifest.sha256,
    bytes: evaluation.manifest.bytes,
    fileId: evaluation.manifest.fileId,
    source: store.getCollection(store.getFile(evaluation.manifest.fileId)?.collectionId)?.label ?? null,
  };
  return slots;
}

export function attemptRound(store) {
  return store.attemptList().length + 1;
}

export function makeAttempt(store, evaluation, { kind = 'assemble', note = null, at } = {}) {
  return {
    kind,
    attemptId: `a${store.state.counters.attempt + 1}`,
    round: attemptRound(store),
    at: at ?? store.nextAt(),
    complete: evaluation.complete,
    satisfied: evaluation.satisfied,
    required: evaluation.required,
    percent: evaluation.percent,
    missingSlots: evaluation.missingSlots,
    problems: evaluation.problems,
    note,
  };
}
