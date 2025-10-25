#!/usr/bin/env python3
"""
Multi-Cloud Cost Forecasting using Time Series Analysis
Uses statistical methods and machine learning for cost prediction with outlier handling
"""

import sys
import json
import numpy as np
import pandas as pd
from datetime import datetime, timedelta
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import mean_absolute_percentage_error

def remove_outliers(df, column='cost', method='iqr', threshold=1.5):
    """
    Remove outliers from the data to prevent forecast contamination
    Uses IQR method by default with aggressive threshold
    """
    if method == 'iqr':
        Q1 = df[column].quantile(0.25)
        Q3 = df[column].quantile(0.75)
        IQR = Q3 - Q1
        lower_bound = Q1 - threshold * IQR
        upper_bound = Q3 + threshold * IQR
        
        # Replace outliers with median instead of removing (preserves data points)
        median = df[column].median()
        df_clean = df.copy()
        
        outlier_mask = (df_clean[column] > upper_bound) | (df_clean[column] < lower_bound)
        outliers_count = outlier_mask.sum()
        
        if outliers_count > 0:
            print(f"Replacing {outliers_count} outliers with median ${median:.2f}", file=sys.stderr)
            print(f"Outlier bounds: ${lower_bound:.2f} to ${upper_bound:.2f}", file=sys.stderr)
        
        df_clean.loc[df_clean[column] > upper_bound, column] = median
        df_clean.loc[df_clean[column] < lower_bound, column] = median
        
        return df_clean
    
    return df

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

def create_lag_features(df, target_col='cost', lags=[1, 2, 3, 7]):
    """
    Create lagged features for time series prediction
    Reduced lags to prevent error compounding
    """
    for lag in lags:
        df[f'lag_{lag}'] = df[target_col].shift(lag)
    
    # Add rolling statistics with robust measures
    df['rolling_median_7'] = df[target_col].rolling(window=7, min_periods=1).median()
    df['rolling_mean_7'] = df[target_col].rolling(window=7, min_periods=1).mean()
    df['rolling_std_7'] = df[target_col].rolling(window=7, min_periods=1).std().fillna(0)
    
    return df

def exponential_smoothing_forecast(df, alpha=0.3, forecast_days=30):
    """
    Simple exponential smoothing for baseline forecast
    """
    costs = df['cost'].values
    forecast = []
    
    # Initialize with median (more robust than first value)
    smoothed = np.median(costs)
    
    # Apply exponential smoothing
    for i in range(len(costs)):
        smoothed = alpha * costs[i] + (1 - alpha) * smoothed
    
    # Forecast future values (constant)
    for _ in range(forecast_days):
        forecast.append(smoothed)
    
    return forecast

def ml_forecast(df, forecast_days=30):
    """
    Machine learning-based forecast using Ridge Regression with outlier handling
    """
    # Remove outliers before training with aggressive threshold
    df_clean_outliers = remove_outliers(df.copy(), column='cost', threshold=1.5)
    
    # Prepare features
    df_features = create_lag_features(df_clean_outliers)
    
    # Drop rows with NaN values (from lag features)
    df_clean = df_features.dropna()
    
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
    
    # Train Ridge Regression model with higher regularization to prevent overfitting
    model = Ridge(alpha=10.0)
    model.fit(X_scaled, y)
    
    # Calculate bounds for sanity checking (more conservative)
    historical_median = df_clean['cost'].median()
    historical_mean = df_clean['cost'].mean()
    historical_std = df_clean['cost'].std()
    
    # Use median as baseline for bounds (more robust than mean)
    max_reasonable = historical_median + 1.5 * historical_std
    min_reasonable = max(0, historical_median - 1.5 * historical_std)
    
    print(f"Historical: median=${historical_median:.2f}, mean=${historical_mean:.2f}, std=${historical_std:.2f}", file=sys.stderr)
    print(f"Forecast bounds: ${min_reasonable:.2f} to ${max_reasonable:.2f}", file=sys.stderr)
    
    # Generate future predictions
    forecasts = []
    last_known = df_clean.iloc[-1].copy()
    
    # Keep track of recent actual values for lag features
    recent_values = list(df_clean['cost'].tail(14).values)
    
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
        
        # Add lag features - use historical median for missing values
        for lag in [1, 2, 3, 7]:
            if lag <= len(forecasts):
                # Use recent predictions, but cap them
                features[f'lag_{lag}'] = min(forecasts[-lag], max_reasonable)
            else:
                # Use historical data
                idx = -(lag - len(forecasts))
                if idx >= -len(recent_values):
                    features[f'lag_{lag}'] = recent_values[idx]
                else:
                    features[f'lag_{lag}'] = historical_median
        
        # Add rolling statistics using historical median as baseline
        all_recent = recent_values + forecasts
        recent_window = all_recent[-7:]
        
        features['rolling_median_7'] = np.median(recent_window) if len(recent_window) >= 3 else historical_median
        features['rolling_mean_7'] = np.mean(recent_window) if recent_window else historical_mean
        features['rolling_std_7'] = np.std(recent_window) if len(recent_window) >= 3 else historical_std
        
        # Create feature array in correct order
        X_future = np.array([[features.get(col, 0) for col in feature_cols]])
        X_future_scaled = scaler.transform(X_future)
        
        # Predict
        pred = model.predict(X_future_scaled)[0]
        
        # Apply sanity checks and constraints
        pred = max(min_reasonable, min(pred, max_reasonable))
        
        # Additional damping for ALL forecasts (prevent drift from start)
        if i > 0:
            # Gradually blend with historical median for stability
            # Start at 20% blend, increase to 50% by end of forecast period
            blend_factor = 0.2 + (i / forecast_days) * 0.3
            pred = pred * (1 - blend_factor) + historical_median * blend_factor
        
        forecasts.append(pred)
    
    return forecasts

def calculate_confidence_intervals(historical_costs, forecasts, confidence=0.95):
    """
    Calculate confidence intervals based on historical variance
    """
    # Calculate historical standard deviation using robust method
    historical_median = np.median(historical_costs)
    mad = np.median(np.abs(historical_costs - historical_median))
    historical_std = mad * 1.4826  # Robust estimate of std
    
    # Z-score for 95% confidence interval
    z_score = 1.96 if confidence == 0.95 else 1.645
    
    intervals = []
    for i, forecast in enumerate(forecasts):
        # Increase uncertainty over time
        time_factor = 1 + (i * 0.03)  # 3% increase per day
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
    
    # Cap unrealistic changes
    if abs(change_pct) > 200:
        change_pct = 200 if change_pct > 0 else -200
    
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
    Main forecasting function with improved robustness
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
        historical_median = df['cost'].median()
        if historical_median < 0.01:
            return {
                'success': False,
                'error': 'Insufficient cost data (historical median is zero or near-zero)',
                'forecasts': [],
                'recommendations': [],
            }
        
        # Generate forecast
        forecast_values = ml_forecast(df, forecast_days)
        
        # Validate forecast results
        historical_mean = df['cost'].mean()
        forecast_mean = np.mean(forecast_values)
        
        # Sanity check: forecast shouldn't be more than 5x historical mean
        if forecast_mean > historical_mean * 5:
            print(f"Warning: Forecast mean ({forecast_mean:.2f}) is unrealistically high. Using fallback method.", file=sys.stderr)
            forecast_values = exponential_smoothing_forecast(df, forecast_days=forecast_days)
            forecast_mean = np.mean(forecast_values)
        
        # Calculate confidence intervals
        confidence_intervals = calculate_confidence_intervals(df['cost'].values, forecast_values)
        
        # Generate forecast data points
        last_date = df['date'].max()
        forecasts = []
        
        for i, (cost, interval) in enumerate(zip(forecast_values, confidence_intervals)):
            forecast_date = last_date + timedelta(days=i+1)
            forecasts.append({
                'date': forecast_date.strftime('%Y-%m-%d'),
                'cost': float(cost),
                'lowerBound': float(interval['lower']),
                'upperBound': float(interval['upper']),
            })
        
        # Calculate metrics
        # Use in-sample prediction for MAPE calculation
        df_for_mape = create_lag_features(remove_outliers(df.copy()))
        df_mape = df_for_mape.dropna()
        
        if len(df_mape) >= 10:
            feature_cols = [col for col in df_mape.columns if col not in ['date', 'cost', 'services']]
            X_mape = df_mape[feature_cols].values
            y_mape = df_mape['cost'].values
            
            scaler_mape = StandardScaler()
            X_scaled_mape = scaler_mape.fit_transform(X_mape)
            
            model_mape = Ridge(alpha=10.0)
            model_mape.fit(X_scaled_mape, y_mape)
            
            predictions_mape = model_mape.predict(X_scaled_mape)
            mape = mean_absolute_percentage_error(y_mape, predictions_mape) * 100
        else:
            mape = 15.0  # Default estimate
        
        # Generate recommendations
        recommendations = generate_budget_recommendations(historical_mean, forecast_mean)
        
        return {
            'success': True,
            'forecasts': forecasts,
            'metrics': {
                'mape': float(min(mape, 100)),  # Cap at 100%
                'historical_avg': float(historical_mean),
                'forecast_avg': float(forecast_mean),
            },
            'recommendations': recommendations,
        }
        
    except Exception as e:
        print(f"Error in forecast_costs: {str(e)}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return {
            'success': False,
            'error': f'Forecasting error: {str(e)}',
            'forecasts': [],
            'recommendations': [],
        }

if __name__ == '__main__':
    try:
        # Read input from stdin
        input_data = json.loads(sys.stdin.read())
        
        cost_data = input_data.get('costData', {})
        forecast_days = input_data.get('days', 30)
        
        result = forecast_costs(cost_data, forecast_days)
        print(json.dumps(result))
        
    except Exception as e:
        print(f"Fatal error: {str(e)}", file=sys.stderr)
        error_result = {
            'success': False,
            'error': f'Fatal error: {str(e)}',
            'forecasts': [],
            'recommendations': [],
        }
        print(json.dumps(error_result))
        sys.exit(1)
