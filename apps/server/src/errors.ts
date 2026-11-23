export class StudioError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) {
    super(message);
    this.name = 'StudioError';
  }
}
export class RevisionConflict extends StudioError {
  constructor(readonly currentRevision: number) {
    super('REVISION_CONFLICT', 'The saved scene has a newer revision', 409);
  }
}
export class MissingAsset extends StudioError {
  constructor() { super('MISSING_ASSET', 'One or more scene assets are unavailable', 422); }
}
export class NotFound extends StudioError {
  constructor() { super('NOT_FOUND', 'The requested resource was not found', 404); }
}
