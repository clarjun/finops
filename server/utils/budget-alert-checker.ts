/**
 * Budget Alert Checker
 * Monitors budgets and triggers alerts when thresholds are exceeded
 */

import { storage } from "../storage";
import { EmailService } from "../email-service";
import type { Budget, CloudProvider } from "@shared/schema";

interface BudgetStatus {
  budget: Budget;
  spent: number;
  percentage: number;
  status: 'success' | 'warning' | 'danger';
  triggeredThresholds: number[];
}

/**
 * Calculate current spending for a budget by querying the database
 */
async function calculateBudgetSpending(budget: Budget): Promise<number> {
  // Query cost history from database with filters
  const costHistory = await storage.queryCostHistory({
    provider: budget.provider || undefined,
    accountId: budget.accountId || undefined,
    serviceName: budget.serviceName || undefined,
    startDate: new Date(budget.startDate),
    endDate: budget.endDate ? new Date(budget.endDate) : new Date(),
  });
  
  // Sum total cost
  const totalCost = costHistory.reduce((sum, item) => sum + parseFloat(item.cost.toString()), 0);
  
  return totalCost;
}

/**
 * Check if alert threshold has been triggered
 */
function shouldTriggerAlert(percentage: number, threshold: number, lastTriggered: Set<string>): boolean {
  const key = threshold.toString();
  
  // Only trigger if percentage exceeds threshold AND we haven't already alerted for this threshold
  if (percentage >= threshold && !lastTriggered.has(key)) {
    return true;
  }
  
  return false;
}

/**
 * Send webhook notification (Slack/Teams)
 */
async function sendWebhookNotification(webhookUrl: string, budget: Budget, status: BudgetStatus): Promise<boolean> {
  try {
    // Format message for Slack/Teams
    const message = {
      text: `🚨 Budget Alert: ${budget.budgetName}`,
      attachments: [{
        color: status.status === 'danger' ? 'danger' : 'warning',
        fields: [
          {
            title: 'Budget',
            value: budget.budgetName,
            short: true
          },
          {
            title: 'Status',
            value: `${status.percentage.toFixed(1)}% used`,
            short: true
          },
          {
            title: 'Spent',
            value: `$${status.spent.toFixed(2)} of $${budget.amount}`,
            short: true
          },
          {
            title: 'Provider',
            value: budget.provider || 'All providers',
            short: true
          },
          {
            title: 'Triggered Thresholds',
            value: status.triggeredThresholds.map(t => `${t}%`).join(', '),
            short: false
          }
        ],
        footer: 'FinOps Dashboard',
        ts: Math.floor(Date.now() / 1000)
      }]
    };

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      console.error('Webhook notification failed:', await response.text());
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error sending webhook notification:', error);
    return false;
  }
}

/**
 * Send email notification for budget alert
 */
async function sendEmailNotification(emails: string[], budget: Budget, status: BudgetStatus): Promise<boolean> {
  const emailService = new EmailService();
  
  const statusEmoji = status.status === 'danger' ? '🔴' : '⚠️';
  const statusText = status.status === 'danger' ? 'EXCEEDED' : 'AT RISK';
  
  const subject = `${statusEmoji} Budget Alert: ${budget.budgetName} ${statusText}`;
  
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: ${status.status === 'danger' ? '#ef4444' : '#f59e0b'}; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 24px;">${statusEmoji} Budget Alert</h1>
      </div>
      
      <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px;">
        <h2 style="margin-top: 0; color: #111827;">${budget.budgetName}</h2>
        
        <div style="background: white; padding: 20px; border-radius: 6px; margin-bottom: 20px;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 15px;">
            <div>
              <div style="color: #6b7280; font-size: 14px;">Budget Amount</div>
              <div style="font-size: 24px; font-weight: bold; color: #111827;">$${parseFloat(budget.amount).toFixed(2)}</div>
            </div>
            <div>
              <div style="color: #6b7280; font-size: 14px;">Amount Spent</div>
              <div style="font-size: 24px; font-weight: bold; color: ${status.status === 'danger' ? '#ef4444' : '#f59e0b'};">$${status.spent.toFixed(2)}</div>
            </div>
          </div>
          
          <div style="background: #e5e7eb; border-radius: 4px; height: 20px; overflow: hidden; margin-bottom: 10px;">
            <div style="background: ${status.status === 'danger' ? '#ef4444' : '#f59e0b'}; height: 100%; width: ${Math.min(status.percentage, 100)}%;"></div>
          </div>
          <div style="text-align: center; color: #6b7280; font-size: 14px;">${status.percentage.toFixed(1)}% of budget used</div>
        </div>
        
        <div style="background: white; padding: 20px; border-radius: 6px; margin-bottom: 20px;">
          <h3 style="margin-top: 0; color: #111827; font-size: 16px;">Budget Details</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Provider</td>
              <td style="padding: 8px 0; color: #111827; font-weight: 500;">${budget.provider || 'All providers'}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Account</td>
              <td style="padding: 8px 0; color: #111827; font-weight: 500;">${budget.accountId || 'All accounts'}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Service</td>
              <td style="padding: 8px 0; color: #111827; font-weight: 500;">${budget.serviceName || 'All services'}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Period</td>
              <td style="padding: 8px 0; color: #111827; font-weight: 500;">${budget.period}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280;">Triggered Thresholds</td>
              <td style="padding: 8px 0; color: #111827; font-weight: 500;">${status.triggeredThresholds.map(t => `${t}%`).join(', ')}</td>
            </tr>
          </table>
        </div>
        
        <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; border-radius: 4px;">
          <strong style="color: #92400e;">Recommended Actions:</strong>
          <ul style="margin: 10px 0; padding-left: 20px; color: #78350f;">
            ${status.status === 'danger' ? 
              `<li>Review and optimize your cloud resource usage immediately</li>
               <li>Consider shutting down unused resources</li>
               <li>Analyze cost trends in the FinOps Dashboard</li>` :
              `<li>Monitor your spending closely over the next few days</li>
               <li>Review upcoming resource deployments</li>
               <li>Check for cost optimization opportunities</li>`
            }
          </ul>
        </div>
        
        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; text-align: center; color: #6b7280; font-size: 12px;">
          This is an automated alert from your FinOps Dashboard
        </div>
      </div>
    </div>
  `;
  
  const text = `
Budget Alert: ${budget.budgetName}

Status: ${statusText}
Budget Amount: $${parseFloat(budget.amount).toFixed(2)}
Amount Spent: $${status.spent.toFixed(2)}
Percentage Used: ${status.percentage.toFixed(1)}%

Provider: ${budget.provider || 'All providers'}
Account: ${budget.accountId || 'All accounts'}
Service: ${budget.serviceName || 'All services'}
Period: ${budget.period}

Triggered Thresholds: ${status.triggeredThresholds.map(t => `${t}%`).join(', ')}
`;

  return await emailService.sendEmail({
    to: emails,
    subject,
    html,
    text
  });
}

/**
 * Check all active budgets and trigger alerts as needed
 */
export async function checkBudgetAlerts(): Promise<{
  checked: number;
  alerted: number;
  errors: string[];
}> {
  const results = {
    checked: 0,
    alerted: 0,
    errors: [] as string[]
  };

  try {
    // Get all active budgets
    const budgets = await storage.getActiveBudgets();
    results.checked = budgets.length;

    // Track which thresholds have been triggered (in-memory for MVP)
    // In production, store this in database to persist across restarts
    const triggeredAlerts = new Map<number, Set<string>>();

    for (const budget of budgets) {
      try {
        // Calculate current spending
        const spent = await calculateBudgetSpending(budget);
        const budgetAmount = parseFloat(budget.amount);
        const percentage = (spent / budgetAmount) * 100;

        // Determine status
        let status: 'success' | 'warning' | 'danger' = 'success';
        if (percentage >= 100) status = 'danger';
        else if (percentage >= 75) status = 'warning';

        // Check alert thresholds
        const alertThresholds = (budget.alertThresholds as Record<string, boolean> | null) || {};
        const triggeredThresholds: number[] = [];
        const lastTriggered = triggeredAlerts.get(budget.id) || new Set<string>();

        for (const [threshold, enabled] of Object.entries(alertThresholds)) {
          if (enabled && shouldTriggerAlert(percentage, parseInt(threshold), lastTriggered)) {
            triggeredThresholds.push(parseInt(threshold));
            lastTriggered.add(threshold);
          }
        }

        // Update triggered alerts tracking
        if (triggeredThresholds.length > 0) {
          triggeredAlerts.set(budget.id, lastTriggered);

          const budgetStatus: BudgetStatus = {
            budget,
            spent,
            percentage,
            status,
            triggeredThresholds
          };

          // Get alert rules for this budget (if any)
          // In production, query alert rules table filtered by budget criteria
          const allAlertRules = await storage.getEnabledAlertRules();
          
          // Filter rules that match budget criteria
          const matchingRules = allAlertRules.filter(rule => {
            // Rule matches if it applies to this provider/account/service or is global
            const providerMatch = !rule.provider || rule.provider === budget.provider;
            const accountMatch = !rule.accountId || rule.accountId === budget.accountId;
            const serviceMatch = !rule.serviceName || rule.serviceName === budget.serviceName;
            
            return providerMatch && accountMatch && serviceMatch;
          });

          // Send notifications
          for (const rule of matchingRules) {
            // Send email notifications
            if (rule.emailRecipients) {
              const emails = rule.emailRecipients.split(',').map(e => e.trim()).filter(e => e);
              if (emails.length > 0) {
                await sendEmailNotification(emails, budget, budgetStatus);
                results.alerted++;
              }
            }

            // Send webhook notifications
            if (rule.webhookUrl) {
              await sendWebhookNotification(rule.webhookUrl, budget, budgetStatus);
            }
          }

          console.log(`Alert triggered for budget "${budget.budgetName}": ${triggeredThresholds.join(', ')}% thresholds`);
        }
      } catch (error) {
        const errorMsg = `Error checking budget "${budget.budgetName}": ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error(errorMsg);
        results.errors.push(errorMsg);
      }
    }

    return results;
  } catch (error) {
    const errorMsg = `Error in budget alert checker: ${error instanceof Error ? error.message : 'Unknown error'}`;
    console.error(errorMsg);
    results.errors.push(errorMsg);
    return results;
  }
}

/**
 * Start periodic budget checking (for production deployment)
 * Run this on a schedule (e.g., every hour or every 15 minutes)
 */
export function startBudgetAlertScheduler(intervalMinutes: number = 60): NodeJS.Timeout {
  console.log(`Starting budget alert scheduler (checking every ${intervalMinutes} minutes)`);
  
  // Run initial check
  checkBudgetAlerts().then(results => {
    console.log(`Initial budget check: ${results.checked} budgets checked, ${results.alerted} alerts sent`);
    if (results.errors.length > 0) {
      console.error('Errors:', results.errors);
    }
  });

  // Schedule periodic checks
  return setInterval(async () => {
    const results = await checkBudgetAlerts();
    console.log(`Budget check: ${results.checked} budgets checked, ${results.alerted} alerts sent`);
    if (results.errors.length > 0) {
      console.error('Errors:', results.errors);
    }
  }, intervalMinutes * 60 * 1000);
}
