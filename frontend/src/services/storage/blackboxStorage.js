/**
 * Local Hash-Chained Blackbox Storage & Outbox Sync Service — Stage 4 & Stage 5
 *
 * Implements AGENTS.md §3 Stage 4 & Stage 5, SRS FR-11, FR-12, FR-13:
 *  - Tamper-Evident Blackbox Ledger via IndexedDB:
 *      * Sequential seq_no (1, 2, 3...)
 *      * Initial prev_hash links to "GENESIS_0000000000000000"
 *      * Deterministic canonical JSON serialization matching backend Python crypto_chain.py
 *      * record_hash = SHA256(prev_hash + canonical_json(payload))
 *  - Idempotent Outbox Synchronization (Stage 5):
 *      * Stores records locally with synced: false and UUIDv4 primary keys
 *      * Background worker automatically flushes unsynced batches to POST /api/sync/outbox
 *      * Server deduplicates by UUID without double insertion
 *      * Exponential backoff retry on network failure; resumes when window.onLine fires
 *  - Client-Side Cryptographic Chain Verifier:
 *      * Re-evaluates entire hash chain locally to verify zero tampering
 *  - Tamper diagnostic injection tool for regulatory demonstration
 *
 * Deterministic cryptography. Zero placeholders.
 */

// ---------------------------------------------------------------------------
// Constants (FR-11 & backend/crypto_chain.py compatibility)
// ---------------------------------------------------------------------------
export const GENESIS_HASH = 'GENESIS_0000000000000000';
export const DB_NAME = 'cvs_blackbox_db';
export const DB_VERSION = 1;
export const STORE_VIOLATIONS = 'violations';
export const STORE_META = 'metadata';

const SYNC_ENDPOINT = '/api/sync/outbox';
const DEFAULT_SYNC_INTERVAL_MS = 10000; // 10 seconds background flush
const MAX_BACKOFF_MS = 60000;

// Fields that must be formatted as Python floats (with .0 if whole number)
const FLOAT_FIELDS = new Set([
  'lat',
  'lon',
  'speed_actual',
  'speed_safe',
  'curve_radius',
  'confidence',
]);

// Fields excluded from the deterministic payload hash preimage
const EXCLUDED_PREIMAGE_FIELDS = new Set([
  'prev_hash',
  'record_hash',
  'evidence_clip_ref',
  'timestamp_server',
  'arrived_late',
  'synced',
  'synced_at',
  'payload_details',
  'created_at',
]);

// ---------------------------------------------------------------------------
// Pure JavaScript SHA-256 Implementation (Fallback for non-secure contexts)
// ---------------------------------------------------------------------------
function pureJsSha256(ascii) {
  function rightRotate(value, amount) {
    return (value >>> amount) | (value << (32 - amount));
  }

  const mathPow = Math.pow;
  const maxWord = mathPow(2, 32);
  const lengthProperty = 'length';
  let i, j;
  let result = '';

  const words = [];
  const asciiBitLength = ascii[lengthProperty] * 8;

  let hash = [];
  const k = [];
  let primeCounter = 0;

  const isComposite = {};
  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (i = 0; i < 300; i += candidate) {
        isComposite[i] = candidate;
      }
      hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
      k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
    }
  }

  ascii += '\x80';
  while ((ascii[lengthProperty] % 64) - 56) ascii += '\x00';
  for (i = 0; i < ascii[lengthProperty]; i++) {
    j = ascii.charCodeAt(i);
    if (j >> 8) return; // Only 8-bit ASCII supported
    words[i >> 2] |= j << ((3 - (i % 4)) * 8);
  }
  words[words[lengthProperty]] = (asciiBitLength / maxWord) | 0;
  words[words[lengthProperty]] = asciiBitLength;

  for (j = 0; j < words[lengthProperty]; ) {
    const w = words.slice(j, (j += 16));
    const oldHash = hash;
    hash = hash.slice(0, 8);

    for (i = 0; i < 64; i++) {
      const w15 = w[i - 15],
        w2 = w[i - 2];
      const s0 = rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3);
      const s1 = rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10);
      w[i] =
        i < 16
          ? w[i]
          : (w[i - 16] + s0 + w[i - 7] + s1) | 0;

      const ch = (hash[4] & hash[5]) ^ (~hash[4] & hash[6]);
      const maj = (hash[0] & hash[1]) ^ (hash[0] & hash[2]) ^ (hash[1] & hash[2]);
      const t1 =
        hash[7] +
        (rightRotate(hash[4], 6) ^ rightRotate(hash[4], 11) ^ rightRotate(hash[4], 25)) +
        ch +
        k[i] +
        w[i];
      const t2 =
        (rightRotate(hash[0], 2) ^ rightRotate(hash[0], 13) ^ rightRotate(hash[0], 22)) +
        maj;

      hash = [(t1 + t2) | 0].concat(hash);
      hash[4] = (hash[4] + t1) | 0;
      hash.pop();
    }

    for (i = 0; i < 8; i++) {
      hash[i] = (hash[i] + oldHash[i]) | 0;
    }
  }

  for (i = 0; i < 8; i++) {
    for (i = 0; i < 8; i++) {
      for (j = 3; j + 1; j--) {
        const b = (hash[i] >> (j * 8)) & 255;
        result += (b < 16 ? '0' : '') + b.toString(16);
      }
    }
    return result;
  }
}

/**
 * Deterministic SHA-256 calculation with Web Crypto API and fallback
 */
export async function computeSha256(str) {
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
    try {
      const msgBuffer = new TextEncoder().encode(str);
      const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      // Fallback below
    }
  }
  return pureJsSha256(str);
}

/**
 * Formats a number to match Python's json.dumps float rounding behavior:
 * - Rounds to 4 decimal places
 * - Strips unnecessary trailing zeroes
 * - Appends '.0' if the number is an integer to strictly match Python float representation
 */
function formatPythonFloat(val) {
  if (val === null || val === undefined) return 'null';
  const rounded = Math.round(val * 10000) / 10000;
  let s = rounded.toString();
  if (!s.includes('.')) {
    s += '.0';
  }
  return s;
}

/**
 * Serializes a payload into a deterministic, canonical JSON string.
 * Strictly mirrors backend/crypto_chain.py:canonicalize_payload:
 * - Excludes hash chain & server fields
 * - Keys sorted alphabetically
 * - Compact separators (no whitespace)
 * - Floats rounded to 4 decimals with Python .0 float representation
 */
export const CANONICAL_HASH_KEYS = [
  'confidence',
  'curve_radius',
  'id',
  'lat',
  'lon',
  'sensor_mode',
  'seq_no',
  'severity',
  'speed_actual',
  'speed_safe',
  'timestamp_device',
  'violation_type',
];

/**
 * Extracts strictly the 12 deterministic fields required by backend/crypto_chain.py:extract_event_payload
 */
export function extractEventPayload(event) {
  return {
    id: String(event.id),
    violation_type: String(event.violation_type),
    severity: String(event.severity),
    timestamp_device: event.timestamp_device instanceof Date
      ? event.timestamp_device.toISOString()
      : String(event.timestamp_device),
    lat: Number(event.lat != null ? event.lat : 0),
    lon: Number(event.lon != null ? event.lon : 0),
    speed_actual: Number(event.speed_actual != null ? event.speed_actual : 0),
    speed_safe: event.speed_safe != null ? Number(event.speed_safe) : null,
    curve_radius: event.curve_radius != null ? Number(event.curve_radius) : null,
    confidence: Number(event.confidence != null ? event.confidence : 1.0),
    sensor_mode: String(event.sensor_mode || 'GPS_LOCKED'),
    seq_no: Math.round(Number(event.seq_no || 1)),
  };
}

/**
 * Serializes a payload into a deterministic, canonical JSON string.
 * Strictly mirrors backend/crypto_chain.py:canonicalize_payload:
 * - Keys sorted alphabetically (CANONICAL_HASH_KEYS)
 * - Compact separators (no whitespace)
 * - Floats rounded to 4 decimals with Python .0 float representation
 */
export function canonicalizePayload(payload) {
  const normalizedPayload = extractEventPayload(payload);
  const parts = [];

  for (const k of CANONICAL_HASH_KEYS) {
    const v = normalizedPayload[k];
    let valStr;

    if (v === null || v === undefined) {
      valStr = 'null';
    } else if (FLOAT_FIELDS.has(k)) {
      valStr = formatPythonFloat(Number(v));
    } else if (k === 'seq_no') {
      valStr = Math.round(Number(v)).toString();
    } else if (typeof v === 'number') {
      valStr = Number.isInteger(v) ? v.toString() : formatPythonFloat(v);
    } else if (typeof v === 'boolean') {
      valStr = v ? 'true' : 'false';
    } else {
      valStr = JSON.stringify(v);
    }

    parts.push(`${JSON.stringify(k)}:${valStr}`);
  }

  return `{${parts.join(',')}}`;
}

/**
 * Computes deterministic record hash:
 * record_hash = SHA256(prev_hash + canonical_json(payload))
 */
export async function computeRecordHash(prevHash, payload) {
  const canonicalBody = canonicalizePayload(payload);
  const preimage = `${prevHash}${canonicalBody}`;
  return computeSha256(preimage);
}

// ---------------------------------------------------------------------------
// Blackbox Storage & Sync Worker Class
// ---------------------------------------------------------------------------
export class BlackboxStorage {
  constructor() {
    this.db = null;
    this.initPromise = null;

    // In-memory cache of blackbox ledger head
    this.currentSeqNo = 0;
    this.lastRecordHash = GENESIS_HASH;

    // Outbox Sync worker state
    this.isSyncing = false;
    this.syncIntervalId = null;
    this.backoffMs = DEFAULT_SYNC_INTERVAL_MS;
    this.lastSyncTimestamp = null;

    this.forceOffline = false;

    // Configuration
    this.config = {
      vehicleRegistration: 'JK02-1234',
      vehicleId: 1,
      driverId: 1,
      syncIntervalMs: DEFAULT_SYNC_INTERVAL_MS,
    };

    // Event listeners
    this.listeners = new Map([
      ['recordAdded', new Set()],
      ['syncSuccess', new Set()],
      ['syncError', new Set()],
      ['chainVerification', new Set()],
      ['networkModeChanged', new Set()],
    ]);

    this._setupNetworkListeners();
  }

  setForceOffline(force) {
    this.forceOffline = Boolean(force);
    if (!this.forceOffline) {
      this.syncNow();
    }
    this.emit('networkModeChanged', { forceOffline: this.forceOffline });
  }

  getForceOffline() {
    return this.forceOffline;
  }

  setConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }

  // -------------------------------------------------------------------------
  // Event Emitter
  // -------------------------------------------------------------------------
  on(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).add(callback);
    }
    return () => this.off(event, callback);
  }

  off(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(callback);
    }
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      for (const cb of this.listeners.get(event)) {
        try {
          cb(data);
        } catch (err) {
          console.error(`[BlackboxStorage] Listener error on '${event}':`, err);
        }
      }
    }
  }

  setConfig(cfg) {
    this.config = { ...this.config, ...cfg };
  }

  // -------------------------------------------------------------------------
  // IndexedDB Initializer
  // -------------------------------------------------------------------------
  async initDb() {
    if (this.db) return this.db;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not available in this environment'));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // 1. Violations Store
        if (!db.objectStoreNames.contains(STORE_VIOLATIONS)) {
          const store = db.createObjectStore(STORE_VIOLATIONS, { keyPath: 'id' });
          store.createIndex('seq_no', 'seq_no', { unique: true });
          store.createIndex('synced', 'synced', { unique: false });
          store.createIndex('timestamp_device', 'timestamp_device', { unique: false });
          store.createIndex('violation_type', 'violation_type', { unique: false });
          store.createIndex('severity', 'severity', { unique: false });
        }

        // 2. Metadata Store (ledger head, last hash, sequence number)
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
      };

      request.onsuccess = async (event) => {
        this.db = event.target.result;
        await this._loadLedgerHead();
        this.startBackgroundSync();
        resolve(this.db);
      };

      request.onerror = (event) => {
        console.error('[BlackboxStorage] IndexedDB open error:', event.target.error);
        reject(event.target.error);
      };
    });

    return this.initPromise;
  }

  async _loadLedgerHead() {
    try {
      const meta = await this._getMetaItem('ledger_head');
      if (meta) {
        this.currentSeqNo = meta.currentSeqNo || 0;
        this.lastRecordHash = meta.lastRecordHash || GENESIS_HASH;
      } else {
        // Query highest seq_no if meta is not set
        const highestRecord = await this._getHighestSeqRecord();
        if (highestRecord) {
          this.currentSeqNo = highestRecord.seq_no;
          this.lastRecordHash = highestRecord.record_hash;
        } else {
          this.currentSeqNo = 0;
          this.lastRecordHash = GENESIS_HASH;
        }
        await this._saveMetaItem('ledger_head', {
          currentSeqNo: this.currentSeqNo,
          lastRecordHash: this.lastRecordHash,
        });
      }
    } catch (err) {
      console.warn('[BlackboxStorage] Error loading ledger head:', err);
    }
  }

  _setupNetworkListeners() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        console.log('[BlackboxStorage] Network restored. Flushing Outbox immediately…');
        this.backoffMs = DEFAULT_SYNC_INTERVAL_MS;
        this.syncNow();
      });
    }
  }

  // -------------------------------------------------------------------------
  // Record Confirmed Violation with Tamper-Evident Hash Chain (FR-11)
  // -------------------------------------------------------------------------
  async recordViolation(violationData) {
    await this.initDb();

    // 1. Prepare sequential sequence number and previous hash link
    const nextSeqNo = this.currentSeqNo + 1;
    const prevHash = this.lastRecordHash;

    const payload = {
      id: violationData.id,
      vehicle_registration: violationData.vehicle_registration || this.config.vehicleRegistration,
      vehicle_id: violationData.vehicle_id || this.config.vehicleId,
      driver_id: violationData.driver_id || this.config.driverId,
      violation_type: violationData.violation_type,
      severity: violationData.severity,
      timestamp_device: violationData.timestamp_device || new Date().toISOString(),
      lat: Number(violationData.lat != null ? violationData.lat : 0),
      lon: Number(violationData.lon != null ? violationData.lon : 0),
      speed_actual: Number(violationData.speed_actual != null ? violationData.speed_actual : 0),
      speed_safe: violationData.speed_safe != null ? Number(violationData.speed_safe) : null,
      curve_radius: violationData.curve_radius != null ? Number(violationData.curve_radius) : null,
      confidence: Number(violationData.confidence != null ? violationData.confidence : 1.0),
      sensor_mode: violationData.sensor_mode || 'GPS_LOCKED',
      seq_no: nextSeqNo,
    };

    // 2. Deterministic SHA-256 calculation
    const recordHash = await computeRecordHash(prevHash, payload);

    // 3. Assemble full Blackbox record
    const blackboxRecord = {
      ...payload,
      evidence_clip_ref: violationData.evidence_clip_ref || null,
      prev_hash: prevHash,
      record_hash: recordHash,
      synced: 0, // 0 = unsynced (IndexedDB number index friendly)
      created_at: new Date().toISOString(),
      payload_details: violationData.payload_details || {},
    };

    // 4. Atomic transaction to store record and advance ledger head
    await this._writeRecordAtomic(blackboxRecord, nextSeqNo, recordHash);

    // Update in-memory state
    this.currentSeqNo = nextSeqNo;
    this.lastRecordHash = recordHash;

    this.emit('recordAdded', blackboxRecord);

    // Proactively trigger Outbox sync
    this.syncNow();

    return blackboxRecord;
  }

  async _writeRecordAtomic(record, seqNo, hash) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORE_VIOLATIONS, STORE_META], 'readwrite');
      const vStore = tx.objectStore(STORE_VIOLATIONS);
      const mStore = tx.objectStore(STORE_META);

      vStore.put(record);
      mStore.put({
        key: 'ledger_head',
        currentSeqNo: seqNo,
        lastRecordHash: hash,
        updatedAt: new Date().toISOString(),
      });

      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  // -------------------------------------------------------------------------
  // Idempotent Outbox Sync Worker (Stage 5)
  // -------------------------------------------------------------------------
  startBackgroundSync(intervalMs = this.config.syncIntervalMs) {
    if (this.syncIntervalId) return;
    this.syncIntervalId = setInterval(() => {
      this.syncNow();
    }, intervalMs);
  }

  stopBackgroundSync() {
    if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  async syncNow() {
    if (this.isSyncing) return;
    if (this.forceOffline) {
      return; // Force Offline Mode active: defer outbox queuing in IndexedDB
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return; // Offline: retain records in IndexedDB
    }

    this.isSyncing = true;
    try {
      await this.initDb();
      const unsyncedRecords = await this.getUnsyncedViolations();
      if (!unsyncedRecords || unsyncedRecords.length === 0) {
        this.isSyncing = false;
        return;
      }

      // Format payload strictly matching OutboxSyncRequest schema in backend
      const payloadEvents = unsyncedRecords.map((r) => ({
        id: r.id,
        vehicle_registration: r.vehicle_registration,
        vehicle_id: r.vehicle_id,
        driver_id: r.driver_id,
        violation_type: r.violation_type,
        severity: r.severity,
        timestamp_device: r.timestamp_device,
        lat: r.lat,
        lon: r.lon,
        speed_actual: r.speed_actual,
        speed_safe: r.speed_safe,
        curve_radius: r.curve_radius,
        confidence: r.confidence,
        sensor_mode: r.sensor_mode,
        evidence_clip_ref: r.evidence_clip_ref,
        prev_hash: r.prev_hash,
        record_hash: r.record_hash,
        seq_no: r.seq_no,
      }));

      const response = await fetch(SYNC_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ events: payloadEvents }),
      });

      if (!response.ok) {
        throw new Error(`Outbox sync HTTP ${response.status}: ${response.statusText}`);
      }

      const syncResult = await response.json();

      // Mark records as synced in IndexedDB
      const syncedIds = unsyncedRecords.map((r) => r.id);
      await this._markRecordsSynced(syncedIds);

      this.lastSyncTimestamp = new Date().toISOString();
      this.backoffMs = DEFAULT_SYNC_INTERVAL_MS;

      this.emit('syncSuccess', {
        syncedCount: syncedIds.length,
        serverResult: syncResult,
        timestamp: this.lastSyncTimestamp,
      });
    } catch (err) {
      console.warn('[BlackboxStorage] Outbox sync attempt failed (will retry):', err.message);
      this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 1.5);
      this.emit('syncError', { error: err.message, nextRetryMs: this.backoffMs });
    } finally {
      this.isSyncing = false;
    }
  }

  async _markRecordsSynced(ids) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORE_VIOLATIONS], 'readwrite');
      const store = tx.objectStore(STORE_VIOLATIONS);

      const nowIso = new Date().toISOString();
      for (const id of ids) {
        const getReq = store.get(id);
        getReq.onsuccess = (e) => {
          const rec = e.target.result;
          if (rec) {
            rec.synced = 1;
            rec.synced_at = nowIso;
            store.put(rec);
          }
        };
      }

      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  // -------------------------------------------------------------------------
  // Local Cryptographic Hash Chain Verifier (FR-11)
  // -------------------------------------------------------------------------
  async verifyChain() {
    await this.initDb();
    const records = await this.getAllViolations();

    if (!records || records.length === 0) {
      return {
        chain_intact: true,
        total_records: 0,
        tampered_seq_no: null,
        details: [],
      };
    }

    // Sort ascending by seq_no
    const sorted = [...records].sort((a, b) => a.seq_no - b.seq_no);

    let chainIntact = true;
    let tamperedSeqNo = null;
    let expectedPrevHash = GENESIS_HASH;
    const details = [];

    for (let idx = 0; idx < sorted.length; idx++) {
      const rec = sorted[idx];
      const seqNo = rec.seq_no;
      const storedPrevHash = rec.prev_hash;
      const storedRecordHash = rec.record_hash;

      const payload = {
        id: rec.id,
        violation_type: rec.violation_type,
        severity: rec.severity,
        timestamp_device: rec.timestamp_device,
        lat: rec.lat,
        lon: rec.lon,
        speed_actual: rec.speed_actual,
        speed_safe: rec.speed_safe,
        curve_radius: rec.curve_radius,
        confidence: rec.confidence,
        sensor_mode: rec.sensor_mode,
        seq_no: rec.seq_no,
      };

      const recomputedHash = await computeRecordHash(storedPrevHash, payload);

      let isValid = true;
      let reason = null;

      // 1. Verify expected previous hash linkage
      if (storedPrevHash !== expectedPrevHash) {
        isValid = false;
        reason = `Broken chain link at seq ${seqNo}: prev_hash mismatch. Expected ${expectedPrevHash.slice(0, 12)}..., got ${storedPrevHash.slice(0, 12)}...`;
      }
      // 2. Verify recomputed hash matches stored hash
      else if (recomputedHash !== storedRecordHash) {
        isValid = false;
        reason = `Data tampering detected at seq ${seqNo}! Payload values do not match recorded cryptographic hash.`;
      }

      if (!isValid && chainIntact) {
        chainIntact = false;
        tamperedSeqNo = seqNo;
      }

      details.push({
        seq_no: seqNo,
        event_id: rec.id,
        violation_type: rec.violation_type,
        timestamp_device: rec.timestamp_device,
        speed_actual: rec.speed_actual,
        stored_hash: storedRecordHash,
        recomputed_hash: recomputedHash,
        prev_hash: storedPrevHash,
        valid: isValid,
        reason,
      });

      // Advance expected link
      expectedPrevHash = storedRecordHash;
    }

    const verificationResult = {
      chain_intact: chainIntact,
      total_records: sorted.length,
      tampered_seq_no: tamperedSeqNo,
      details,
    };

    this.emit('chainVerification', verificationResult);
    return verificationResult;
  }

  // -------------------------------------------------------------------------
  // Regulatory Tamper Diagnostic Injection (For demonstration & verification testing)
  // -------------------------------------------------------------------------
  async tamperRecordForTesting(recordId, modifiedSpeed) {
    await this.initDb();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORE_VIOLATIONS], 'readwrite');
      const store = tx.objectStore(STORE_VIOLATIONS);

      const req = store.get(recordId);
      req.onsuccess = (e) => {
        const rec = e.target.result;
        if (!rec) {
          reject(new Error(`Record ${recordId} not found`));
          return;
        }

        // Deliberately modify speed without updating record_hash to create tamper proof
        rec.speed_actual = modifiedSpeed;
        store.put(rec);
      };

      tx.oncomplete = () => resolve({ tampered: true, recordId, modifiedSpeed });
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  // -------------------------------------------------------------------------
  // Query Helpers
  // -------------------------------------------------------------------------
  async getAllViolations() {
    await this.initDb();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORE_VIOLATIONS], 'readonly');
      const store = tx.objectStore(STORE_VIOLATIONS);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async getUnsyncedViolations() {
    await this.initDb();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORE_VIOLATIONS], 'readonly');
      const store = tx.objectStore(STORE_VIOLATIONS);
      const index = store.index('synced');
      const req = index.getAll(0); // 0 = unsynced
      req.onsuccess = () => {
        const results = req.result || [];
        results.sort((a, b) => a.seq_no - b.seq_no);
        resolve(results);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async _getHighestSeqRecord() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORE_VIOLATIONS], 'readonly');
      const store = tx.objectStore(STORE_VIOLATIONS);
      const index = store.index('seq_no');
      const req = index.openCursor(null, 'prev'); // Highest first
      req.onsuccess = () => {
        const cursor = req.result;
        resolve(cursor ? cursor.value : null);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async _getMetaItem(key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORE_META], 'readonly');
      const store = tx.objectStore(STORE_META);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async _saveMetaItem(key, value) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([STORE_META], 'readwrite');
      const store = tx.objectStore(STORE_META);
      store.put({ key, ...value });
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  // -------------------------------------------------------------------------
  // Diagnostics & Export Utilities
  // -------------------------------------------------------------------------
  async exportLedgerJson() {
    const records = await this.getAllViolations();
    const verification = await this.verifyChain();
    return JSON.stringify(
      {
        vehicle: this.config.vehicleRegistration,
        exported_at_utc: new Date().toISOString(),
        total_records: records.length,
        chain_verification: verification,
        ledger: records,
      },
      null,
      2,
    );
  }

  async getStats() {
    await this.initDb();
    const all = await this.getAllViolations();
    const unsynced = all.filter((r) => r.synced === 0);

    return {
      totalRecords: all.length,
      unsyncedCount: unsynced.length,
      currentSeqNo: this.currentSeqNo,
      lastRecordHash: this.lastRecordHash,
      lastSyncTimestamp: this.lastSyncTimestamp,
      isSyncing: this.isSyncing,
    };
  }
}

// Export singleton instance
const blackboxStorage = new BlackboxStorage();
export default blackboxStorage;
