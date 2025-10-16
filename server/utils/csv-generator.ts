// CSV Generation Utilities for Cost Data Export

interface CsvRow {
  [key: string]: string | number | null | undefined;
}

/**
 * Converts data array to CSV format
 */
export function generateCSV(data: CsvRow[], headers: string[]): string {
  if (data.length === 0) {
    return headers.join(',');
  }

  const csvRows: string[] = [];
  
  // Add header row
  csvRows.push(headers.join(','));
  
  // Add data rows
  for (const row of data) {
    const values = headers.map(header => {
      const value = row[header];
      if (value === null || value === undefined) {
        return '';
      }
      
      // Escape values containing comma, quotes, or newlines
      const stringValue = String(value);
      if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
        return `"${stringValue.replace(/"/g, '""')}"`;
      }
      
      return stringValue;
    });
    
    csvRows.push(values.join(','));
  }
  
  return csvRows.join('\n');
}

/**
 * Generates CSV for cost history data
 */
export function generateCostHistoryCSV(costData: any): string {
  const headers = ['Date', 'Service', 'Cost', 'Subscription', 'Resource Group'];
  
  const rows = costData.dailyTrends.flatMap((day: any) => {
    return Object.entries(day.services).map(([service, cost]) => ({
      Date: day.date,
      Service: service,
      Cost: cost,
      Subscription: costData.subscriptions?.[0] || 'N/A',
      'Resource Group': 'All'
    }));
  });
  
  return generateCSV(rows, headers);
}

/**
 * Generates CSV for service breakdown
 */
export function generateServiceBreakdownCSV(costData: any): string {
  const headers = ['Service Name', 'Total Cost', 'Percentage', 'Average Daily'];
  
  const rows = costData.serviceBreakdown.map((service: any) => ({
    'Service Name': service.name,
    'Total Cost': service.cost.toFixed(2),
    'Percentage': service.percentage.toFixed(2) + '%',
    'Average Daily': (service.cost / costData.dailyTrends.length).toFixed(2)
  }));
  
  return generateCSV(rows, headers);
}

/**
 * Generates CSV for anomaly detection results
 */
export function generateAnomaliesCSV(anomalies: any[]): string {
  const headers = ['Date', 'Cost', 'Type', 'Severity', 'Description', 'Service'];
  
  const rows = anomalies.map((anomaly: any) => ({
    Date: anomaly.date,
    Cost: anomaly.cost.toFixed(2),
    Type: anomaly.type,
    Severity: anomaly.severity,
    Description: anomaly.description,
    Service: anomaly.service || 'All Services'
  }));
  
  return generateCSV(rows, headers);
}

/**
 * Generates CSV for forecast data
 */
export function generateForecastCSV(forecasts: any[]): string {
  const headers = ['Date', 'Predicted Cost', 'Lower Bound', 'Upper Bound', 'Confidence Interval'];
  
  const rows = forecasts.map((forecast: any) => ({
    Date: forecast.date,
    'Predicted Cost': forecast.predictedCost?.toFixed(2) || forecast.predicted_cost?.toFixed(2) || 'N/A',
    'Lower Bound': forecast.confidenceInterval?.lower?.toFixed(2) || forecast.confidence_interval?.lower?.toFixed(2) || 'N/A',
    'Upper Bound': forecast.confidenceInterval?.upper?.toFixed(2) || forecast.confidence_interval?.upper?.toFixed(2) || 'N/A',
    'Confidence Interval': '95%'
  }));
  
  return generateCSV(rows, headers);
}

/**
 * Generates comprehensive cost report CSV
 */
export function generateComprehensiveReportCSV(costData: any, anomalies: any[], forecasts: any[]): string {
  const sections: string[] = [];
  
  // Summary section
  sections.push('COST SUMMARY');
  sections.push(generateCSV([{
    'Total Cost': costData.totalCost.toFixed(2),
    'Average Daily Cost': costData.avgDailyCost.toFixed(2),
    'Top Service': costData.topService.name,
    'Top Service Cost': costData.topService.cost.toFixed(2),
    'Number of Services': costData.serviceCount,
    'Peak Day': costData.peakDay.date,
    'Peak Day Cost': costData.peakDay.cost.toFixed(2)
  }], ['Total Cost', 'Average Daily Cost', 'Top Service', 'Top Service Cost', 'Number of Services', 'Peak Day', 'Peak Day Cost']));
  
  sections.push(''); // Empty line
  sections.push('SERVICE BREAKDOWN');
  sections.push(generateServiceBreakdownCSV(costData));
  
  if (anomalies.length > 0) {
    sections.push('');
    sections.push('DETECTED ANOMALIES');
    sections.push(generateAnomaliesCSV(anomalies));
  }
  
  if (forecasts.length > 0) {
    sections.push('');
    sections.push('COST FORECAST');
    sections.push(generateForecastCSV(forecasts));
  }
  
  return sections.join('\n');
}
