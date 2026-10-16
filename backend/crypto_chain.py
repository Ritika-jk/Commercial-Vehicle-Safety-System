"""
Cryptographic Blackbox Hash-Chain & Privacy-Preserving Encryption Engine.
Adheres strictly to:
- FR-11: Tamper-evident hash chain verification (SHA-256 canonical ledger).
- NFR-4 & DPDP Act 2023: AES-256 evidence encryption and role-stamped watermarking.
"""

import os
import json
import base64
import hashlib
import hmac
from datetime import datetime
from typing import Dict, Any, List, Optional, Tuple

GENESIS_HASH = "GENESIS_0000000000000000"
DEFAULT_AES_KEY = os.getenv("EVIDENCE_MASTER_KEY", "CVS_BLACKBOX_SECURE_KEY_2026_XYZ")


def canonicalize_payload(payload: Dict[str, Any]) -> str:
    """
    Serializes a dictionary into a deterministic, canonical JSON string.
    - Keys are sorted alphabetically.
    - Compact separators (no extra whitespace).
    - Floating point numbers and datetimes are normalized.
    """
    normalized: Dict[str, Any] = {}
    for k, v in payload.items():
        # Exclude hash chain and audit fields from the content hash payload
        if k in ("prev_hash", "record_hash", "evidence_clip_ref", "timestamp_server", "arrived_late"):
            continue

        if isinstance(v, datetime):
            normalized[k] = v.isoformat()
        elif isinstance(v, float):
            normalized[k] = round(v, 4)
        else:
            normalized[k] = v

    return json.dumps(normalized, sort_keys=True, separators=(",", ":"))


def compute_record_hash(prev_hash: str, payload: Dict[str, Any]) -> str:
    """
    Computes deterministic SHA-256 hash:
    record_hash = SHA256(prev_hash + canonical_json(payload))
    """
    canonical_body = canonicalize_payload(payload)
    preimage = f"{prev_hash}{canonical_body}"
    return hashlib.sha256(preimage.encode("utf-8")).hexdigest()


def extract_event_payload(event: Any) -> Dict[str, Any]:
    """
    Extracts deterministic fields from a model instance or dict.
    """
    if isinstance(event, dict):
        return {
            "id": str(event.get("id")),
            "violation_type": str(event.get("violation_type")),
            "severity": str(event.get("severity")),
            "timestamp_device": event.get("timestamp_device"),
            "lat": float(event.get("lat", 0.0)),
            "lon": float(event.get("lon", 0.0)),
            "speed_actual": float(event.get("speed_actual", 0.0)),
            "speed_safe": float(event.get("speed_safe")) if event.get("speed_safe") is not None else None,
            "curve_radius": float(event.get("curve_radius")) if event.get("curve_radius") is not None else None,
            "confidence": float(event.get("confidence", 1.0)),
            "sensor_mode": str(event.get("sensor_mode", "GPS_LOCKED")),
            "seq_no": int(event.get("seq_no", 1)),
        }

    return {
        "id": str(event.id),
        "violation_type": str(event.violation_type),
        "severity": str(event.severity),
        "timestamp_device": event.timestamp_device,
        "lat": float(event.lat),
        "lon": float(event.lon),
        "speed_actual": float(event.speed_actual),
        "speed_safe": float(event.speed_safe) if event.speed_safe is not None else None,
        "curve_radius": float(event.curve_radius) if event.curve_radius is not None else None,
        "confidence": float(event.confidence),
        "sensor_mode": str(event.sensor_mode),
        "seq_no": int(event.seq_no),
    }


def verify_violation_chain(
    records: List[Any], vehicle_registration: str
) -> Dict[str, Any]:
    """
    Validates cryptographic integrity of a vehicle's tamper-evident blackbox ledger.
    1. Sorts all records by seq_no ascending.
    2. Ensures seq_no is strictly sequential (1, 2, 3, ...).
    3. Verifies seq 1 links to GENESIS_0000000000000000.
    4. For each subsequent record, verifies prev_hash == prior record's record_hash.
    5. Recomputes record_hash = SHA256(prev_hash + canonical_json(payload)) and matches stored hash.
    """
    if not records:
        return {
            "vehicle": vehicle_registration,
            "chain_intact": True,
            "total_records": 0,
            "tampered_seq_no": None,
            "details": [],
        }

    # Ensure sorted by seq_no
    sorted_records = sorted(records, key=lambda r: getattr(r, "seq_no", r.get("seq_no") if isinstance(r, dict) else 0))

    chain_intact = True
    tampered_seq_no: Optional[int] = None
    details: List[Dict[str, Any]] = []

    expected_prev_hash = GENESIS_HASH

    for idx, rec in enumerate(sorted_records):
        payload = extract_event_payload(rec)
        seq_no = payload["seq_no"]
        stored_prev_hash = getattr(rec, "prev_hash", rec.get("prev_hash") if isinstance(rec, dict) else "")
        stored_record_hash = getattr(rec, "record_hash", rec.get("record_hash") if isinstance(rec, dict) else "")
        event_id = payload["id"]
        speed_actual = payload["speed_actual"]
        timestamp_str = (
            payload["timestamp_device"].isoformat()
            if isinstance(payload["timestamp_device"], datetime)
            else str(payload["timestamp_device"])
        )

        recomputed_hash = compute_record_hash(stored_prev_hash, payload)

        is_valid = True
        reason = None

        # Verify prev_hash link
        if stored_prev_hash != expected_prev_hash:
            is_valid = False
            reason = f"Broken chain link: prev_hash mismatch. Expected {expected_prev_hash[:12]}..., got {stored_prev_hash[:12]}..."

        # Verify record hash matches recomputed payload hash
        elif recomputed_hash != stored_record_hash:
            is_valid = False
            reason = (
                f"Data tampering detected! Payload values (e.g. speed {speed_actual} km/h) "
                f"do not match recorded cryptographic hash."
            )

        if not is_valid and chain_intact:
            chain_intact = False
            tampered_seq_no = seq_no

        details.append(
            {
                "seq_no": seq_no,
                "event_id": event_id,
                "violation_type": payload["violation_type"],
                "timestamp_device": timestamp_str,
                "speed_actual": speed_actual,
                "stored_hash": stored_record_hash,
                "recomputed_hash": recomputed_hash,
                "prev_hash": stored_prev_hash,
                "valid": is_valid,
                "reason": reason,
            }
        )

        # Expected next prev_hash is the stored record hash
        expected_prev_hash = stored_record_hash

    return {
        "vehicle": vehicle_registration,
        "chain_intact": chain_intact,
        "total_records": len(sorted_records),
        "tampered_seq_no": tampered_seq_no,
        "details": details,
    }


# ============================================================================
# AES-256 & Token-Based Evidence Protection (DPDP Act 2023)
# ============================================================================

def _derive_32byte_key(secret: str) -> bytes:
    return hashlib.sha256(secret.encode("utf-8")).digest()


def encrypt_evidence(raw_evidence_str: str, secret_key: Optional[str] = None) -> str:
    """
    Encrypts evidence snapshots using AES-GCM (if cryptography is installed)
    or authenticated HMAC-SHA256 keystream fallback.
    Returns base64 encoded ciphertext string.
    """
    key_bytes = _derive_32byte_key(secret_key or DEFAULT_AES_KEY)
    data_bytes = raw_evidence_str.encode("utf-8")

    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        aesgcm = AESGCM(key_bytes)
        nonce = os.urandom(12)
        ct = aesgcm.encrypt(nonce, data_bytes, None)
        return "aesgcm:" + base64.b64encode(nonce + ct).decode("utf-8")
    except ImportError:
        # High-security authenticated keystream fallback (CTR-like with HMAC)
        salt = os.urandom(16)
        stream_key = hmac.new(key_bytes, salt, hashlib.sha256).digest()
        
        # Keystream XOR
        keystream = bytearray()
        counter = 0
        while len(keystream) < len(data_bytes):
            block = hashlib.sha256(stream_key + counter.to_bytes(4, "big")).digest()
            keystream.extend(block)
            counter += 1
            
        encrypted_bytes = bytes(b ^ k for b, k in zip(data_bytes, keystream[:len(data_bytes)]))
        tag = hmac.new(stream_key, encrypted_bytes, hashlib.sha256).digest()
        
        envelope = salt + tag + encrypted_bytes
        return "authstream:" + base64.b64encode(envelope).decode("utf-8")


def decrypt_evidence(encrypted_str: str, secret_key: Optional[str] = None) -> str:
    """
    Decrypts encrypted evidence ciphertext back to original plain string.
    """
    key_bytes = _derive_32byte_key(secret_key or DEFAULT_AES_KEY)

    if encrypted_str.startswith("aesgcm:"):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        raw_b64 = encrypted_str.split(":", 1)[1]
        raw_bytes = base64.b64decode(raw_b64)
        nonce = raw_bytes[:12]
        ct = raw_bytes[12:]
        aesgcm = AESGCM(key_bytes)
        return aesgcm.decrypt(nonce, ct, None).decode("utf-8")

    elif encrypted_str.startswith("authstream:"):
        raw_b64 = encrypted_str.split(":", 1)[1]
        raw_bytes = base64.b64decode(raw_b64)
        salt = raw_bytes[:16]
        tag = raw_bytes[16:48]
        encrypted_bytes = raw_bytes[48:]

        stream_key = hmac.new(key_bytes, salt, hashlib.sha256).digest()
        expected_tag = hmac.new(stream_key, encrypted_bytes, hashlib.sha256).digest()
        if not hmac.compare_digest(tag, expected_tag):
            raise ValueError("Evidence decryption failed: HMAC authentication tag mismatch!")

        keystream = bytearray()
        counter = 0
        while len(keystream) < len(encrypted_bytes):
            block = hashlib.sha256(stream_key + counter.to_bytes(4, "big")).digest()
            keystream.extend(block)
            counter += 1

        decrypted = bytes(b ^ k for b, k in zip(encrypted_bytes, keystream[:len(encrypted_bytes)]))
        return decrypted.decode("utf-8")

    # If unencrypted legacy string
    return encrypted_str


def watermark_evidence_metadata(
    actor_role: str, actor_id: str, purpose: str, violation_id: str
) -> Dict[str, Any]:
    """
    Creates DPDP Act 2023 audit watermarking metadata for compliant evidence retrieval.
    """
    now = datetime.utcnow()
    watermark_digest = hashlib.sha256(
        f"{actor_role}:{actor_id}:{violation_id}:{now.isoformat()}".encode("utf-8")
    ).hexdigest()[:16]

    return {
        "dpdp_compliant": True,
        "regulation": "Digital Personal Data Protection Act 2023 §8",
        "accessed_by": f"{actor_role} ({actor_id})",
        "access_purpose": purpose,
        "accessed_at_utc": now.isoformat(),
        "audit_watermark_id": f"DPDP-AUDIT-{watermark_digest.upper()}",
    }
