"""
Initial Database Seeding for Commercial Vehicle Safety System.
Creates baseline drivers, vehicles, sample passenger feedbacks,
and a verified cryptographic blackbox hash chain for JK02-1234.
"""

from datetime import datetime, timedelta
import uuid
from sqlalchemy.orm import Session

from models import Vehicle, Driver, ViolationEvent, AuditLog, PassengerFeedback
from crypto_chain import (
    GENESIS_HASH,
    compute_record_hash,
    encrypt_evidence,
)


def seed_initial_fleet(db: Session) -> None:
    """
    Populates test commercial vehicles, drivers, and verified cryptographic hash chains.
    """
    # Check if database is already seeded
    existing_driver = db.query(Driver).first()
    if existing_driver:
        return

    # 1. Create Baseline Commercial Drivers
    driver_1 = Driver(
        name="Ramesh Kumar",
        license_number="DL-02-2018-9843",
        rolling_safety_score=92.5,
    )
    driver_2 = Driver(
        name="Tariq Ahmed",
        license_number="DL-01-2015-4512",
        rolling_safety_score=84.0,
    )
    driver_3 = Driver(
        name="Sunita Devi",
        license_number="DL-14-2020-7711",
        rolling_safety_score=98.0,
    )
    db.add_all([driver_1, driver_2, driver_3])
    db.commit()
    db.refresh(driver_1)
    db.refresh(driver_2)
    db.refresh(driver_3)

    # 2. Create Commercial Fleet Vehicles
    v1 = Vehicle(
        registration="JK02-1234",
        permitted_capacity=32,
        assigned_driver_id=driver_1.id,
        current_lat=33.08415,
        current_lon=75.32612,
        current_speed=38.5,
        sensor_mode="GPS_LOCKED",
        last_seen=datetime.utcnow(),
    )
    v2 = Vehicle(
        registration="JK01-5678",
        permitted_capacity=24,
        assigned_driver_id=driver_2.id,
        current_lat=33.03810,
        current_lon=75.29520,
        current_speed=25.0,
        sensor_mode="IMU_DEAD_RECKONING",  # Chenani Tunnel GPS-denied
        last_seen=datetime.utcnow() - timedelta(seconds=8),
    )
    v3 = Vehicle(
        registration="JK14-9988",
        permitted_capacity=42,
        assigned_driver_id=driver_3.id,
        current_lat=33.24210,
        current_lon=75.24120,
        current_speed=30.0,
        sensor_mode="GPS_LOCKED",
        last_seen=datetime.utcnow() - timedelta(seconds=2),
    )
    db.add_all([v1, v2, v3])
    db.commit()
    db.refresh(v1)
    db.refresh(v2)
    db.refresh(v3)

    # 3. Create a Verified 3-Record Cryptographic Blackbox Hash Chain for JK02-1234
    now = datetime.utcnow()
    
    # Event 1 (Genesis link)
    ev1_id = str(uuid.uuid4())
    ev1_time = now - timedelta(minutes=45)
    ev1_payload = {
        "id": ev1_id,
        "violation_type": "OVERSPEED_CURVE",
        "severity": "ADVISORY",
        "timestamp_device": ev1_time,
        "lat": 33.08415,
        "lon": 75.32612,
        "speed_actual": 38.0,
        "speed_safe": 26.5,
        "curve_radius": 31.8,
        "confidence": 0.95,
        "sensor_mode": "GPS_LOCKED",
        "seq_no": 1,
    }
    hash_1 = compute_record_hash(GENESIS_HASH, ev1_payload)
    event_1 = ViolationEvent(
        id=ev1_id,
        vehicle_id=v1.id,
        driver_id=driver_1.id,
        violation_type="OVERSPEED_CURVE",
        severity="ADVISORY",
        timestamp_device=ev1_time,
        timestamp_server=ev1_time + timedelta(seconds=2),
        arrived_late=False,
        lat=33.08415,
        lon=75.32612,
        speed_actual=38.0,
        speed_safe=26.5,
        curve_radius=31.8,
        confidence=0.95,
        sensor_mode="GPS_LOCKED",
        evidence_clip_ref=encrypt_evidence(
            "Snapshot: Patnitop Hairpin Bend 1, Speed: 38 km/h, Safe: 26.5 km/h, Radius: 31.8m"
        ),
        prev_hash=GENESIS_HASH,
        record_hash=hash_1,
        seq_no=1,
    )

    # Event 2
    ev2_id = str(uuid.uuid4())
    ev2_time = now - timedelta(minutes=30)
    ev2_payload = {
        "id": ev2_id,
        "violation_type": "DROWSINESS",
        "severity": "ADVISORY",
        "timestamp_device": ev2_time,
        "lat": 33.08502,
        "lon": 75.32745,
        "speed_actual": 34.0,
        "speed_safe": 30.0,
        "curve_radius": 38.0,
        "confidence": 0.91,
        "sensor_mode": "GPS_LOCKED",
        "seq_no": 2,
    }
    hash_2 = compute_record_hash(hash_1, ev2_payload)
    event_2 = ViolationEvent(
        id=ev2_id,
        vehicle_id=v1.id,
        driver_id=driver_1.id,
        violation_type="DROWSINESS",
        severity="ADVISORY",
        timestamp_device=ev2_time,
        timestamp_server=ev2_time + timedelta(seconds=3),
        arrived_late=False,
        lat=33.08502,
        lon=75.32745,
        speed_actual=34.0,
        speed_safe=30.0,
        curve_radius=38.0,
        confidence=0.91,
        sensor_mode="GPS_LOCKED",
        evidence_clip_ref=encrypt_evidence(
            "Snapshot: Driver EAR dropped below 0.20 for 2.2 seconds (EAR=0.185, MAR=0.62)"
        ),
        prev_hash=hash_1,
        record_hash=hash_2,
        seq_no=2,
    )

    # Event 3 (Critical overspeed)
    ev3_id = str(uuid.uuid4())
    ev3_time = now - timedelta(minutes=15)
    ev3_payload = {
        "id": ev3_id,
        "violation_type": "OVERSPEED_CURVE",
        "severity": "CRITICAL",
        "timestamp_device": ev3_time,
        "lat": 33.08595,
        "lon": 75.32882,
        "speed_actual": 47.5,
        "speed_safe": 24.0,
        "curve_radius": 27.5,
        "confidence": 0.98,
        "sensor_mode": "GPS_LOCKED",
        "seq_no": 3,
    }
    hash_3 = compute_record_hash(hash_2, ev3_payload)
    event_3 = ViolationEvent(
        id=ev3_id,
        vehicle_id=v1.id,
        driver_id=driver_1.id,
        violation_type="OVERSPEED_CURVE",
        severity="CRITICAL",
        timestamp_device=ev3_time,
        timestamp_server=ev3_time + timedelta(seconds=4),
        arrived_late=False,
        lat=33.08595,
        lon=75.32882,
        speed_actual=47.5,
        speed_safe=24.0,
        curve_radius=27.5,
        confidence=0.98,
        sensor_mode="GPS_LOCKED",
        evidence_clip_ref=encrypt_evidence(
            "Snapshot: Patnitop Hairpin Bend 2, Actual: 47.5 km/h, Safe: 24.0 km/h, Delta: +23.5 km/h"
        ),
        prev_hash=hash_2,
        record_hash=hash_3,
        seq_no=3,
    )

    db.add_all([event_1, event_2, event_3])

    # 4. Add Passenger Feedback
    feedback_1 = PassengerFeedback(
        vehicle_id=v1.id,
        trip_id="TRIP-JK-042",
        rating=4,
        comment="Smooth driving overall, but speed warning chimed near Patnitop.",
        is_sos=False,
        created_at=now - timedelta(minutes=10),
    )
    feedback_2 = PassengerFeedback(
        vehicle_id=v2.id,
        trip_id="TRIP-JK-088",
        rating=5,
        comment="Felt very safe inside the tunnel despite lack of GPS.",
        is_sos=False,
        created_at=now - timedelta(minutes=5),
    )
    db.add_all([feedback_1, feedback_2])

    # 5. Baseline Audit Log Entry
    audit_1 = AuditLog(
        actor_role="TRANSPORT_AUTHORITY",
        actor_id="jk_rto_inspector_12",
        violation_id=ev3_id,
        accessed_at=now - timedelta(minutes=2),
        purpose="Routine commercial mountain corridor safety audit",
    )
    db.add(audit_1)

    db.commit()


def reset_demo_fleet(db: Session) -> None:
    """
    Clears all tables and reseeds fresh baseline data for live evaluator demos.
    """
    db.query(AuditLog).delete()
    db.query(PassengerFeedback).delete()
    db.query(ViolationEvent).delete()
    db.query(Vehicle).delete()
    db.query(Driver).delete()
    db.commit()
    seed_initial_fleet(db)


if __name__ == "__main__":
    import sys
    from database import SessionLocal, init_db

    print("=" * 70)
    print("AI Commercial Vehicle Safety System — Database Seeder")
    print("=" * 70)
    init_db()
    db = SessionLocal()
    try:
        if "--reset" in sys.argv or "-r" in sys.argv:
            print("[INFO] Resetting and re-seeding baseline demo fleet...")
            reset_demo_fleet(db)
            print("[OK] Demo fleet reset complete.")
        else:
            print("[INFO] Checking database seed status...")
            seed_initial_fleet(db)
            print("[OK] Baseline fleet verified.")

        v_count = db.query(Vehicle).count()
        d_count = db.query(Driver).count()
        e_count = db.query(ViolationEvent).count()
        print(f"[STATUS] Database contains: {v_count} Vehicles, {d_count} Drivers, {e_count} Violations.")
        print("[READY] Vehicle JK02-1234 is pre-loaded with verified SHA-256 hash chains.")
        print("        Verify API: http://localhost:8000/api/verify/JK02-1234")
    finally:
        db.close()

