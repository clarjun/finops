#!/usr/bin/env python3
"""
Azure Cost Forecasting using Time Series Analysis
Uses statistical methods and machine learning for cost prediction
"""

import sys
import json
import numpy as np
import pandas as pd
from datetime import datetime, timedelta
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import mean_absolute_percentage_error

def prepare_time_series_data(cost_data):
    """
    Convert cost data into time series format for forecasting
    """
    # Extract daily trends from processed cost data
    daily_trends = cost_data.get('dailyTrends', [])
    
    if not daily_trends:
        return None, None
    
    # Create DataFrame from daily trends
    df = pd.DataFrame(daily_trends)
    df['date'] = pd.to_datetime(df['date'])
    df = df.sort_values('date')
    
    # Add time-based features
    df['day_of_week'] = df['date'].dt.dayofweek
    df['day_of_month'] = df['date'].dt.day
    df['month'] = df['date'].dt.month
    df['days_since_start'] = (df['date'] - df['date'].min()).dt.days
    
    return df

def create_lag_features(df, target_col='cost', lags=[1, 2, 3, 7, 14]):
    """
    Create lagged features for time series prediction
    """
    for lag in lags:
        df[f'lag_{lag}'] = df[target_col].shift(lag)
    
    # Add rolling statistics
    df['rolling_mean_7'] = df[target_col].rolling(window=7, min_periods=1).mean()
    df['rolling_std_7'] = df[target_col].rolling(window=7, min_periods=1).std().fillna(0)
    df['rolling_mean_14'] = df[target_col].rolling(window=14, min_periods=1).mean()
    
    return df

def exponential_smoothing_forecast(df, alpha=0.3, forecast_days=30):
    """
    Simple exponential smoothing for baseline forecast
    """
    costs = df['cost'].values
    forecast = []
    
    # Initialize with first value
    smoothed = costs[0]
    
    # Apply exponential smoothing
    for i in range(1, len(costs)):
        smoothed = alpha * costs[i] + (1 - alpha) * smoothed
    
    # Forecast future values
    for _ in range(forecast_days):
        forecast.append(smoothed)
    
    return forecast

def ml_forecast(df, forecast_days=30):
    """
    Machine learning-based forecast using Ridge Regression
    """
    # Prepare features
    df = create_lag_features(df)
    
    # Drop rows with NaN values (from lag features)
    df_clean = df.dropna()
    
    if len(df_clean) < 10:
        # Not enough data for ML, fall back to simple method
        return exponential_smoothing_forecast(df, forecast_days=forecast_days)
    
    # Define features for training
    feature_cols = [col for col in df_clean.columns if col not in ['date', 'cost', 'services']]
    X = df_clean[feature_cols].values
    y = df_clean['cost'].values
    
    # Standardize features
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)
    
    # Train Ridge Regression model
    model = Ridge(alpha=1.0)
    model.fit(X_scaled, y)
    
    # Generate future predictions
    forecasts = []
    last_known = df_clean.iloc[-1].copy()
    
    for i in range(forecast_days):
        # Prepare features for next day
        future_date = last_known['date'] + timedelta(days=i+1)
        
        # Create feature vector
        features = {
            'day_of_week': future_date.dayofweek,
            'day_of_month': future_date.day,
            'month': future_date.month,
            'days_since_start': last_known['days_since_start'] + i + 1,
        }
        
        # Add lag features (use recent predictions)
        for lag in [1, 2, 3, 7, 14]:
            if lag <= len(forecasts):
                features[f'lag_{lag}'] = forecasts[-lag]
            else:
                idx = -(lag - len(forecasts))
                if idx >= -len(df_clean):
                    features[f'lag_{lag}'] = df_clean['cost'].iloc[idx]
                else:
                    features[f'lag_{lag}'] = df_clean['cost'].mean()
        
        # Add rolling statistics (use combination of historical and forecasted)
        recent_costs = list(df_clean['cost'].tail(14).values) + forecasts[-14:] if forecasts else []
        features['rolling_mean_7'] = np.mean(recent_costs[-7:]) if recent_costs else df_clean['cost'].mean()
        features['rolling_std_7'] = np.std(recent_costs[-7:]) if len(recent_costs) >= 7 else 0
        features['rolling_mean_14'] = np.mean(recent_costs[-14:]) if recent_costs else df_clean['cost'].mean()
        
        # Create feature array in correct order
        X_future = np.array([[features.get(col, 0) for col in feature_cols]])
        X_future_scaled = scaler.transform(X_future)
        
        # Predict
        pred = model.predict(X_future_scaled)[0]
        forecasts.append(max(0, pred))  # Ensure non-negative costs
    
    return forecasts

def calculate_confidence_intervals(historical_costs, forecasts, confidence=0.95):
    """
    Calculate confidence intervals based on historical variance
    """
    # Calculate historical standard deviation
    historical_std = np.std(historical_costs)
    
    # Z-score for 95% confidence interval
    z_score = 1.96 if confidence == 0.95 else 1.645
    
    intervals = []
    for i, forecast in enumerate(forecasts):
        # Increase uncertainty over time
        time_factor = 1 + (i * 0.02)  # 2% increase per day
        margin = z_score * historical_std * time_factor
        
        intervals.append({
            'lower': max(0, forecast - margin),
            'upper': forecast + margin,
        })
    
    return intervals

def generate_budget_recommendations(historical_avg, forecast_avg):
    """
    Generate budget recommendations based on forecast
    """
    recommendations = []
    
    # Compare forecast to historical average
    change_pct = ((forecast_avg - historical_avg) / historical_avg) * 100
    
    if change_pct > 10:
        recommendations.append({
            'type': 'budget_increase',
            'severity': 'high' if change_pct > 20 else 'medium',
            'message': f'Forecasted spending is {change_pct:.1f}% higher than historical average. Consider increasing budget.',
            'recommended_budget': forecast_avg * 1.1,  # 10% buffer
        })
    elif change_pct < -10:
        recommendations.append({
            'type': 'cost_reduction',
            'severity': 'low',
            'message': f'Forecasted spending is {abs(change_pct):.1f}% lower than historical average. Potential cost optimization achieved.',
            'recommended_budget': forecast_avg * 1.05,  # 5% buffer
        })
    else:
        recommendations.append({
            'type': 'stable',
            'severity': 'low',
            'message': 'Spending forecast is stable. Current budget allocation is appropriate.',
            'recommended_budget': forecast_avg * 1.1,
        })
    
    return recommendations

def forecast_costs(cost_data, forecast_days=30):
    """
    Main forecasting function
    """
    try:
        # Validate and clamp forecast days
        forecast_days = max(7, min(forecast_days, 180))  # Clamp between 7 and 180 days
        
        # Prepare time series data
        df = prepare_time_series_data(cost_data)
        
        if df is None or len(df) < 7:
            return {
                'success': False,
                'error': 'Insufficient historical data for forecasting (minimum 7 days required)',
                'forecasts': [],
                'recommendations': [],
            }
        
        # Check for zero or near-zero historical costs
        historical_avg = df['cost'].mean()
        if historical_avg < 0.01:
            return {
                'success': False,
                'error': 'Insufficient cost data (historical average is zero or near-zero)',
                'forecasts': [],
                'recommendations': [],
            }
        
        # Generate forecast
        forecasts = ml_forecast(df, forecast_days=forecast_days)
        
        # Calculate confidence intervals with sample size adjustment
        intervals = calculate_confidence_intervals(df['cost'].values, forecasts)
        
        # Generate dates for forecast
        last_date = df['date'].max()
        forecast_dates = [(last_date + timedelta(days=i+1)).strftime('%Y-%m-%d') for i in range(forecast_days)]
        
        # Prepare forecast data
        forecast_data = []
        for i, (date, cost) in enumerate(zip(forecast_dates, forecasts)):
            forecast_data.append({
                'date': date,
                'predictedCost': round(cost, 2),
                'confidenceInterval': {
                    'lower': round(intervals[i]['lower'], 2),
                    'upper': round(intervals[i]['upper'], 2),
                }
            })
        
        # Calculate metrics
        forecast_avg = np.mean(forecasts)
        
        # Calculate change percentage with zero guard
        change_pct = ((forecast_avg - historical_avg) / historical_avg) * 100 if historical_avg > 0 else 0
        
        # Generate recommendations
        recommendations = generate_budget_recommendations(historical_avg, forecast_avg)
        
        # Calculate model accuracy if we have enough data
        accuracy_metrics = {}
        if len(df) > 14:
            # Use last 7 days as test set
            train_df = df.iloc[:-7]
            test_df = df.iloc[-7:]
            
            test_forecasts = ml_forecast(train_df, forecast_days=7)
            actual_costs = test_df['cost'].values
            
            # Calculate MAPE only if actual costs don't contain zeros
            # MAPE is undefined when dividing by zero actual values
            if np.all(actual_costs > 0):
                try:
                    mape = mean_absolute_percentage_error(actual_costs, test_forecasts) * 100
                    
                    # Check for non-finite values (inf, nan)
                    if np.isfinite(mape) and mape >= 0:
                        accuracy_metrics = {
                            'mape': round(mape, 2),
                            'accuracy': round(max(0, min(100, 100 - mape)), 2),  # Clamp to [0, 100]
                        }
                except Exception:
                    # If MAPE calculation fails, skip metrics
                    pass
        
        return {
            'success': True,
            'forecasts': forecast_data,
            'summary': {
                'historicalAverage': round(historical_avg, 2),
                'forecastAverage': round(forecast_avg, 2),
                'totalForecastedCost': round(sum(forecasts), 2),
                'changePercentage': round(change_pct, 2),
            },
            'recommendations': recommendations,
            'modelMetrics': accuracy_metrics if accuracy_metrics else None,
            'dataPoints': len(df),
        }
    
    except Exception as e:
        return {
            'success': False,
            'error': str(e),
            'forecasts': [],
            'recommendations': [],
        }

def main():
    """
    Main entry point for forecasting script
    """
    try:
        # Read cost data from stdin
        input_data = json.loads(sys.stdin.read())
        
        # Get forecast parameters
        forecast_days = input_data.get('forecastDays', 30)
        cost_data = input_data.get('costData', {})
        
        # Generate forecast
        result = forecast_costs(cost_data, forecast_days=forecast_days)
        
        # Output result
        print(json.dumps(result))
        sys.exit(0)
        
    except Exception as e:
        error_result = {
            'success': False,
            'error': f'Forecasting error: {str(e)}',
            'forecasts': [],
            'recommendations': [],
        }
        print(json.dumps(error_result))
        sys.exit(1)

if __name__ == '__main__':
    main()
