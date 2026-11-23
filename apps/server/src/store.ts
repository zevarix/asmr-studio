import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { layerAssetIds, parseScene, parseAssetRecord, parseCapturedMix, sceneLayerCount, SceneValidationError, type AssetRecord, type CapturedMix, type MixScene, type Scene } from '@asmr-studio/contracts';
import { MissingAsset, NotFound, RevisionConflict, StudioError } from './errors.js';
export { MissingAsset, RevisionConflict } from './errors.js';

export interface BlobRecord { bytes: number; mime: string; extension: string }
export interface AssetRepository {
  insert(asset: AssetRecord, blob: BlobRecord): void;
  get(id: string): AssetRecord | null;
  list(): AssetRecord[];
  storage(id: string): BlobRecord | null;
}
export interface SceneStore {
  list(): Array<{id:string; title:string; revision:number; durationSeconds:number|null; layerCount:number; kind:'mix'|'transition'}>;
  create(scene: Scene): Scene;
  get(id: string): Scene | null;
  save(scene: Scene, expectedRevision: number): Scene;
  capture(id: string, expectedRevision: number): CapturedMix;
}
export interface StudioStore { scenes: SceneStore; assets: AssetRepository; close(): void }
interface AssetRow {
  id: string; sha256: string; display_name: string; roles_json: string;
  duration_seconds: number; sample_rate: number; channels: number; format: string;
  provenance_kind: string; source: string | null; private_use: string; redistribution: string;
}
function assetFromRow(row: AssetRow): AssetRecord {
  return parseAssetRecord({
    id: row.id, sha256: row.sha256, displayName: row.display_name, roles: JSON.parse(row.roles_json),
    durationSeconds: row.duration_seconds, sampleRate: row.sample_rate, channels: row.channels, format: row.format,
    provenance: { kind: row.provenance_kind, source: row.source },
    rights: { privateUse: row.private_use, redistribution: row.redistribution },
  });
}

export function openStore(path: string): StudioStore {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    const version = db.pragma('user_version', { simple: true });
    if (version !== 0 && version !== 1 && version !== 2) throw new Error('Unsupported database version');
    if (version !== 2) db.transaction(() => {
      // A second process may have completed the upgrade while this writer waited.
      const currentVersion = db.pragma('user_version', {simple:true});
      if (currentVersion === 2) return;
      if (currentVersion !== 0 && currentVersion !== 1) throw new Error('Unsupported database version');
      if (currentVersion === 0) db.exec(readFileSync(new URL('./migrations/001-initial.sql', import.meta.url), 'utf8'));
      db.exec(readFileSync(new URL('./migrations/002-captured-mixes.sql', import.meta.url), 'utf8'));
    }).immediate();
    db.pragma('journal_mode = WAL');
  } catch (error) { db.close(); throw error; }

  const assetQuery = db.prepare<[string], AssetRow>('SELECT * FROM assets WHERE id = ?');
  const listQuery = db.prepare<[], AssetRow>('SELECT * FROM assets ORDER BY rowid');
  const storageQuery = db.prepare<[string], BlobRecord>('SELECT b.bytes, b.mime, b.extension FROM blobs b JOIN assets a USING (sha256) WHERE a.id = ?');
  const assetInsert = db.prepare(`INSERT INTO assets
    (id, sha256, display_name, roles_json, duration_seconds, sample_rate, channels, format, provenance_kind, source, private_use, redistribution)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const assets: AssetRepository = {
    insert(asset, blob) {
      const validated = parseAssetRecord(asset);
      if (!Number.isSafeInteger(blob.bytes) || blob.bytes <= 0 || !/^[a-z0-9]+$/.test(blob.extension) || !/^audio\/[a-z0-9.+-]+$/.test(blob.mime)) {
        throw new SceneValidationError('Invalid stored audio metadata');
      }
      db.transaction(() => {
        db.prepare('INSERT INTO blobs (sha256, bytes, mime, extension) VALUES (?, ?, ?, ?) ON CONFLICT (sha256) DO NOTHING')
          .run(validated.sha256, blob.bytes, blob.mime, blob.extension);
        const previous = db.prepare<[string], BlobRecord>('SELECT bytes, mime, extension FROM blobs WHERE sha256 = ?').get(validated.sha256);
        if (previous?.bytes !== blob.bytes || previous.mime !== blob.mime || previous.extension !== blob.extension) {
          throw new StudioError('BLOB_CONFLICT', 'Stored content metadata conflicts with this import', 409);
        }
        assetInsert.run(validated.id, validated.sha256, validated.displayName, JSON.stringify(validated.roles),
          validated.durationSeconds, validated.sampleRate, validated.channels, validated.format,
          validated.provenance.kind, validated.provenance.source, validated.rights.privateUse, validated.rights.redistribution);
      }).immediate();
    },
    get(id) { const row = assetQuery.get(id); return row ? assetFromRow(row) : null; },
    list() { return listQuery.all().map(assetFromRow); },
    storage(id) { return storageQuery.get(id) ?? null; },
  };
  const sceneQuery = db.prepare<[string], {document:string}>('SELECT document FROM scenes WHERE id = ?');
  const captureQuery = db.prepare<[string], {document:string}>('SELECT document FROM captured_mixes WHERE id = ?');
  const getScene = (id: string): Scene | null => {
    const row = sceneQuery.get(id);
    return row ? parseScene(JSON.parse(row.document)) : null;
  };
  function validateMixReferences(scene: MixScene): void {
    for (const layer of scene.layers) {
      for (const id of layerAssetIds(layer)) {
        if (id !== layer.assetId && !assets.get(id)) throw new MissingAsset();
      }
      const asset = assets.get(layer.assetId);
      if (!asset) throw new MissingAsset();
      if (layer.loop && layer.loop.endSeconds > asset.durationSeconds) {
        throw new SceneValidationError('Loop extends beyond the selected asset');
      }
    }
  }
  function validateReferences(scene: Scene): void {
    if (!scene.transition) { validateMixReferences(scene); return; }
    for (const capture of [scene.transition.a, scene.transition.b]) {
      if (!capture) continue;
      const stored = captureQuery.get(capture.id);
      if (!stored || JSON.stringify(parseCapturedMix(JSON.parse(stored.document))) !== JSON.stringify(capture)) {
        throw new SceneValidationError('Captured mixes must match an accepted saved revision');
      }
    }
  }
  const scenes: SceneStore = {
    list() {
      return db.prepare<[], {document:string}>('SELECT document FROM scenes ORDER BY rowid DESC').all().map(row => {
        const scene = parseScene(JSON.parse(row.document));
        return {id:scene.id,title:scene.title,revision:scene.revision,durationSeconds:scene.durationSeconds,layerCount:sceneLayerCount(scene),kind:scene.transition?'transition' as const:'mix' as const};
      });
    },
    get: getScene,
    capture(id, expectedRevision) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new SceneValidationError('Invalid expected revision');
      return db.transaction(() => {
        const scene = getScene(id);
        if (!scene) throw new NotFound();
        if (scene.revision !== expectedRevision) throw new RevisionConflict(scene.revision);
        if (scene.transition) throw new SceneValidationError('Only a saved ordinary mix can be captured');
        validateMixReferences(scene);
        const records = [...new Set(scene.layers.flatMap(layerAssetIds))].map(assetId => {
          const asset = assets.get(assetId);
          if (!asset) throw new MissingAsset();
          return asset;
        });
        const capture = parseCapturedMix({id:randomUUID(),scene,assets:records});
        db.prepare('INSERT INTO captured_mixes (id, document) VALUES (?, ?)').run(capture.id, JSON.stringify(capture));
        return capture;
      }).immediate();
    },
    create(input) {
      const scene = parseScene(input);
      if (scene.revision !== 0) throw new SceneValidationError('New scenes must have revision zero');
      return db.transaction(() => {
        const previous = getScene(scene.id);
        if (previous) throw new RevisionConflict(previous.revision);
        validateReferences(scene);
        const created = { ...scene, revision: 1 };
        db.prepare('INSERT INTO scenes (id, revision, document) VALUES (?, ?, ?)').run(created.id, 1, JSON.stringify(created));
        return created;
      }).immediate();
    },
    save(input, expectedRevision) {
      const scene = parseScene(input);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || scene.revision !== expectedRevision) {
        throw new SceneValidationError('Invalid expected revision');
      }
      return db.transaction(() => {
        const current = getScene(scene.id);
        if (!current) throw new NotFound();
        if (current.revision !== expectedRevision) throw new RevisionConflict(current.revision);
        if (!!current.transition !== !!scene.transition) throw new SceneValidationError('Save a new arrangement instead of changing the kind of an existing session');
        validateReferences(scene);
        const saved = parseScene({ ...scene, revision: expectedRevision + 1 });
        const result = db.prepare('UPDATE scenes SET revision = ?, document = ? WHERE id = ? AND revision = ?')
          .run(saved.revision, JSON.stringify(saved), saved.id, expectedRevision);
        if (result.changes !== 1) throw new RevisionConflict(getScene(scene.id)?.revision ?? expectedRevision);
        return saved;
      }).immediate();
    },
  };
  return { scenes, assets, close() { if (db.open) db.close(); } };
}
