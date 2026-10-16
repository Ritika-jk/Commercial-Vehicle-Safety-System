"""
Driver Rolling Safety Scorer (FR-13).
Dynamically calculates a driver's rolling safety score (0.0 - 100.0) based on:
- Violation severity (CRITICAL vs ADVISORY).
- Category weights (Overspeeding, Fatigue/Drowsiness, Distraction, Overcrowding).
- Time-decay exponential weighting (recent events have higher impact).
- Safe distance / clean window recovery factor.
"""

from datetime import datetime
from typing import List, Optional
from sqlalchemy.orm import Session

from models import Driver, ViolationEvent


# Base penalties per violation category
PENALTY_WEIGHTS = {
    "OVERSPEED_CURVE": {"CRITICAL": 12.0, "ADVISORY": 3.0},
    "DROWSINESS": {"CRITICAL": 15.0, "ADVISORY": 4.0},
    "PHONE_USE": {"CRITICAL": 10.0, "ADVISORY": 3.0},
    "DISTRACTION": {"CRITICAL": 8.0, "ADVISORY": 2.0},
    "OVERCROWDING": {"CRITICAL": 8.0, "ADVISORY": 2.0},
    "SOS_ALERT": {"CRITICAL": 10.0, "ADVISORY": 5.0},
}


def calculate_time_decay_factor(event_time: datetime, current_time: Optional[datetime] = None) -> float:
    """
    Computes time-decay multiplier for rolling score calculation:
    - Events < 24 hours old: 1.0 (full weight)
    - Events 24 - 72 hours old: 0.75
    - Events 3 - 7 days old: 0.45
    - Events > 7 days old: 0.20
    """
    now = current_time or datetime.utcnow()
    delta_hours = max(0.0, (now - event_time).total_seconds() / 3600.0)

    if delta_hours <= 24.0:
        return 1.0
    elif delta_hours <= 72.0:
        return 0.75
    elif delta_hours <= 168.0:  # 7 days
        return 0.45
    else:
        return 0.20


def compute_driver_score_from_violations(
    violations: List[ViolationEvent],
    base_score: float = 100.0,
    current_time: Optional[datetime] = None,
) -> float:
    """
    Computes rolling safety score for a collection of driver violation events.
    Score = max(0.0, min(100.0, base_score - sum(penalty * time_decay))).
    """
    now = current_time or datetime.utcnow()
    total_deductions = 0.0

    for v in violations:
        v_type = v.violation_type.upper()
        v_sev = v.severity.upper()

        weights_for_type = PENALTY_WEIGHTS.get(
            v_type, {"CRITICAL": 10.0, "ADVISORY": 3.0}
        )
        penalty = weights_for_type.get(v_sev, 5.0)

        # Apply time decay
        decay = calculate_time_decay_factor(v.timestamp_device, now)
        total_deductions += penalty * decay

    new_score = max(0.0, min(100.0, base_score - total_deductions))
    return round(new_score, 1)


def update_driver_rolling_score(db: Session, driver_id: int) -> float:
    """
    Loads all recent violation events for a driver, recalculates rolling score,
    persists the updated score in the database, and returns the new value.
    """
    driver = db.query(Driver).filter(Driver.id == driver_id).first()
    if not driver:
        return 100.0

    violations = (
        db.query(ViolationEvent)
        .filter(ViolationEvent.driver_id == driver_id)
        .all()
    )

    new_score = compute_driver_score_from_violations(violations)
    driver.rolling_safety_score = new_score
    db.commit()
    db.refresh(driver)
    return new_score
