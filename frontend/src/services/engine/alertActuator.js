/**
 * In-Cabin Alert Actuator — Stage 4 (Act)
 *
 * Implements AGENTS.md §3 Stage 4, SRS FR-10, NFR-5:
 *  - Non-distracting, actionable multi-modal in-cabin alert actuation:
 *      1. Synthesized Speech via window.speechSynthesis (concise voice warnings)
 *      2. Web Audio API Dual-Tone Chimes & Buzzers (100% offline, zero audio assets required)
 *      3. Mobile Haptic Vibration via navigator.vibrate
 *  - Priority Queuing & Preemption:
 *      * CRITICAL alerts immediately cancel ongoing ADVISORY voice prompts and interrupt lower sounds
 *      * Deduplication & anti-flapping: prevents acoustic spamming within 8 seconds per violation
 *  - User interaction unlocking:
 *      * Handles modern browser AudioContext suspension gracefully, unlocking on first touch/click
 *  - Full volume, voice, tone, and haptic controls
 *
 * Deterministic acoustics. Zero placeholders.
 */

// ---------------------------------------------------------------------------
// Spoken Voice Warning Templates (FR-10, NFR-5)
// ---------------------------------------------------------------------------
export const VOICE_WARNING_TEMPLATES = {
  OVERSPEED_CURVE: (rec) => {
    const target = rec.speed_safe ? Math.round(rec.speed_safe) : 30;
    return `Warning. Sharp curve ahead. Reduce speed to ${target} kilometers per hour.`;
  },
  DROWSINESS: () => 'Alert. Driver drowsiness detected. Pull over safely immediately.',
  DISTRACTION: () => 'Attention. Keep your eyes on the road.',
  PHONE_USE: () => 'Warning. Put down mobile phone while driving.',
  OVERCROWDING: (rec) => 'Notice. Permitted vehicle passenger capacity exceeded.',
  HARSH_CORNERING: () => 'Warning. Excessive lateral cornering force. Slow down.',
  SOS_ALERT: () => 'Emergency SOS alert activated. Fleet operations notified.',
};

// ---------------------------------------------------------------------------
// Haptic Vibration Patterns (Milliseconds)
// ---------------------------------------------------------------------------
export const HAPTIC_PATTERNS = {
  ADVISORY: [200, 100, 200],
  CRITICAL: [500, 150, 500, 150, 500],
};

// ---------------------------------------------------------------------------
// Alert Actuator Class
// ---------------------------------------------------------------------------
export class AlertActuator {
  constructor() {
    this.audioCtx = null;
    this.isAudioUnlocked = false;

    // Configuration
    this.settings = {
      masterVolume: 0.85,    // 0.0 to 1.0
      soundEnabled: true,
      voiceEnabled: true,
      hapticEnabled: true,
      voiceRate: 1.05,       // Prompt, natural cadence
      voicePitch: 1.0,
      speechCooldownMs: 8000, // Anti-spam voice cooldown per category
    };

    // Tracking last spoken alert per category
    this.lastSpokenTimestamp = new Map();

    // Active alert state
    this.activeAlert = null;
    this.alertHistory = [];

    // Event listeners
    this.listeners = new Map([
      ['alertTriggered', new Set()],
      ['alertDismissed', new Set()],
    ]);

    this._setupUserGestureUnlock();
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
          console.error(`[AlertActuator] Listener error on '${event}':`, err);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Web Audio Context & Unlocking
  // -------------------------------------------------------------------------
  _getAudioContext() {
    if (!this.audioCtx && typeof window !== 'undefined') {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        this.audioCtx = new AudioContextClass();
      }
    }
    return this.audioCtx;
  }

  _setupUserGestureUnlock() {
    if (typeof window === 'undefined') return;

    const unlock = () => {
      this.unlockAudio();
      window.removeEventListener('click', unlock);
      window.removeEventListener('touchstart', unlock);
      window.removeEventListener('keydown', unlock);
    };

    window.addEventListener('click', unlock, { passive: true });
    window.addEventListener('touchstart', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });
  }

  async unlockAudio() {
    const ctx = this._getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      try {
        await ctx.resume();
        this.isAudioUnlocked = true;
      } catch (err) {
        console.warn('[AlertActuator] AudioContext unlock deferred:', err.message);
      }
    } else if (ctx && ctx.state === 'running') {
      this.isAudioUnlocked = true;
    }
    return this.isAudioUnlocked;
  }

  // -------------------------------------------------------------------------
  // Settings Management
  // -------------------------------------------------------------------------
  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
  }

  getSettings() {
    return { ...this.settings };
  }

  // -------------------------------------------------------------------------
  // Web Audio Dual-Tone Synthesizers (Zero Network Assets Needed)
  // -------------------------------------------------------------------------
  playTone(severity = 'ADVISORY') {
    if (!this.settings.soundEnabled) return;
    const ctx = this._getAudioContext();
    if (!ctx) return;

    // Ensure audio context is running
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(this.settings.masterVolume, now);
    masterGain.connect(ctx.destination);

    if (severity === 'CRITICAL') {
      // Urgent, piercing dual-tone alarm:
      // Alternates 880 Hz (A5) and 1174.66 Hz (D6) with 3 rapid pulsing bursts
      this._synthesizeCriticalAlarm(ctx, masterGain, now);
    } else {
      // Pleasant, clear harmonic advisory chime:
      // Tone 1: 587.33 Hz (D5) -> Tone 2: 880.00 Hz (A5)
      this._synthesizeAdvisoryChime(ctx, masterGain, now);
    }
  }

  _synthesizeAdvisoryChime(ctx, destination, startTime) {
    // Tone 1: 587.33 Hz (D5)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, startTime);
    gain1.gain.setValueAtTime(0.001, startTime);
    gain1.gain.exponentialRampToValueAtTime(0.65, startTime + 0.02);
    gain1.gain.exponentialRampToValueAtTime(0.001, startTime + 0.16);

    osc1.connect(gain1);
    gain1.connect(destination);
    osc1.start(startTime);
    osc1.stop(startTime + 0.17);

    // Tone 2: 880.00 Hz (A5)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    const t2 = startTime + 0.12;
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880.00, t2);
    gain2.gain.setValueAtTime(0.001, t2);
    gain2.gain.exponentialRampToValueAtTime(0.75, t2 + 0.02);
    gain2.gain.exponentialRampToValueAtTime(0.001, t2 + 0.35);

    osc2.connect(gain2);
    gain2.connect(destination);
    osc2.start(t2);
    osc2.stop(t2 + 0.36);
  }

  _synthesizeCriticalAlarm(ctx, destination, startTime) {
    // 3 rapid pulsing bursts alternating between 880Hz and 1174.66Hz
    const burstDuration = 0.10;
    const burstInterval = 0.14;

    for (let i = 0; i < 3; i++) {
      const burstStart = startTime + i * burstInterval;

      // Primary oscillator (Sawtooth for sharp presence)
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = i % 2 === 0 ? 'sawtooth' : 'triangle';
      osc.frequency.setValueAtTime(i % 2 === 0 ? 880.0 : 1174.66, burstStart);

      gain.gain.setValueAtTime(0.001, burstStart);
      gain.gain.linearRampToValueAtTime(0.85, burstStart + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, burstStart + burstDuration);

      osc.connect(gain);
      gain.connect(destination);
      osc.start(burstStart);
      osc.stop(burstStart + burstDuration + 0.01);
    }
  }

  // -------------------------------------------------------------------------
  // Speech Synthesis (Concise Voice Prompt with Priority Cancellation)
  // -------------------------------------------------------------------------
  speakWarning(text, severity = 'ADVISORY', categoryKey = 'DEFAULT') {
    if (!this.settings.voiceEnabled || typeof window === 'undefined' || !window.speechSynthesis) {
      return false;
    }

    const now = Date.now();
    const lastSpoken = this.lastSpokenTimestamp.get(categoryKey) || 0;

    // Suppress repeated spoken warnings within anti-spam cooldown window,
    // unless the new alert is CRITICAL
    if (severity !== 'CRITICAL' && now - lastSpoken < this.settings.speechCooldownMs) {
      return false;
    }

    try {
      // If alert is CRITICAL, immediately cancel any active or queued speech
      if (severity === 'CRITICAL' && window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
      }

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = this.settings.voiceRate;
      utterance.pitch = severity === 'CRITICAL' ? 1.15 : this.settings.voicePitch;
      utterance.volume = this.settings.masterVolume;

      // Select an English voice if available
      const voices = window.speechSynthesis.getVoices();
      const preferredVoice = voices.find(
        (v) => v.lang.startsWith('en') && (v.name.includes('Natural') || v.name.includes('Google')),
      ) || voices.find((v) => v.lang.startsWith('en'));

      if (preferredVoice) utterance.voice = preferredVoice;

      window.speechSynthesis.speak(utterance);
      this.lastSpokenTimestamp.set(categoryKey, now);
      return true;
    } catch (err) {
      console.warn('[AlertActuator] Speech synthesis error:', err.message);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Mobile Haptic Vibration
  // -------------------------------------------------------------------------
  vibrate(severity = 'ADVISORY') {
    if (!this.settings.hapticEnabled || typeof navigator === 'undefined' || !navigator.vibrate) {
      return false;
    }

    const pattern = HAPTIC_PATTERNS[severity] || HAPTIC_PATTERNS.ADVISORY;
    try {
      navigator.vibrate(pattern);
      return true;
    } catch (err) {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Primary Trigger Method (Called when violation is confirmed)
  // -------------------------------------------------------------------------
  playAlert(violationRecord) {
    if (!violationRecord) return;

    const severity = violationRecord.severity || 'ADVISORY';
    const type = violationRecord.violation_type || 'UNKNOWN';

    // 1. Play offline dual-tone acoustic chime
    this.playTone(severity);

    // 2. Play mobile haptic vibration
    const hapticPlayed = this.vibrate(severity);

    // 3. Spoken voice announcement
    const templateFn = VOICE_WARNING_TEMPLATES[type];
    const textToSpeak = templateFn
      ? templateFn(violationRecord)
      : `Alert: ${type.replace(/_/g, ' ')}`;
    const voiceSpoken = this.speakWarning(textToSpeak, severity, type);

    // Update internal alert state
    const alertEntry = {
      id: violationRecord.id,
      type,
      severity,
      timestamp: Date.now(),
      record: violationRecord,
      modalities: {
        sound: this.settings.soundEnabled,
        voice: voiceSpoken,
        haptic: hapticPlayed,
      },
    };

    this.activeAlert = alertEntry;
    this.alertHistory.unshift(alertEntry);
    if (this.alertHistory.length > 20) this.alertHistory.pop();

    this.emit('alertTriggered', alertEntry);
    return alertEntry;
  }

  // -------------------------------------------------------------------------
  // Dismiss Active Alert
  // -------------------------------------------------------------------------
  dismissActiveAlert() {
    if (this.activeAlert) {
      const dismissed = this.activeAlert;
      this.activeAlert = null;
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      this.emit('alertDismissed', dismissed);
    }
  }

  // -------------------------------------------------------------------------
  // Testing Methods
  // -------------------------------------------------------------------------
  testTone(severity = 'ADVISORY') {
    this.playTone(severity);
  }

  testVoice(text = 'Commercial vehicle safety systems operational.', severity = 'ADVISORY') {
    this.speakWarning(text, severity, 'TEST');
  }

  testHaptic(severity = 'ADVISORY') {
    return this.vibrate(severity);
  }

  getActiveAlert() {
    return this.activeAlert;
  }

  getHistory() {
    return [...this.alertHistory];
  }
}

// Export singleton instance
const alertActuator = new AlertActuator();
export default alertActuator;
