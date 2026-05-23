/**
 * Budget and Alert Checker - Uses Live Cost Data
 * Monitors budgets and alert rules, triggers notifications when thresholds are exceeded
 * Fetches real-time cost data from cloud APIs instead of querying database
 */

import { storage } from "../storage";
import { EmailService } from "../email-service";
import type { Budget, AlertRule, CloudProvider } from "@shared/schema";
import { getServiceCost, fetchLiveCosts, aggregateCosts } from "./live-cost-fetcher";

interface CheckResults {
  checked: number;
  alerted: number;
  errors: string[];
}

/**
 * Calculate date range based on period type
 */
function getDateRangeForPeriod(period: string): { startDate: Date; endDate: Date } {
  const endDate = new Date();
  const startDate = new Date();
  
  switch (period.toLowerCase()) {
    case 'daily':
      startDate.setHours(0, 0, 0, 0);
      break;
    case 'weekly':
      const dayOfWeek = endDate.getDay();
      startDate.setDate(endDate.getDate() - dayOfWeek);
      startDate.setHours(0, 0, 0, 0);
      break;
    case 'monthly':
      startDate.setDate(1);
      startDate.setHours(0, 0, 0, 0);
      break;
    case 'quarterly':
      const quarter = Math.floor(endDate.getMonth() / 3);
      startDate.setMonth(quarter * 3, 1);
      startDate.setHours(0, 0, 0, 0);
      break;
    case 'yearly':
      startDate.setMonth(0, 1);
      startDate.setHours(0, 0, 0, 0);
      break;
    default:
      // Default to month to date
      startDate.setDate(1);
      startDate.setHours(0, 0, 0, 0);
  }
  
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
  period?: string
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
      "themeColor": "FF0000",
      "title": `🚨 Cost Alert: ${title}`,
      "sections": [{
        "activityTitle": "Cost Alert Triggered",
        "activitySubtitle": `${period || 'Current'} spending exceeded threshold`,
        "facts": [
          { "name": "Current Cost:", "value": `$${currentCost.toFixed(2)}` },
          { "name": "Threshold:", "value": `$${threshold.toFixed(2)}` },
          { "name": "Exceeded By:", "value": `$${(currentCost - threshold).toFixed(2)}` },
          ...(provider ? [{ "name": "Provider:", "value": provider }] : []),
          ...(serviceName ? [{ "name": "Service:", "value": serviceName }] : []),
          ...(period ? [{ "name": "Period:", "value": period }] : [])
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
      console.error(`[Alert Checker] Webhook failed:`, errorText);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`[Alert Checker] Webhook error:`, error);
    return false;
  }
}

/**
 * Check all active alert rules and trigger alerts as needed
 */
export async function checkAlertRules(): Promise<CheckResults> {
  const results: CheckResults = {
    checked: 0,
    alerted: 0,
    errors: []
  };

  try {
    // Get all enabled alert rules
    const alertRules = await storage.getEnabledAlertRules();
    results.checked = alertRules.length;
    
    console.log(`[Alert Checker] Checking ${alertRules.length} alert rules...`);

    for (const rule of alertRules) {
      try {
        console.log(`[Alert Checker] Checking rule: ${rule.ruleName}`);
        
        // Determine date range based on threshold type
        const { startDate, endDate } = getDateRangeForPeriod(rule.thresholdType);
        
        console.log(`[Alert Checker] Period: ${rule.thresholdType} (${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]})`);
        
        // Fetch live cost data for this rule's criteria
        const currentCost = await getServiceCost(
          rule.provider as CloudProvider | undefined,
          rule.serviceName || undefined,
          rule.accountId || undefined,
          startDate,
          endDate
        );

        console.log(`[Alert Checker] Rule "${rule.ruleName}": Current cost = $${currentCost.toFixed(2)}, Threshold = $${rule.thresholdAmount}`);

        // Check if alert should be triggered
        const threshold = parseFloat(rule.thresholdAmount.toString());
        let shouldAlert = false;

        switch (rule.comparisonOperator) {
          case 'gt':
            shouldAlert = currentCost > threshold;
            break;
          case 'gte':
            shouldAlert = currentCost >= threshold;
            break;
          case 'lt':
            shouldAlert = currentCost < threshold;
            break;
          case 'lte':
            shouldAlert = currentCost <= threshold;
            break;
          case 'eq':
            shouldAlert = Math.abs(currentCost - threshold) < 0.01;
            break;
          default:
            shouldAlert = currentCost > threshold;
        }

        if (shouldAlert) {
          console.log(`[Alert Checker] ✓ Alert triggered for rule: ${rule.ruleName}`);
          
          // Send email notifications
          if (rule.emailRecipients) {
            const emails = rule.emailRecipients.split(',').map(e => e.trim()).filter(e => e);
            console.log(`[Alert Checker] Sending email to: ${emails.join(', ')}`);
            
            if (emails.length > 0) {
              const emailService = new EmailService();
              const success = await emailService.sendCostAlert({
                to: emails,
                ruleName: rule.ruleName,
                currentCost,
                threshold,
                period: rule.thresholdType,
              });
              
              if (success) {
                console.log(`[Alert Checker] ✓ Email sent successfully`);
                results.alerted++;
              } else {
                console.error(`[Alert Checker] ✗ Failed to send email`);
                results.errors.push(`Failed to send email for rule: ${rule.ruleName}`);
              }
            }
          }

          // Send webhook notifications
          if (rule.webhookUrl) {
            console.log(`[Alert Checker] Sending webhook notification`);
            
            const webhookSuccess = await sendWebhookNotification(
              rule.webhookUrl,
              rule.ruleName,
              currentCost,
              threshold,
              rule.provider || 'All Providers',
              rule.serviceName || 'All Services',
              rule.thresholdType
            );

            if (webhookSuccess) {
              console.log(`[Alert Checker] ✓ Webhook sent successfully`);
            } else {
              console.error(`[Alert Checker] ✗ Webhook failed`);
              results.errors.push(`Webhook failed for rule: ${rule.ruleName}`);
            }
          }
        } else {
          console.log(`[Alert Checker] ✗ Alert not triggered (condition not met)`);
        }
      } catch (error) {
        const errorMsg = `Error checking alert rule "${rule.ruleName}": ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error(`[Alert Checker] ${errorMsg}`);
        results.errors.push(errorMsg);
      }
    }

    return results;
  } catch (error) {
    const errorMsg = `Error in alert rule checker: ${error instanceof Error ? error.message : 'Unknown error'}`;
    console.error(`[Alert Checker] ${errorMsg}`);
    results.errors.push(errorMsg);
    return results;
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
    
    console.log(`[Budget Checker] Checking ${budgets.length} budgets...`);

    for (const budget of budgets) {
      try {
        console.log(`[Budget Checker] Checking budget: ${budget.budgetName}`);
        
        // Determine date range based on budget period
        const { startDate, endDate } = budget.startDate && budget.endDate
          ? { startDate: new Date(budget.startDate), endDate: new Date(budget.endDate) }
          : getDateRangeForPeriod(budget.period);
        
        console.log(`[Budget Checker] Period: ${budget.period} (${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]})`);
        
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

        console.log(`[Budget Checker] Budget "${budget.budgetName}": Current cost = $${currentCost.toFixed(2)}, Budget = $${budgetAmount.toFixed(2)}, Usage = ${percentage.toFixed(1)}%`);

        // Check alert thresholds
        const alertThresholds = (budget.alertThresholds as Record<string, boolean> | null) || {};
        const triggeredThresholds: number[] = [];

        for (const [thresholdStr, enabled] of Object.entries(alertThresholds)) {
          if (enabled) {
            const threshold = parseInt(thresholdStr);
            if (percentage >= threshold) {
              triggeredThresholds.push(threshold);
            }
          }
        }

        if (triggeredThresholds.length > 0) {
          console.log(`[Budget Checker] ✓ Budget alert triggered: ${triggeredThresholds.join(', ')}% thresholds exceeded`);
          
          // Get matching alert rules for this budget
          const allAlertRules = await storage.getEnabledAlertRules();
          const matchingRules = allAlertRules.filter(rule => {
            const providerMatch = !rule.provider || !budget.provider || rule.provider === budget.provider;
            const accountMatch = !rule.accountId || !budget.accountId || rule.accountId === budget.accountId;
            const serviceMatch = !rule.serviceName || !budget.serviceName || rule.serviceName === budget.serviceName;
            return providerMatch && accountMatch && serviceMatch;
          });

          console.log("matchingRules ", matchingRules);
          // Send notifications via matching alert rules
          for (const rule of matchingRules) {
            // Send email
            if (rule.emailRecipients) {
              const emails = rule.emailRecipients.split(',').map(e => e.trim()).filter(e => e);
              
              if (emails.length > 0) {
                const emailService = new EmailService();
                const success = await emailService.sendCostAlert({
                  to: emails,
                  ruleName: `Budget Alert: ${budget.budgetName}`,
                  currentCost,
                  threshold: budgetAmount,
                  period: budget.period,
                });
                
                if (success) {
                  console.log(`[Budget Checker] ✓ Email sent to ${emails.join(', ')}`);
                  results.alerted++;
                } else {
                  console.error(`[Budget Checker] ✗ Failed to send email`);
                  results.errors.push(`Failed to send email for budget: ${budget.budgetName}`);
                }
              }
            }

            console.log("rule.webhookUrl ", rule.webhookUrl, rule.emailRecipients);
            // Send webhook
            if (rule.webhookUrl) {
              const webhookSuccess = await sendWebhookNotification(
                rule.webhookUrl,
                `Budget Alert: ${budget.budgetName}`,
                currentCost,
                budgetAmount,
                budget.provider || 'All Providers',
                budget.serviceName || 'All Services',
                budget.period
              );

              if (webhookSuccess) {
                console.log(`[Budget Checker] ✓ Webhook sent successfully`);
              } else {
                console.error(`[Budget Checker] ✗ Webhook failed`);
                results.errors.push(`Webhook failed for budget: ${budget.budgetName}`);
              }
            }
          }
        } else {
          console.log(`[Budget Checker] ✗ No thresholds exceeded`);
        }
      } catch (error) {
        const errorMsg = `Error checking budget "${budget.budgetName}": ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error(`[Budget Checker] ${errorMsg}`);
        results.errors.push(errorMsg);
      }
    }

    return results;
  } catch (error) {
    const errorMsg = `Error in budget checker: ${error instanceof Error ? error.message : 'Unknown error'}`;
    console.error(`[Budget Checker] ${errorMsg}`);
    results.errors.push(errorMsg);
    return results;
  }
}

/**
 * Check both budgets and alert rules
 */
export async function checkAllAlerts(): Promise<{
  success: boolean;
  checked: number;
  alerted: number;
  errors: string[];
  budgets: CheckResults;
  alertRules: CheckResults;
  message: string;
}> {
  console.log('[Alert System] Starting comprehensive alert check...\n');
  
  const budgetResults = await checkBudgetAlerts();
  const alertRuleResults = await checkAlertRules();
  
  const totalChecked = budgetResults.checked + alertRuleResults.checked;
  const totalAlerted = budgetResults.alerted + alertRuleResults.alerted;
  const allErrors = [...budgetResults.errors, ...alertRuleResults.errors];
  
  console.log(`\n[Alert System] Check complete: ${totalChecked} items checked, ${totalAlerted} alerts sent`);
  
  return {
    success: true,
    checked: totalChecked,
    alerted: totalAlerted,
    errors: allErrors,
    budgets: budgetResults,
    alertRules: alertRuleResults,
    message: `Checked ${budgetResults.checked} budgets and ${alertRuleResults.checked} alert rules, sent ${totalAlerted} alerts`
  };
}

/**
 * Start periodic alert checking (for production deployment)
 * Run this on a schedule (e.g., every hour or every 15 minutes)
 */
export function startBudgetAlertScheduler(intervalMinutes: number = 60): NodeJS.Timeout {
  console.log(`[Alert Scheduler] Starting alert scheduler (checking every ${intervalMinutes} minutes)`);
  
  // Run initial check
  checkAllAlerts().then(results => {
    console.log(`[Alert Scheduler] Initial check: ${results.checked} items checked, ${results.alerted} alerts sent`);
    if (results.errors.length > 0) {
      console.error('[Alert Scheduler] Errors:', results.errors);
    }
  });

  // Schedule periodic checks
  return setInterval(async () => {
    console.log(`[Alert Scheduler] Running scheduled alert check...`);
    const results = await checkAllAlerts();
    console.log(`[Alert Scheduler] Check complete: ${results.checked} items checked, ${results.alerted} alerts sent`);
    if (results.errors.length > 0) {
      console.error('[Alert Scheduler] Errors:', results.errors);
    }
  }, intervalMinutes * 60 * 1000);
}
