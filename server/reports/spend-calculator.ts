/**
 * Spend Calculator
 * Calculates total spend, forecast, and budget tracking
 */

import { CloudSpendOverview } from './types';
import { fetchAWSBudgets, fetchAWSCostForecast } from '../aws-client';

export async function calculateSpendOverview(
  provider: 'aws' | 'azure' | 'gcp',
  currentMonthCosts: Array<{ date: string; cost: number }>,
  potentialSavings: number,
  dateRange?: { startDate: Date; endDate: Date }
): Promise<CloudSpendOverview> {
  console.log(`[Spend Calculator] Calculating overview for ${provider}`);
  
  // Calculate MTD (Month-to-Date) spend
  const totalSpendMTD = currentMonthCosts.reduce((sum, day) => sum + day.cost, 0);
  
  // Calculate days into month and total days in month
  const now = new Date();
  const daysIntoMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  
  // Check if date range is single month
  const isSingleMonth = dateRange ? 
    dateRange.startDate.getMonth() === dateRange.endDate.getMonth() &&
    dateRange.startDate.getFullYear() === dateRange.endDate.getFullYear() : true;
  
  // Check if date range is current month
  const isCurrentMonth = dateRange ?
    dateRange.startDate.getMonth() === now.getMonth() &&
    dateRange.startDate.getFullYear() === now.getFullYear() : true;
  
  let forecastMonthEnd = 0;
  let budget: number | undefined;
  let budgetUtilization: number | undefined;
  let budgetUnavailableReason: string | undefined;
  let finalPotentialSavings: number | undefined;
  
  // Only fetch budget and forecast for single-month, current-month ranges
  if (isSingleMonth && isCurrentMonth) {
    // Fetch forecast from AWS API
    if (provider === 'aws') {
      try {
        // Get forecast for rest of the month
        const today = new Date().toISOString().split('T')[0];
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
        
        const forecastAmount = await fetchAWSCostForecast(today, endOfMonth);
        
        if (forecastAmount > 0) {
          // Add current spend to forecast
          forecastMonthEnd = forecastAmount;
        } else {
          // Fallback to linear projection
          const dailyAverage = totalSpendMTD / daysIntoMonth;
          forecastMonthEnd = dailyAverage * daysInMonth;
        }
        
        // Fetch budget from AWS Budgets API
        budget = await fetchAWSBudgets();
        
        if (budget > 0) {
          budgetUtilization = (totalSpendMTD / budget) * 100;
          finalPotentialSavings = potentialSavings;
        }
      } catch (error) {
        console.error('[Spend Calculator] Error fetching AWS budget/forecast:', error);
        // Fallback to linear projection
        const dailyAverage = totalSpendMTD / daysIntoMonth;
        forecastMonthEnd = dailyAverage * daysInMonth;
      }
    } else {
      // For Azure/GCP, use linear projection
      const dailyAverage = totalSpendMTD / daysIntoMonth;
      forecastMonthEnd = dailyAverage * daysInMonth;
      
      // Budget not available for Azure/GCP yet
      budgetUnavailableReason = `Budget tracking not yet implemented for ${provider.toUpperCase()}`;
    }
  } else {
    // Multi-month or non-current month range
    if (!isSingleMonth) {
      budgetUnavailableReason = "Budget comparison available only for single-month range";
    } else if (!isCurrentMonth) {
      budgetUnavailableReason = "Budget comparison available only for current month";
    }
    
    // Still calculate forecast using linear projection
    const dailyAverage = totalSpendMTD / daysIntoMonth;
    forecastMonthEnd = dailyAverage * daysInMonth;
  }
  
  console.log(`[Spend Calculator] MTD: ${totalSpendMTD.toFixed(2)}, Forecast: ${forecastMonthEnd.toFixed(2)}`);
  if (budget !== undefined) {
    console.log(`[Spend Calculator] Budget: ${budget.toFixed(2)}, Utilization: ${budgetUtilization?.toFixed(2)}%`);
  }
  
  return {
    totalSpendMTD,
    forecastMonthEnd,
    budget,
    potentialSavings: finalPotentialSavings,
    budgetUtilization,
    daysIntoMonth,
    daysInMonth,
    budgetUnavailableReason,
  };
}
