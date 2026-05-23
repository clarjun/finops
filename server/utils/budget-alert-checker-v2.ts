/**
 * Budget Alert Checker V2 - Direct Notifications from Budgets
 * Sends email and webhook notifications directly from budget configuration
 * No dependency on alert_rules table
 */

import { storage } from "../storage";
import { EmailService } from "../email-service";
import type { CloudProvider } from "@shared/schema";
import { getServiceCost } from "./live-cost-fetcher";

interface CheckResults {
  checked: number;
  alerted: number;
  errors: string[];
}

/**
 * Calculate date range - ALWAYS month-to-date
 * The budget period (daily/weekly/monthly) defines how often to check,
 * but we ALWAYS calculate costs from 1st of month to today
 */
function getMonthToDateRange(): { startDate: Date; endDate: Date } {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(1);  // First day of current month
  startDate.setHours(0, 0, 0, 0);
  
  return { startDate, endDate };
}

/**
 * Send webhook notification (Teams/Slack)
 */
async function sendWebhookNotification(
  webhookUrl: string,
  title: string,
  currentCost: number,
  threshold: number,
  provider?: string,
  serviceName?: string,
  period?: string,
  percentage?: number,
  thresholdPercentage?: number
): Promise<boolean> {
  try {
    // Add api-version parameter if not present (for Power Automate webhooks)
    let url = webhookUrl;
    if (url.includes('logic.azure.com') && !url.includes('api-version=')) {
      const separator = url.includes('?') ? '&' : '?';
      url = `${url}${separator}api-version=2024-10-01`;
    }
    
    // Teams Incoming Webhook format (MessageCard schema)
    const payload = {
      "@type": "MessageCard",
      "@context": "https://schema.org/extensions",
      "summary": `Cost Alert: ${title}`,
      "themeColor": percentage && percentage >= 100 ? "FF0000" : percentage && percentage >= 75 ? "FFA500" : "FFFF00",
      "title": `🚨 ${title}`,
      "sections": [{
        "activityTitle": "Budget Alert Triggered",
        "activitySubtitle": `${period || 'Current'} spending ${thresholdPercentage ? `reached ${thresholdPercentage}% threshold` : 'exceeded budget'}`,
        "facts": [
          { "name": "Current Cost:", "value": `$${currentCost.toFixed(2)}` },
          { "name": "Budget Amount:", "value": `$${threshold.toFixed(2)}` },
          ...(percentage ? [{ "name": "Usage:", "value": `${percentage.toFixed(1)}%` }] : []),
          ...(thresholdPercentage ? [{ "name": "Threshold:", "value": `${thresholdPercentage}%` }] : []),
          { "name": "Exceeded By:", "value": `$${(currentCost - threshold).toFixed(2)}` },
          ...(provider ? [{ "name": "Provider:", "value": provider.toUpperCase() }] : []),
          ...(serviceName ? [{ "name": "Service:", "value": serviceName }] : []),
          ...(period ? [{ "name": "Period:", "value": period.charAt(0).toUpperCase() + period.slice(1) }] : [])
        ],
        "markdown": true
      }]
    };
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Budget Checker] Webhook failed:`, errorText);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`[Budget Checker] Webhook error:`, error);
    return false;
  }
}

/**
 * Check all active budgets and trigger alerts as needed
 */
export async function checkBudgetAlerts(): Promise<CheckResults> {
  const results: CheckResults = {
    checked: 0,
    alerted: 0,
    errors: []
  };

  try {
    // Get all active budgets
    const budgets = await storage.getActiveBudgets();
    results.checked = budgets.length;
    
    console.log(`[Budget Checker V2] Checking ${budgets.length} budgets...`);

    for (const budget of budgets) {
      try {
        console.log(`[Budget Checker V2] Checking budget: ${budget.budgetName}`);
        
        // ALWAYS use month-to-date (1st of current month to today)
        // This matches the frontend dropdown and real cloud costs
        // The budget period (daily/weekly/monthly) defines how often to CHECK,
        // but we always calculate costs for the current month
        const { startDate, endDate } = getMonthToDateRange();
        
        console.log(`[Budget Checker V2] Period: ${budget.period} (check frequency)`);
        console.log(`[Budget Checker V2] Date range (MONTH-TO-DATE): ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
        // Fetch live cost data for this budget's criteria
        const currentCost = await getServiceCost(
          budget.provider as CloudProvider | undefined,
          budget.serviceName || undefined,
          budget.accountId || undefined,
          startDate,
          endDate
        );

        const budgetAmount = parseFloat(budget.amount);
        const percentage = (currentCost / budgetAmount) * 100;

        console.log(`[Budget Checker V2] Budget "${budget.budgetName}": Current cost = $${currentCost.toFixed(2)}, Budget = $${budgetAmount.toFixed(2)}, Usage = ${percentage.toFixed(1)}%`);

        // Check alert thresholds
        const alertThresholds = (budget.alertThresholds as Record<string, boolean> | null) || {};
        const triggeredThresholds: number[] = [];

        // Find all enabled thresholds that are exceeded
        for (const [thresholdStr, enabled] of Object.entries(alertThresholds)) {
          if (enabled) {
            const threshold = parseInt(thresholdStr);
            if (percentage >= threshold) {
              triggeredThresholds.push(threshold);
            }
          }
        }

        // Sort thresholds in descending order to get the highest exceeded threshold
        triggeredThresholds.sort((a, b) => b - a);
        const highestTriggeredThreshold = triggeredThresholds[0];

        // Check if we should send an alert
        // Only send if:
        // 1. A threshold is triggered
        // 2. It's a higher threshold than the last one we alerted for
        // 3. OR it's been more than 1 hour since last alert (for same threshold)
        const shouldAlert = highestTriggeredThreshold && (
          !budget.lastAlertedThreshold || 
          highestTriggeredThreshold > budget.lastAlertedThreshold ||
          !budget.lastAlertedAt ||
          (Date.now() - new Date(budget.lastAlertedAt).getTime()) > 3600000 // 1 hour
        );

        if (shouldAlert) {
          console.log(`[Budget Checker V2] ✓ Budget alert triggered: ${highestTriggeredThreshold}% threshold exceeded`);
          
          let alertSent = false;

          // Send email notification if configured
          if (budget.emailRecipients) {
            const emails = budget.emailRecipients.split(',').map(e => e.trim()).filter(e => e);
            
            if (emails.length > 0) {
              console.log(`[Budget Checker V2] Sending email to: ${emails.join(', ')}`);
              
              const emailService = new EmailService();
              const success = await emailService.sendCostAlert({
                to: emails,
                ruleName: `Budget Alert: ${budget.budgetName}`,
                currentCost,
                threshold: budgetAmount,
                period: budget.period,
                percentage: percentage.toFixed(1),
                thresholdPercentage: highestTriggeredThreshold,
              });
              
              if (success) {
                console.log(`[Budget Checker V2] ✓ Email sent successfully`);
                alertSent = true;
                results.alerted++;
              } else {
                console.error(`[Budget Checker V2] ✗ Failed to send email`);
                results.errors.push(`Failed to send email for budget: ${budget.budgetName}`);
              }
            }
          }

          // Send webhook notification if configured
          if (budget.webhookUrl) {
            console.log(`[Budget Checker V2] Sending webhook notification`);
            
            const webhookSuccess = await sendWebhookNotification(
              budget.webhookUrl,
              `Budget Alert: ${budget.budgetName} (${highestTriggeredThreshold}% threshold)`,
              currentCost,
              budgetAmount,
              budget.provider || 'All Providers',
              budget.serviceName || 'All Services',
              budget.period,
              percentage,
              highestTriggeredThreshold
            );

            if (webhookSuccess) {
              console.log(`[Budget Checker V2] ✓ Webhook sent successfully`);
              alertSent = true;
            } else {
              console.error(`[Budget Checker V2] ✗ Webhook failed`);
              results.errors.push(`Webhook failed for budget: ${budget.budgetName}`);
            }
          }

          // Update last alerted timestamp and threshold if alert was sent
          if (alertSent) {
            try {
              await storage.updateBudget(budget.id, {
                lastAlertedAt: new Date(),
                lastAlertedThreshold: highestTriggeredThreshold,
              });
              console.log(`[Budget Checker V2] Updated last alert tracking for budget ${budget.id}`);
            } catch (error) {
              console.error(`[Budget Checker V2] Failed to update alert tracking:`, error);
            }
          }

          // Log if no notification method is configured
          if (!budget.emailRecipients && !budget.webhookUrl) {
            console.log(`[Budget Checker V2] ⚠ No notification methods configured for budget: ${budget.budgetName}`);
          }
        } else if (triggeredThresholds.length > 0) {
          console.log(`[Budget Checker V2] ✗ Alert not sent (already alerted for ${budget.lastAlertedThreshold}% threshold)`);
        } else {
          console.log(`[Budget Checker V2] ✗ No thresholds exceeded`);
        }
      } catch (error) {
        const errorMsg = `Error checking budget "${budget.budgetName}": ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error(`[Budget Checker V2] ${errorMsg}`);
        results.errors.push(errorMsg);
      }
    }

    return results;
  } catch (error) {
    const errorMsg = `Error in budget checker: ${error instanceof Error ? error.message : 'Unknown error'}`;
    console.error(`[Budget Checker V2] ${errorMsg}`);
    results.errors.push(errorMsg);
    return results;
  }
}
