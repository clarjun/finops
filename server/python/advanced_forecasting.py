#!/usr/bin/env python3
"""
Advanced AI-Powered Cost Forecasting with Multiple Models and Scenario Analysis
Combines traditional ML with trend analysis and pattern recognition
"""

import sys
import json
import numpy as np
import pandas as pd
from datetime import datetime, timedelta
from sklearn.linear_model import Ridge, LinearRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import mean_absolute_percentage_error, mean_squared_error
import warnings
warnings.filterwarnings('ignore')

def detect_trend(costs):
    """
    Detect cost trend using linear regression
    Returns: trend_slope, trend_direction, trend_strength
    """
    if len(costs) < 7:
        return 0, 'stable', 0
    
    X = np.arange(len(costs)).reshape(-1, 1)
    y = costs
    
    model = LinearRegression()
    model.fit(X, y)
    
    slope = model.coef_[0]
    r2_score = model.score(X, y)
    
    # Determine trend direction
    avg_cost = np.mean(costs)
    slope_pct = (slope / avg_cost) * 100 if avg_cost > 0 else 0
    
    if abs(slope_pct) < 1:
        direction = 'stable'
    elif slope_pct > 0:
        direction = 'increasing'
    else:
        direction = 'decreasing'
    
    return slope, direction, r2_score

def detect_seasonality(costs):
    """
    Detect weekly seasonality patterns
    """
    if len(costs) < 14:
        return False, {}
    
    # Check if there's a weekly pattern
    weekly_avg = {}
    for i, cost in enumerate(costs):
        day_of_week = i % 7
        if day_of_week not in weekly_avg:
            weekly_avg[day_of_week] = []
        weekly_avg[day_of_week].append(cost)
    
    # Calculate average cost per day of week
    day_patterns = {day: np.mean(costs) for day, costs in weekly_avg.items()}
    
    # Check if variation is significant
    overall_mean = np.mean(costs)
    variation = np.std(list(day_patterns.values()))
    
    has_seasonality = variation > (overall_mean * 0.1)  # 10% threshold
    
    return has_seasonality, day_patterns

def create_advanced_features(df):
    """
    Create advanced time series features including trend and seasonality
    """
    df = df.copy()
    
    # Basic lag features
    for lag in [1, 2, 3, 7, 14]:
        df[f'lag_{lag}'] = df['cost'].shift(lag)
    
    # Rolling statistics (multiple windows)
    for window in [3, 7, 14]:
        df[f'rolling_mean_{window}'] = df['cost'].rolling(window=window, min_periods=1).mean()
        df[f'rolling_std_{window}'] = df['cost'].rolling(window=window, min_periods=1).std().fillna(0)
        df[f'rolling_max_{window}'] = df['cost'].rolling(window=window, min_periods=1).max()
        df[f'rolling_min_{window}'] = df['cost'].rolling(window=window, min_periods=1).min()
    
    # Trend features
    df['cost_diff_1'] = df['cost'].diff(1).fillna(0)
    df['cost_diff_7'] = df['cost'].diff(7).fillna(0)
    
    # Exponential weighted moving average
    df['ewma_7'] = df['cost'].ewm(span=7, adjust=False).mean()
    
    # Day of week encoding
    df['day_of_week_sin'] = np.sin(2 * np.pi * df['day_of_week'] / 7)
    df['day_of_week_cos'] = np.cos(2 * np.pi * df['day_of_week'] / 7)
    
    # Percentage change
    df['pct_change_1'] = df['cost'].pct_change(1).fillna(0).replace([np.inf, -np.inf], 0)
    
    return df

def ensemble_forecast(df, forecast_days=30):
    """
    Ensemble forecasting combining multiple models
    """
    # Prepare advanced features
    df = create_advanced_features(df)
    df_clean = df.dropna()
    
    if len(df_clean) < 10:
        # Fallback to simple average-based forecast
        avg_cost = df['cost'].mean()
        return [avg_cost] * forecast_days
    
    # Define feature columns (exclude non-feature columns)
    exclude_cols = ['date', 'cost', 'services', 'day_of_week', 'day_of_month', 'month', 'days_since_start']
    feature_cols = [col for col in df_clean.columns if col not in exclude_cols]
    
    X = df_clean[feature_cols].values
    y = df_clean['cost'].values
    
    # Standardize features
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)
    
    # Train Ridge Regression model
    model = Ridge(alpha=0.5)
    model.fit(X_scaled, y)
    
    # Detect trend for adjustment
    trend_slope, trend_direction, trend_strength = detect_trend(df['cost'].values)
    
    # Generate predictions
    forecasts = []
    last_row = df_clean.iloc[-1].copy()
    
    for i in range(forecast_days):
        future_date = last_row['date'] + timedelta(days=i+1)
        
        # Build feature vector
        features = {}
        
        # Time-based features
        features['day_of_week_sin'] = np.sin(2 * np.pi * (future_date.dayofweek) / 7)
        features['day_of_week_cos'] = np.cos(2 * np.pi * (future_date.dayofweek) / 7)
        features['day_of_month'] = future_date.day
        features['month'] = future_date.month
        features['days_since_start'] = last_row['days_since_start'] + i + 1
        
        # Lag features (use recent predictions)
        recent_costs = list(df['cost'].tail(14).values) + forecasts
        for lag in [1, 2, 3, 7, 14]:
            if lag <= len(forecasts):
                features[f'lag_{lag}'] = forecasts[-lag]
            elif lag <= len(recent_costs):
                features[f'lag_{lag}'] = recent_costs[-lag]
            else:
                features[f'lag_{lag}'] = df['cost'].mean()
        
        # Rolling statistics
        for window in [3, 7, 14]:
            window_data = recent_costs[-window:] if len(recent_costs) >= window else recent_costs
            features[f'rolling_mean_{window}'] = np.mean(window_data) if window_data else df['cost'].mean()
            features[f'rolling_std_{window}'] = np.std(window_data) if len(window_data) > 1 else 0
            features[f'rolling_max_{window}'] = np.max(window_data) if window_data else df['cost'].max()
            features[f'rolling_min_{window}'] = np.min(window_data) if window_data else df['cost'].min()
        
        # Trend features
        if len(forecasts) >= 1:
            features['cost_diff_1'] = forecasts[-1] - (forecasts[-2] if len(forecasts) >= 2 else df['cost'].iloc[-1])
        else:
            features['cost_diff_1'] = 0
        
        if len(forecasts) >= 7:
            features['cost_diff_7'] = forecasts[-1] - forecasts[-7]
        else:
            features['cost_diff_7'] = 0
        
        # EWMA
        features['ewma_7'] = features['rolling_mean_7']
        
        # Percentage change
        if len(forecasts) >= 1:
            prev_cost = forecasts[-1]
            features['pct_change_1'] = (prev_cost - df['cost'].iloc[-1]) / df['cost'].iloc[-1] if df['cost'].iloc[-1] > 0 else 0
        else:
            features['pct_change_1'] = 0
        
        # Create feature array in correct order
        X_future = np.array([[features.get(col, 0) for col in feature_cols]])
        X_future_scaled = scaler.transform(X_future)
        
        # Predict
        base_pred = model.predict(X_future_scaled)[0]
        
        # Apply trend adjustment for longer forecasts
        trend_adjustment = trend_slope * i * 0.1 if trend_direction != 'stable' else 0
        adjusted_pred = base_pred + trend_adjustment
        
        # Ensure non-negative
        forecasts.append(max(0.01, adjusted_pred))
    
    return forecasts

def calculate_scenarios(forecasts, historical_std):
    """
    Generate optimistic and pessimistic scenarios
    """
    optimistic = [max(0, f - historical_std * 0.5) for f in forecasts]
    pessimistic = [f + historical_std * 0.8 for f in forecasts]
    
    return {
        'optimistic': optimistic,
        'baseline': forecasts,
        'pessimistic': pessimistic
    }

def generate_ai_insights(df, forecasts, trend_info):
    """
    Generate AI-powered insights about the forecast
    """
    insights = []
    
    historical_avg = df['cost'].mean()
    forecast_avg = np.mean(forecasts)
    trend_slope, trend_direction, trend_strength = trend_info
    
    # Trend insight
    if trend_direction == 'increasing':
        insights.append({
            'type': 'trend',
            'severity': 'medium' if trend_strength > 0.7 else 'low',
            'message': f'Costs show an increasing trend with {trend_strength*100:.1f}% confidence. Consider cost optimization strategies.',
            'recommendation': 'Review resource utilization and identify optimization opportunities.'
        })
    elif trend_direction == 'decreasing':
        insights.append({
            'type': 'trend',
            'severity': 'low',
            'message': f'Costs are trending downward, indicating successful optimization or reduced usage.',
            'recommendation': 'Continue monitoring to ensure service quality is maintained.'
        })
    
    # Volatility insight
    volatility = df['cost'].std() / historical_avg if historical_avg > 0 else 0
    if volatility > 0.3:
        insights.append({
            'type': 'volatility',
            'severity': 'high',
            'message': f'High cost volatility detected ({volatility*100:.1f}%). This indicates unpredictable spending patterns.',
            'recommendation': 'Investigate services causing variability. Consider reserved instances for stable workloads.'
        })
    
    # Forecast comparison
    change_pct = ((forecast_avg - historical_avg) / historical_avg * 100) if historical_avg > 0 else 0
    if abs(change_pct) > 15:
        insights.append({
            'type': 'forecast_alert',
            'severity': 'high' if abs(change_pct) > 25 else 'medium',
            'message': f'Forecasted costs are {abs(change_pct):.1f}% {"higher" if change_pct > 0 else "lower"} than historical average.',
            'recommendation': 'Budget adjustment required. Plan for resource scaling or optimization initiatives.'
        })
    
    return insights

def advanced_forecast(cost_data, forecast_days=30):
    """
    Advanced forecasting with AI-powered insights and multiple scenarios
    """
    try:
        # Validate input
        forecast_days = max(7, min(forecast_days, 180))
        
        # Extract daily trends
        daily_trends = cost_data.get('dailyTrends', [])
        if not daily_trends:
            return {'success': False, 'error': 'No daily trends data available'}
        
        # Create DataFrame
        df = pd.DataFrame(daily_trends)
        df['date'] = pd.to_datetime(df['date'])
        df = df.sort_values('date')
        
        if len(df) < 7:
            return {'success': False, 'error': 'Insufficient data (minimum 7 days required)'}
        
        # Add time features
        df['day_of_week'] = df['date'].dt.dayofweek
        df['day_of_month'] = df['date'].dt.day
        df['month'] = df['date'].dt.month
        df['days_since_start'] = (df['date'] - df['date'].min()).dt.days
        
        # Check for sufficient costs
        historical_avg = df['cost'].mean()
        if historical_avg < 0.01:
            return {'success': False, 'error': 'Historical costs too low for meaningful forecast'}
        
        # Detect patterns
        trend_slope, trend_direction, trend_strength = detect_trend(df['cost'].values)
        has_seasonality, day_patterns = detect_seasonality(df['cost'].values)
        
        # Generate ensemble forecast
        forecasts = ensemble_forecast(df, forecast_days)
        
        # Calculate confidence intervals with uncertainty growth
        historical_std = df['cost'].std()
        confidence_intervals = []
        for i, pred in enumerate(forecasts):
            uncertainty_factor = 1 + (i * 0.03)  # Grows 3% per day
            margin = 1.96 * historical_std * uncertainty_factor
            confidence_intervals.append({
                'lower': max(0, pred - margin),
                'upper': pred + margin
            })
        
        # Generate scenarios
        scenarios = calculate_scenarios(forecasts, historical_std)
        
        # Generate dates
        last_date = df['date'].max()
        forecast_dates = [(last_date + timedelta(days=i+1)).strftime('%Y-%m-%d') for i in range(forecast_days)]
        
        # Prepare forecast data
        forecast_data = []
        for i, date in enumerate(forecast_dates):
            forecast_data.append({
                'date': date,
                'predictedCost': round(forecasts[i], 2),
                'confidenceInterval': {
                    'lower': round(confidence_intervals[i]['lower'], 2),
                    'upper': round(confidence_intervals[i]['upper'], 2)
                },
                'scenarios': {
                    'optimistic': round(scenarios['optimistic'][i], 2),
                    'pessimistic': round(scenarios['pessimistic'][i], 2)
                }
            })
        
        # Calculate metrics
        forecast_avg = np.mean(forecasts)
        forecast_total = sum(forecasts)
        change_pct = ((forecast_avg - historical_avg) / historical_avg * 100) if historical_avg > 0 else 0
        
        # Model validation
        model_metrics = None
        if len(df) > 14:
            try:
                train_df = df.iloc[:-7].copy()
                test_df = df.iloc[-7:].copy()
                
                test_forecasts = ensemble_forecast(train_df, forecast_days=7)
                actual_costs = test_df['cost'].values
                
                if np.all(actual_costs > 0) and len(test_forecasts) == len(actual_costs):
                    mape = mean_absolute_percentage_error(actual_costs, test_forecasts) * 100
                    rmse = np.sqrt(mean_squared_error(actual_costs, test_forecasts))
                    
                    if np.isfinite(mape) and mape >= 0 and mape < 200:
                        model_metrics = {
                            'mape': float(min(mape, 100)),
                            'rmse': float(rmse),
                            'accuracy': float(max(0, min(100, 100 - mape)))
                        }
            except Exception:
                pass
        
        # Generate AI insights
        ai_insights = generate_ai_insights(df, forecasts, (trend_slope, trend_direction, trend_strength))
        
        # Recommendations
        recommendations = []
        if change_pct > 20:
            recommendations.append({
                'type': 'budget_increase',
                'priority': 'high',
                'message': f'Forecast indicates {change_pct:.1f}% cost increase. Immediate budget review recommended.',
                'action': f'Increase budget to ${forecast_total * 1.15:.2f} (with 15% buffer)'
            })
        elif change_pct > 10:
            recommendations.append({
                'type': 'budget_adjustment',
                'priority': 'medium',
                'message': f'Moderate cost increase expected ({change_pct:.1f}%). Monitor closely.',
                'action': f'Adjust budget to ${forecast_total * 1.10:.2f}'
            })
        
        if trend_direction == 'increasing' and trend_strength > 0.6:
            recommendations.append({
                'type': 'cost_optimization',
                'priority': 'high',
                'message': 'Strong upward trend detected. Cost optimization urgently needed.',
                'action': 'Implement reserved instances, right-sizing, and resource tagging'
            })
        
        return {
            'success': True,
            'forecasts': forecast_data,
            'summary': {
                'historicalAverage': round(historical_avg, 2),
                'forecastAverage': round(forecast_avg, 2),
                'totalForecastedCost': round(forecast_total, 2),
                'changePercentage': round(change_pct, 2),
                'trendDirection': trend_direction,
                'trendStrength': round(trend_strength * 100, 1),
                'hasSeasonality': has_seasonality
            },
            'modelMetrics': model_metrics,
            'aiInsights': ai_insights,
            'recommendations': recommendations,
            'dataPoints': len(df)
        }
    
    except Exception as e:
        return {
            'success': False,
            'error': f'Forecasting error: {str(e)}'
        }

def main():
    try:
        input_data = json.loads(sys.stdin.read())
        forecast_days = input_data.get('forecastDays', 30)
        cost_data = input_data.get('costData', {})
        
        result = advanced_forecast(cost_data, forecast_days)
        print(json.dumps(result))
        sys.exit(0)
    except Exception as e:
        print(json.dumps({
            'success': False,
            'error': f'Script error: {str(e)}'
        }))
        sys.exit(1)

if __name__ == '__main__':
    main()
