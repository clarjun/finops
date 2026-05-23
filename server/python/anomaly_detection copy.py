#!/usr/bin/env python3
import sys
import json
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from datetime import datetime

def detect_anomalies_copy(cost_data):
    """
    Detect anomalies in Azure cost data using Isolation Forest algorithm
    """
    try:
        # Convert daily trends to DataFrame
        df = pd.DataFrame(cost_data['dailyTrends'])
        
        if len(df) < 3:
            return {
                'anomalies': [],
                'insights': ['Insufficient data for anomaly detection (need at least 3 days)'],
                'recommendations': ['Collect more historical data for better analysis']
            }
        
        # Prepare features for anomaly detection
        features = df[['cost']].values
        
        # Train Isolation Forest model
        # contamination is the expected proportion of outliers
        contamination = min(0.1, max(0.01, 2.0 / len(df)))  # adaptive contamination
        iso_forest = IsolationForest(contamination=contamination, random_state=42)
        predictions = iso_forest.fit_predict(features)
        scores = iso_forest.score_samples(features)
        
        # Identify anomalies (prediction = -1 means anomaly)
        anomalies = []
        for idx, (pred, score) in enumerate(zip(predictions, scores)):
            if pred == -1:
                row = df.iloc[idx]
                cost = float(row['cost'])
                date = row['date']
                
                # Determine severity based on anomaly score
                # Lower scores (more negative) = more anomalous
                if score < -0.5:
                    severity = 'high'
                elif score < -0.3:
                    severity = 'medium'
                else:
                    severity = 'low'
                
                # Determine anomaly type
                if idx > 0:
                    prev_cost = float(df.iloc[idx - 1]['cost'])
                    if cost > prev_cost * 1.5:
                        anomaly_type = 'spike'
                        description = f"Unusual cost spike detected: ${cost:.2f} (up from ${prev_cost:.2f})"
                    elif cost < prev_cost * 0.5:
                        anomaly_type = 'unusual'
                        description = f"Unusual cost drop detected: ${cost:.2f} (down from ${prev_cost:.2f})"
                    else:
                        anomaly_type = 'trend_change'
                        description = f"Anomalous spending pattern detected: ${cost:.2f}"
                else:
                    anomaly_type = 'unusual'
                    description = f"Anomalous spending detected: ${cost:.2f}"
                
                anomalies.append({
                    'date': date,
                    'cost': cost,
                    'type': anomaly_type,
                    'severity': severity,
                    'description': description
                })
        
        # Generate insights
        insights = []
        recommendations = []
        
        # Cost trend analysis
        costs = df['cost'].values
        mean_cost = float(np.mean(costs))
        std_cost = float(np.std(costs))
        trend = float(np.polyfit(range(len(costs)), costs, 1)[0])  # linear trend
        
        if trend > mean_cost * 0.05:
            insights.append(f"Costs are trending upward at ${abs(trend):.2f} per day")
            recommendations.append("Review new services or increased usage causing cost increases")
        elif trend < -mean_cost * 0.05:
            insights.append(f"Costs are trending downward at ${abs(trend):.2f} per day")
        else:
            insights.append("Costs are relatively stable")
        
        # Variability analysis
        cv = (std_cost / mean_cost) if mean_cost > 0 else 0
        if cv > 0.5:
            insights.append("High cost variability detected across days")
            recommendations.append("Investigate services with fluctuating usage patterns")
        elif cv < 0.2:
            insights.append("Low cost variability - spending is consistent")
        
        # Peak day analysis
        max_cost_idx = int(np.argmax(costs))
        max_cost_date = df.iloc[max_cost_idx]['date']
        max_cost = float(costs[max_cost_idx])
        insights.append(f"Peak spending of ${max_cost:.2f} occurred on {max_cost_date}")
        
        # Service diversity
        service_count = len(cost_data.get('services', []))
        if service_count > 20:
            insights.append(f"High service diversity with {service_count} active services")
            recommendations.append("Consider consolidating or optimizing service usage")
        elif service_count < 5:
            insights.append(f"Low service diversity with only {service_count} services")
        
        # Top service analysis
        top_service = cost_data.get('topService', {})
        if top_service and top_service.get('cost', 0) > mean_cost * 0.5:
            insights.append(f"{top_service['name']} dominates your spending")
            recommendations.append(f"Focus optimization efforts on {top_service['name']}")
        
        # Add anomaly summary
        if len(anomalies) > 0:
            insights.append(f"Detected {len(anomalies)} spending anomalies requiring attention")
            high_severity = sum(1 for a in anomalies if a['severity'] == 'high')
            if high_severity > 0:
                recommendations.append(f"Investigate {high_severity} high-severity anomalies immediately")
        else:
            insights.append("No significant anomalies detected in spending patterns")
        
        return {
            'anomalies': anomalies,
            'insights': insights,
            'recommendations': recommendations
        }
    
    except Exception as e:
        return {
            'anomalies': [],
            'insights': [f'Error during anomaly detection: {str(e)}'],
            'recommendations': ['Check data format and try again']
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
