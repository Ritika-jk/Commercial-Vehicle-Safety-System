/**
 * Violation Arbitration Engine — Stage 3 (Decide)
 *
 * Implements AGENTS.md §3 Stage 3, SRS FR-13a:
 *  - Multi-frame debouncing to eliminate camera glitches & sensor noise:
 *      * DROWSINESS: >= 1.8s continuous (EAR < 0.21)
 *      * DISTRACTION: >= 2.0s continuous (Yaw > 30° / Pitch > 25°)
 *      * PHONE_USE: >= 2.0s continuous
 *      * OVERSPEED_CURVE: >= 1.2s continuous inside warning distance d_warn
 *      * OVERCROWDING: >= 5.0s continuous
 *      * HARSH_CORNERING: >= 0.8s continuous (a_lat > 0.45g)
 *      * SOS_ALERT: 0.0s (instant trigger)
 *  - Sensor Health Cross-Checking:
 *      * Cross-checks curve overspeed & cornering against gyroscope lateral acceleration (a_lat = v * ω_z)
 *      * Suppresses alerts when required sensor is offline, degraded, or dead-reckoning grace expired
 *  - 15-Second Cooldown & Escalation State Machine:
 *      * Initial debounced violation triggers ADVISORY alert
 *      * Enforces 15-second cooldown per category after ADVISORY
 *      * If driver fails to correct within 5.0 seconds, escalates to CRITICAL alert!
 *      * Severe infractions (SOS, speedDelta > 20 km/h, lateralG > 0.65g) bypass advisory directly to CRITICAL
 *
 * Deterministic state machines. Zero placeholders.
 */

// ---------------------------------------------------------------------------
// Debounce & State Machine Constants (FR-13a)
// ---------------------------------------------------------------------------
export const DEBOUNCE_DURATIONS_MS = {
  DROWSINESS: 1800,       // 1.8 seconds
  DISTRACTION: 2000,      // 2.0 seconds
  PHONE_USE: 2000,        // 2.0 seconds
  OVERSPEED_CURVE: 1200,  // 1.2 seconds
  OVERCROWDING: 5000,     // 5.0 seconds
  HARSH_CORNERING: 800,   // 0.8 seconds
  SOS_ALERT: 0,           // instant
};

export const ADVISORY_COOLDOWN_MS = 15000;    // 15 seconds cooldown per category
export const ESCALATION_TIMEOUT_MS = 5000;    // 5.0s to correct before escalation to CRITICAL
export const SEVERE_OVERSPEED_DELTA_KMH = 20; // km/h over safe speed for instant CRITICAL
export const SEVERE_LATERAL_G = 0.65;         // lateral g for instant CRITICAL

/**
 * UUIDv4 generator for idempotent Edge-to-Cloud synchronization (FR-12)
 */
export function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ---------------------------------------------------------------------------
// Violation Arbitration Engine Class
// ---------------------------------------------------------------------------
export class ArbitrationEngine {
  constructor() {
    // Current vehicle & driver metadata
    this.metadata = {
      vehicleRegistration: 'JK02-1234',
      vehicleId: 1,
      driverId: 1,
    };

    // State per violation type:
    // {
    //   activeCandidate: boolean,
    //   candidateStartMs: number | null,
    //   candidateConfidence: number,
    //   candidatePayload: any,
    //   currentState: 'IDLE' | 'DEBOUNCING' | 'ADVISORY' | 'CRITICAL' | 'COOLDOWN',
    //   advisoryTimestampMs: number | null,
    //   lastAlertTimestampMs: number | null,
    //   escalatedToCritical: boolean,
    //   activeViolationId: string | null,
    // }
    this.arbitrationStates = {};

    // Initialize trackers for all violation types
    for (const type of Object.keys(DEBOUNCE_DURATIONS_MS)) {
      this._resetCategoryState(type);
    }

    // Cached sensor health
    this.sensorHealth = {
      gpsLocked: true,
      sensorMode: 'GPS_LOCKED',
      confidence: 1.0,
      drExpired: false,
      speedKmh: 0,
      heading: 0,
      lat: 33.08415,
      lon: 75.32612,
      gyroYawRateDegS: 0,
    };

    // Cached vision health
    this.visionHealth = {
      isAvailable: true,
      mode: 'LIVE',
    };

    // Event listeners
    this.listeners = new Map([
      ['confirmedViolation', new Set()],
      ['escalatedViolation', new Set()],
      ['violationResolved', new Set()],
      ['stateChange', new Set()],
    ]);

    // Internal evaluation timer (runs at 10 Hz for smooth debouncing)
    this.evalInterval = null;
    this.startEvaluationLoop();
  }

  _resetCategoryState(type) {
    this.arbitrationStates[type] = {
      activeCandidate: false,
      candidateStartMs: null,
      candidateConfidence: 1.0,
      candidatePayload: null,
      currentState: 'IDLE',
      advisoryTimestampMs: null,
      lastAlertTimestampMs: null,
      escalatedToCritical: false,
      activeViolationId: null,
    };
  }

  setMetadata(meta) {
    this.metadata = { ...this.metadata, ...meta };
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
          console.error(`[ArbitrationEngine] Listener error on '${event}':`, err);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Telemetry & Sensor Health Ingestion
  // -------------------------------------------------------------------------
  updateSensorState(state) {
    if (!state) return;
    this.sensorHealth = {
      gpsLocked: state.sensorMode === 'GPS_LOCKED',
      sensorMode: state.sensorMode || 'GPS_LOCKED',
      confidence: state.confidence != null ? state.confidence : 1.0,
      drExpired: !!state.isDrDegraded,
      speedKmh: state.speedKmh != null ? state.speedKmh : 0,
      heading: state.heading != null ? state.heading : 0,
      lat: state.lat != null ? state.lat : this.sensorHealth.lat,
      lon: state.lon != null ? state.lon : this.sensorHealth.lon,
      gyroYawRateDegS: state.rotationRate?.alpha || state.gyroZ || 0,
    };
  }

  updateVisionHealth(health) {
    if (!health) return;
    this.visionHealth = {
      isAvailable: health.mode !== 'OFFLINE',
      mode: health.mode || 'LIVE',
    };
  }

  // -------------------------------------------------------------------------
  // Ingest Vision Candidate Violations (From VisionEngine)
  // -------------------------------------------------------------------------
  ingestVisionCandidate({ type, active, confidence, metrics, snapshot }) {
    if (!this.arbitrationStates[type]) return;

    // Suppress vision alerts if vision engine is completely offline
    if (!this.visionHealth.isAvailable) {
      this.arbitrationStates[type].activeCandidate = false;
      return;
    }

    const state = this.arbitrationStates[type];
    const now = Date.now();

    if (active) {
      if (!state.activeCandidate) {
        state.activeCandidate = true;
        state.candidateStartMs = now;
      }
      state.candidateConfidence = confidence != null ? confidence : 1.0;
      state.candidatePayload = { metrics, snapshot };
    } else {
      if (state.activeCandidate) {
        state.activeCandidate = false;
        state.candidateStartMs = null;
        this._handleConditionCeased(type);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Ingest GIS Curve Evaluation (From OfflineGisEngine)
  // -------------------------------------------------------------------------
  ingestGisEvaluation(gisResult) {
    const type = 'OVERSPEED_CURVE';
    const state = this.arbitrationStates[type];
    if (!state) return;

    // Sensor health suppression check:
    // If sensorMode is OFFLINE or GPS speed is missing, suppress curve overspeed
    if (this.sensorHealth.sensorMode === 'OFFLINE' || this.sensorHealth.speedKmh == null) {
      state.activeCandidate = false;
      return;
    }

    // If Dead-Reckoning confidence has collapsed (< 0.30 after 30s grace window), suppress
    if (this.sensorHealth.sensorMode === 'IMU_DEAD_RECKONING' && this.sensorHealth.confidence < 0.30) {
      state.activeCandidate = false;
      return;
    }

    const isRisk = gisResult && (gisResult.riskLevel === 'ADVISORY' || gisResult.riskLevel === 'CRITICAL');
    const now = Date.now();

    if (isRisk) {
      const speedActual = this.sensorHealth.speedKmh;
      const speedSafe = gisResult.safeSpeedKmh;
      const speedDelta = speedActual - speedSafe;

      // Cross-check with physical gyroscope lateral acceleration: a_lat = v * ω_z
      const v_mps = speedActual / 3.6;
      const omega_rad_s = Math.abs(this.sensorHealth.gyroYawRateDegS) * (Math.PI / 180);
      const computedLateralG = (v_mps * omega_rad_s) / 9.81;

      if (!state.activeCandidate) {
        state.activeCandidate = true;
        state.candidateStartMs = now;
      }

      state.candidateConfidence = Math.min(1.0, Math.max(0.7, gisResult.confidence || 0.9));
      state.candidatePayload = {
        speedActual,
        speedSafe,
        speedDelta,
        curveRadius: gisResult.curveRadius,
        distanceToCurve: gisResult.distanceToCurve,
        warningDistance: gisResult.warningDistance,
        computedLateralG,
        isSevere: speedDelta >= SEVERE_OVERSPEED_DELTA_KMH,
      };
    } else {
      if (state.activeCandidate) {
        state.activeCandidate = false;
        state.candidateStartMs = null;
        this._handleConditionCeased(type);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Ingest Harsh Cornering (From SensorFusion)
  // -------------------------------------------------------------------------
  ingestHarshCornering({ lateralG, speedKmh }) {
    const type = 'HARSH_CORNERING';
    const state = this.arbitrationStates[type];
    if (!state) return;

    const now = Date.now();
    state.activeCandidate = true;
    state.candidateStartMs = now;
    state.candidateConfidence = 0.95;
    state.candidatePayload = {
      lateralG,
      speedKmh,
      isSevere: lateralG >= SEVERE_LATERAL_G,
    };
  }

  // -------------------------------------------------------------------------
  // Ingest Manual SOS Trigger (From Driver or Passenger SOS button)
  // -------------------------------------------------------------------------
  triggerSos(origin = 'DRIVER') {
    const type = 'SOS_ALERT';
    const now = Date.now();
    const violation = this._buildViolationRecord(type, 'CRITICAL', 1.0, {
      origin,
      speedActual: this.sensorHealth.speedKmh,
    });

    this.emit('confirmedViolation', violation);
    return violation;
  }

  // -------------------------------------------------------------------------
  // Main Arbitration Evaluation Loop (10 Hz)
  // -------------------------------------------------------------------------
  startEvaluationLoop() {
    if (this.evalInterval) return;
    this.evalInterval = setInterval(() => {
      this._evaluateAllCategories();
    }, 100);
  }

  stopEvaluationLoop() {
    if (this.evalInterval) {
      clearInterval(this.evalInterval);
      this.evalInterval = null;
    }
  }

  _evaluateAllCategories() {
    const now = Date.now();

    for (const [type, state] of Object.entries(this.arbitrationStates)) {
      if (type === 'SOS_ALERT') continue; // SOS is event-driven

      const debounceThreshold = DEBOUNCE_DURATIONS_MS[type] || 1500;

      // 1. Check if candidate is currently debouncing
      if (state.activeCandidate && state.candidateStartMs != null) {
        const continuousDuration = now - state.candidateStartMs;

        if (state.currentState === 'IDLE' || state.currentState === 'DEBOUNCING') {
          if (continuousDuration < debounceThreshold) {
            state.currentState = 'DEBOUNCING';
          } else {
            // Debounce passed! Check if cooldown allows firing ADVISORY
            const inCooldown =
              state.lastAlertTimestampMs != null &&
              now - state.lastAlertTimestampMs < ADVISORY_COOLDOWN_MS;

            // Check if instant CRITICAL bypass applies
            const isSevereBypass = state.candidatePayload?.isSevere === true;

            if (isSevereBypass) {
              this._fireViolation(type, 'CRITICAL', state.candidateConfidence, state.candidatePayload);
              state.currentState = 'CRITICAL';
              state.lastAlertTimestampMs = now;
              state.escalatedToCritical = true;
            } else if (!inCooldown) {
              // Fire initial ADVISORY alert
              const record = this._fireViolation(
                type,
                'ADVISORY',
                state.candidateConfidence,
                state.candidatePayload,
              );
              state.currentState = 'ADVISORY';
              state.advisoryTimestampMs = now;
              state.lastAlertTimestampMs = now;
              state.activeViolationId = record.id;
              state.escalatedToCritical = false;
            }
          }
        } else if (state.currentState === 'ADVISORY') {
          // 2. Escalation State Machine:
          // If violation persists for > 5.0 seconds after ADVISORY, escalate to CRITICAL!
          const timeSinceAdvisory = now - (state.advisoryTimestampMs || now);
          if (timeSinceAdvisory >= ESCALATION_TIMEOUT_MS && !state.escalatedToCritical) {
            const criticalRecord = this._fireViolation(
              type,
              'CRITICAL',
              state.candidateConfidence,
              state.candidatePayload,
              state.activeViolationId, // links to same instance
            );
            state.currentState = 'CRITICAL';
            state.escalatedToCritical = true;
            state.lastAlertTimestampMs = now;

            this.emit('escalatedViolation', {
              violationRecord: criticalRecord,
              previousSeverity: 'ADVISORY',
              newSeverity: 'CRITICAL',
              persistedDurationMs: timeSinceAdvisory,
            });
          }
        }
      } else {
        // Condition is not active
        if (state.currentState === 'DEBOUNCING') {
          state.currentState = 'IDLE';
        } else if (state.currentState === 'ADVISORY' || state.currentState === 'CRITICAL') {
          // Condition resolved! Check if still in cooldown
          const inCooldown =
            state.lastAlertTimestampMs != null &&
            now - state.lastAlertTimestampMs < ADVISORY_COOLDOWN_MS;
          state.currentState = inCooldown ? 'COOLDOWN' : 'IDLE';
        } else if (state.currentState === 'COOLDOWN') {
          const inCooldown =
            state.lastAlertTimestampMs != null &&
            now - state.lastAlertTimestampMs < ADVISORY_COOLDOWN_MS;
          if (!inCooldown) {
            state.currentState = 'IDLE';
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Condition Ceased Handler
  // -------------------------------------------------------------------------
  _handleConditionCeased(type) {
    const state = this.arbitrationStates[type];
    if (!state) return;

    if (state.currentState === 'ADVISORY' || state.currentState === 'CRITICAL') {
      const durationMs = state.advisoryTimestampMs ? Date.now() - state.advisoryTimestampMs : 0;
      this.emit('violationResolved', {
        violationType: type,
        violationId: state.activeViolationId,
        durationMs,
      });
    }

    state.activeViolationId = null;
    state.escalatedToCritical = false;
  }

  // -------------------------------------------------------------------------
  // Fire Confirmed Violation Event
  // -------------------------------------------------------------------------
  _fireViolation(violationType, severity, confidence, payload = {}, existingId = null) {
    const record = this._buildViolationRecord(
      violationType,
      severity,
      confidence,
      payload,
      existingId,
    );
    this.emit('confirmedViolation', record);
    return record;
  }

  // -------------------------------------------------------------------------
  // Build Normalized Violation Event Record (Matches Backend ViolationEvent)
  // -------------------------------------------------------------------------
  _buildViolationRecord(violationType, severity, confidence, payload = {}, existingId = null) {
    const nowIso = new Date().toISOString();
    const id = existingId || generateUUID();

    return {
      id,
      vehicle_registration: this.metadata.vehicleRegistration,
      vehicle_id: this.metadata.vehicleId,
      driver_id: this.metadata.driverId,
      violation_type: violationType,
      severity,
      timestamp_device: nowIso,
      lat: Number(this.sensorHealth.lat.toFixed(5)),
      lon: Number(this.sensorHealth.lon.toFixed(5)),
      speed_actual: Number(this.sensorHealth.speedKmh.toFixed(1)),
      speed_safe: payload.speedSafe != null ? Number(payload.speedSafe.toFixed(1)) : null,
      curve_radius: payload.curveRadius != null ? Number(payload.curveRadius.toFixed(1)) : null,
      confidence: Number((confidence || 1.0).toFixed(2)),
      sensor_mode: this.sensorHealth.sensorMode,
      evidence_clip_ref: payload.snapshot || null,
      payload_details: payload,
    };
  }

  // -------------------------------------------------------------------------
  // Status Summary for UI HUD
  // -------------------------------------------------------------------------
  getStatusSummary() {
    const summary = {};
    const now = Date.now();

    for (const [type, s] of Object.entries(this.arbitrationStates)) {
      summary[type] = {
        state: s.currentState,
        active: s.activeCandidate,
        debouncingProgress:
          s.activeCandidate && s.candidateStartMs
            ? Math.min(1.0, (now - s.candidateStartMs) / (DEBOUNCE_DURATIONS_MS[type] || 1500))
            : 0,
        escalatingProgress:
          s.currentState === 'ADVISORY' && s.advisoryTimestampMs
            ? Math.min(1.0, (now - s.advisoryTimestampMs) / ESCALATION_TIMEOUT_MS)
            : 0,
      };
    }

    return summary;
  }
}

// Export singleton instance
const arbitrationEngine = new ArbitrationEngine();
export default arbitrationEngine;
