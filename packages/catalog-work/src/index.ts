// The reading engine of 'catalog_device_work': what a desktop and a phone run
// to do the store reads the Global Catalog hands them (engine.ts).

export { CATALOG_WORK_READER, createWorkEngine, type WorkEngine, type WorkEngineDeps, type WorkEvent, type WorkPhase, type WorkRowPatch, type WorkRun, type WorkVisit } from './engine.js';
export { CALL_TIMEOUT_MS, defaultSleep, STORE_GAP_MS, WorkAbortedError, WorkDeviceNotReadyError, type ClassifyFailure, type FailureVerdict, type Sleep } from './lanes.js';
export type { Candidate, FactHit, FactQuery, WorkReaders } from './readers.js';
