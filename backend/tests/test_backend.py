"""
Automated Pytest Suite for AI Commercial Vehicle Safety Backend.
Covers:
- Menger Curvature Radius & Safe Speed Physics (FR-6, FR-7)
- Cryptographic SHA-256 Hash Chain Integrity & Tamper Detection (FR-11)
- Idempotent Outbox Synchronization & Late-Arrival Detection (FR-12)
- Driver Rolling Safety Score Calculation (FR-13)
- DPDP Act 2023 Evidence Access Control & Audit Logging (NFR-4)
"""

import sys
import os
from datetime import datetime, timedelta
import uuid
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Ensure backend root is on sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from database import Base, get_db
from models import Vehicle, Driver, ViolationEvent, AuditLog, PassengerFeedback
from crypto_chain import (
    GENESIS_HASH,
    compute_record_hash,
    verify_violation_chain,
    canonicalize_payload,
    encrypt_evidence,
    decrypt_evidence,
)
from gis_engine import (
    calculate_menger_radius,
    compute_safe_curve_speed,
    compute_warning_distance,
    haversine_distance,
    evaluate_curve_ahead,
)
from safety_scorer import compute_driver_score_from_violations
from main import app
from sqlalchemy.pool import StaticPool

# In-memory test SQLite DB with StaticPool so all threads share tables
SQLALCHEMY_TEST_DATABASE_URL = "sqlite:///:memory:"
test_engine = create_engine(
    SQLALCHEMY_TEST_DATABASE_URL,
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)


def override_get_db():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


app.dependency_overrides[get_db] = override_get_db


@pytest.fixture(autouse=True)
def setup_test_db():
    Base.metadata.create_all(bind=test_engine)
    yield
    Base.metadata.drop_all(bind=test_engine)


@pytest.fixture
def client():
    return TestClient(app)


# ============================================================================
# 1. Physics & GIS Curve Engine Tests
# ============================================================================

def test_menger_curvature_straight_road():
    # 3 collinear points along a meridian (due north)
    p1 = (33.0000, 75.0000)
    p2 = (33.0010, 75.0000)
    p3 = (33.0020, 75.0000)
    radius = calculate_menger_radius(p1, p2, p3)
    assert radius >= 9000.0, f"Collinear points should yield infinite radius, got {radius}"


def test_menger_curvature_sharp_hairpin():
    # 3 points forming a sharp mountain hairpin bend (Patnitop-like)
    p1 = (33.084150, 75.326120)
    p2 = (33.084890, 75.327450)
    p3 = (33.084220, 75.328310)
    radius = calculate_menger_radius(p1, p2, p3)
    assert 20.0 <= radius <= 150.0, f"Expected realistic hairpin radius, got {radius}m"


def test_safe_speed_calculation_and_imu_degraded_mode():
    curve_r = 30.0  # 30m sharp hairpin
    v_safe_gps = compute_safe_curve_speed(curve_r, superelevation=0.07, sensor_mode="GPS_LOCKED")
    v_safe_imu = compute_safe_curve_speed(curve_r, superelevation=0.07, sensor_mode="IMU_DEAD_RECKONING")

    # In GPS_LOCKED, v = 3.6 * sqrt(30 * 9.81 * (0.07 + 0.15)) = 3.6 * sqrt(64.746) ≈ 28.97 km/h
    assert 27.0 <= v_safe_gps <= 31.0
    # In IMU_DEAD_RECKONING, friction f is reduced by 15%, so safe speed MUST be strictly lower
    assert v_safe_imu < v_safe_gps
    assert 25.0 <= v_safe_imu <= 29.0


def test_warning_distance_downhill_penalty():
    speed = 50.0  # km/h
    dist_flat = compute_warning_distance(speed, gradient=0.0)
    dist_downhill = compute_warning_distance(speed, gradient=-0.07)  # 7% downhill

    # Downhill requires greater stopping and warning distance
    assert dist_downhill > dist_flat
    assert dist_flat > 0.0


# ============================================================================
# 2. Cryptographic Hash Chain Tests (FR-11)
# ============================================================================

def test_canonical_json_determinism():
    payload_a = {"seq_no": 1, "speed_actual": 45.0, "violation_type": "OVERSPEED_CURVE"}
    payload_b = {"violation_type": "OVERSPEED_CURVE", "speed_actual": 45.0, "seq_no": 1}
    assert canonicalize_payload(payload_a) == canonicalize_payload(payload_b)
    hash_a = compute_record_hash(GENESIS_HASH, payload_a)
    hash_b = compute_record_hash(GENESIS_HASH, payload_b)
    assert hash_a == hash_b


def test_hash_chain_verification_and_tamper_detection():
    now = datetime.utcnow()
    # Create event 1
    p1 = {
        "id": str(uuid.uuid4()),
        "violation_type": "OVERSPEED_CURVE",
        "severity": "ADVISORY",
        "timestamp_device": now,
        "lat": 33.084,
        "lon": 75.326,
        "speed_actual": 42.0,
        "speed_safe": 26.5,
        "curve_radius": 31.8,
        "confidence": 1.0,
        "sensor_mode": "GPS_LOCKED",
        "seq_no": 1,
    }
    h1 = compute_record_hash(GENESIS_HASH, p1)
    ev1 = ViolationEvent(**p1, prev_hash=GENESIS_HASH, record_hash=h1)

    # Create event 2
    p2 = {
        "id": str(uuid.uuid4()),
        "violation_type": "DROWSINESS",
        "severity": "CRITICAL",
        "timestamp_device": now + timedelta(minutes=5),
        "lat": 33.085,
        "lon": 75.327,
        "speed_actual": 35.0,
        "speed_safe": 30.0,
        "curve_radius": 35.0,
        "confidence": 0.9,
        "sensor_mode": "GPS_LOCKED",
        "seq_no": 2,
    }
    h2 = compute_record_hash(h1, p2)
    ev2 = ViolationEvent(**p2, prev_hash=h1, record_hash=h2)

    # Clean verification
    res = verify_violation_chain([ev1, ev2], "JK02-1234")
    assert res["chain_intact"] is True
    assert res["tampered_seq_no"] is None
    assert res["total_records"] == 2

    # Deliberate tampering: alter speed of ev1 without changing its hash
    ev1.speed_actual = 20.0
    res_tampered = verify_violation_chain([ev1, ev2], "JK02-1234")
    assert res_tampered["chain_intact"] is False
    assert res_tampered["tampered_seq_no"] == 1


def test_evidence_encryption_and_decryption():
    secret_text = "Driver detected nodding off for 2.4s (EAR=0.17)"
    encrypted = encrypt_evidence(secret_text)
    assert encrypted != secret_text
    decrypted = decrypt_evidence(encrypted)
    assert decrypted == secret_text


# ============================================================================
# 3. Outbox Synchronization & Late Arrival API Tests (FR-12, FR-13)
# ============================================================================

def test_idempotent_outbox_sync(client):
    # Setup vehicle and driver
    db = TestingSessionLocal()
    driver = Driver(name="Test Driver", license_number="DL-TEST-001", rolling_safety_score=100.0)
    db.add(driver)
    db.commit()
    db.refresh(driver)
    driver_id = driver.id
    vehicle = Vehicle(registration="JK02-TEST", permitted_capacity=32, assigned_driver_id=driver_id)
    db.add(vehicle)
    db.commit()
    db.close()

    event_id = str(uuid.uuid4())
    event_time = datetime.utcnow()
    payload = {
        "id": event_id,
        "violation_type": "OVERSPEED_CURVE",
        "severity": "CRITICAL",
        "timestamp_device": event_time.isoformat(),
        "lat": 33.085,
        "lon": 75.328,
        "speed_actual": 48.0,
        "speed_safe": 24.0,
        "curve_radius": 27.5,
        "confidence": 0.95,
        "sensor_mode": "GPS_LOCKED",
        "seq_no": 1,
    }
    rec_hash = compute_record_hash(GENESIS_HASH, {**payload, "timestamp_device": event_time})

    outbox_req = {
        "events": [
            {
                **payload,
                "vehicle_registration": "JK02-TEST",
                "driver_id": driver_id,
                "prev_hash": GENESIS_HASH,
                "record_hash": rec_hash,
            }
        ]
    }

    # First call: newly ingested
    r1 = client.post("/api/sync/outbox", json=outbox_req)
    assert r1.status_code == 200
    data1 = r1.json()
    assert data1["new_records"] == 1
    assert data1["duplicates"] == 0
    # Rolling safety score should decrease from 100
    assert data1["updated_driver_scores"][str(driver_id)] < 100.0

    # Second call with same UUID: idempotent duplicate recognition
    r2 = client.post("/api/sync/outbox", json=outbox_req)
    assert r2.status_code == 200
    data2 = r2.json()
    assert data2["new_records"] == 0
    assert data2["duplicates"] == 1


def test_late_arrival_offline_tunnel_flag(client):
    # Timestamp device 60 seconds ago (simulating offline tunnel emergence)
    old_device_time = datetime.utcnow() - timedelta(seconds=60)
    event_id = str(uuid.uuid4())
    p = {
        "id": event_id,
        "violation_type": "DROWSINESS",
        "severity": "ADVISORY",
        "timestamp_device": old_device_time,
        "lat": 33.038,
        "lon": 75.295,
        "speed_actual": 30.0,
        "speed_safe": 40.0,
        "curve_radius": 60.0,
        "confidence": 0.9,
        "sensor_mode": "IMU_DEAD_RECKONING",
        "seq_no": 1,
    }
    rec_hash = compute_record_hash(GENESIS_HASH, p)

    outbox_req = {
        "events": [
            {
                **p,
                "timestamp_device": old_device_time.isoformat(),
                "vehicle_registration": "JK01-TUNNEL",
                "prev_hash": GENESIS_HASH,
                "record_hash": rec_hash,
            }
        ]
    }

    res = client.post("/api/sync/outbox", json=outbox_req)
    assert res.status_code == 200

    # Query violation from DB
    db = TestingSessionLocal()
    ev = db.query(ViolationEvent).filter(ViolationEvent.id == event_id).first()
    assert ev is not None
    assert ev.arrived_late is True
    db.close()


# ============================================================================
# 4. DPDP Act 2023 Evidence Access Tests (NFR-4)
# ============================================================================

def test_dpdp_evidence_role_enforcement(client):
    db = TestingSessionLocal()
    ev_id = str(uuid.uuid4())
    ev = ViolationEvent(
        id=ev_id,
        violation_type="OVERSPEED_CURVE",
        severity="CRITICAL",
        timestamp_device=datetime.utcnow(),
        lat=33.084,
        lon=75.326,
        speed_actual=50.0,
        prev_hash=GENESIS_HASH,
        record_hash="sample_hash",
        seq_no=1,
        evidence_clip_ref=encrypt_evidence("Confidential cabin camera frame"),
    )
    db.add(ev)
    db.commit()
    db.close()

    # Unauthorized access (no X-Role header or Passenger role)
    r_unauth = client.get(f"/api/evidence/{ev_id}")
    assert r_unauth.status_code == 403

    r_passenger = client.get(f"/api/evidence/{ev_id}", headers={"X-Role": "PASSENGER"})
    assert r_passenger.status_code == 403

    # Authorized access with TRANSPORT_AUTHORITY role
    r_auth = client.get(
        f"/api/evidence/{ev_id}",
        headers={
            "X-Role": "TRANSPORT_AUTHORITY",
            "X-Actor-Id": "inspector_patnitop_4",
            "X-Purpose": "Commercial bus fatal crash investigation",
        },
    )
    assert r_auth.status_code == 200
    data = r_auth.json()
    assert "Confidential cabin camera frame" in data["evidence_payload"]
    assert data["watermark"]["dpdp_compliant"] is True

    # Verify audit log was recorded
    db = TestingSessionLocal()
    log = db.query(AuditLog).filter(AuditLog.violation_id == ev_id).first()
    assert log is not None
    assert log.actor_role == "TRANSPORT_AUTHORITY"
    assert log.actor_id == "inspector_patnitop_4"
    db.close()
