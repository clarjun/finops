import sys
import json
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from datetime import datetime

def detect_anomalies(cost_data):
    """
    Enterprise-grade anomaly detection with:
    - ML anomaly detection (Isolation Forest)
    - Total delta calculation
    - Service-level root cause analysis
    - % contribution scoring
    - Severity classification
    - Confidence scoring
    """

    try:
        df = pd.DataFrame(cost_data['dailyTrends'])

        if len(df) < 3:
            return {
                "anomalies": [],
                "insights": ["Insufficient data (minimum 3 days required)"]
            }

        # ---------- PREPARE DATA ----------
        df = df.sort_values("date").reset_index(drop=True)
        features = df[['cost']].values

        contamination = min(0.1, max(0.02, 2.0 / len(df)))
        model = IsolationForest(
            contamination=contamination,
            random_state=42
        )

        predictions = model.fit_predict(features)
        scores = model.decision_function(features)  # confidence scores

        anomalies = []

        for idx, pred in enumerate(predictions):
            if pred == -1:

                row = df.iloc[idx]
                date = row["date"]
                cost = float(row["cost"])
                confidence_score = float(abs(scores[idx]))

                anomaly_type = "unusual"
                total_delta = 0
                root_cause = None
                service_delta = 0
                contribution_percent = 0

                if idx > 0:
                    prev_row = df.iloc[idx - 1]
                    prev_cost = float(prev_row["cost"])
                    total_delta = cost - prev_cost

                    # ---- CLASSIFY SPIKE OR DROP ----
                    if cost > prev_cost * 1.5:
                        anomaly_type = "spike"
                    elif cost < prev_cost * 0.5:
                        anomaly_type = "drop"

                    # ---- ROOT CAUSE (Improved Logic) ----
                    today_services = row.get("services", {})
                    prev_services = prev_row.get("services", {})

                    all_services = set(today_services.keys()).union(prev_services.keys())

                    max_delta = 0
                    cause_service = None

                    for service in all_services:
                        today_value = today_services.get(service, 0)
                        prev_value = prev_services.get(service, 0)
                        delta = today_value - prev_value

                        if abs(delta) > abs(max_delta):
                            max_delta = delta
                            cause_service = service

                    if cause_service:
                        root_cause = cause_service
                        service_delta = round(max_delta, 2)

                        if total_delta != 0:
                            contribution_percent = round(
                                (abs(service_delta) / abs(total_delta)) * 100,
                                2
                            )

                # ---------- SEVERITY SCORING ----------
                abs_delta = abs(total_delta)

                if abs_delta > 1000:
                    severity = "Critical"
                elif abs_delta > 500:
                    severity = "High"
                elif abs_delta > 200:
                    severity = "Medium"
                else:
                    severity = "Low"

                # ---------- RECOMMENDATION ENGINE ----------
                if anomaly_type == "spike":
                    recommendation = f"Review scaling & workload increase for {root_cause}."
                elif anomaly_type == "drop":
                    recommendation = f"Verify if {root_cause} resources were stopped or resized."
                else:
                    recommendation = "Investigate unusual cost behavior."

                anomalies.append({
                    "date": date,
                    "type": anomaly_type,
                    "cost": round(cost, 2),
                    "totalDelta": round(total_delta, 2),
                    "rootCause": root_cause,
                    "serviceImpact": service_delta,
                    "contributionPercent": contribution_percent,
                    "severity": severity,
                    "confidenceScore": round(confidence_score, 4),
                    "recommendation": recommendation
                })

        # ---------- EXECUTIVE INSIGHTS ----------
        costs = df["cost"].values
        trend = float(np.polyfit(range(len(costs)), costs, 1)[0])

        insights = []

        if trend > 0:
            insights.append(f"Costs trending upward at ${abs(trend):.2f}/day")
        elif trend < 0:
            insights.append(f"Costs trending downward at ${abs(trend):.2f}/day")
        else:
            insights.append("Costs stable")

        if anomalies:
            insights.append(f"{len(anomalies)} anomalies detected")
        else:
            insights.append("No anomalies detected")

        return {
            "anomalies": anomalies,
            "insights": insights
        }

    except Exception as e:
        return {
            "anomalies": [],
            "insights": [f"Error during anomaly detection: {str(e)}"]
        }


if __name__ == '__main__':
    try:
        # Read input from stdin
        input_data = json.loads(sys.stdin.read())
        result = detect_anomalies(input_data)
        print(json.dumps(result))
    except Exception as e:
        error_result = {
            'anomalies': [],
            'insights': [f'Fatal error: {str(e)}'],
            'recommendations': ['Contact support if this persists']
        }
        print(json.dumps(error_result))
        sys.exit(1)