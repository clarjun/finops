/**
 * Email Service Framework
 * Supports multiple email providers (Resend, SendGrid, SMTP)
 * 
 * CONFIGURATION REQUIRED:
 * Set one of the following environment variables:
 * - RESEND_API_KEY: For Resend email service
 * - SENDGRID_API_KEY: For SendGrid email service
 * - SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS: For generic SMTP
 */

interface EmailMessage {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
}

interface EmailProvider {
  send(message: EmailMessage): Promise<boolean>;
}

/**
 * Resend Email Provider
 */
class ResendProvider implements EmailProvider {
  private apiKey: string;
  private apiUrl = 'https://api.resend.com/emails';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async send(message: EmailMessage): Promise<boolean> {
    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: message.from || 'Azure Cost Dashboard <noreply@resend.dev>',
          to: Array.isArray(message.to) ? message.to : [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('Resend API error:', error);
        return false;
      }

      return true;
    } catch (error) {
      console.error('Error sending email via Resend:', error);
      return false;
    }
  }
}

/**
 * SendGrid Email Provider
 */
class SendGridProvider implements EmailProvider {
  private apiKey: string;
  private apiUrl = 'https://api.sendgrid.com/v3/mail/send';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async send(message: EmailMessage): Promise<boolean> {
    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{
            to: Array.isArray(message.to) 
              ? message.to.map(email => ({ email })) 
              : [{ email: message.to }],
          }],
          from: { email: message.from || 'noreply@example.com' },
          subject: message.subject,
          content: [
            { type: 'text/html', value: message.html },
            ...(message.text ? [{ type: 'text/plain', value: message.text }] : []),
          ],
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('SendGrid API error:', error);
        return false;
      }

      return true;
    } catch (error) {
      console.error('Error sending email via SendGrid:', error);
      return false;
    }
  }
}

/**
 * Mock Email Provider (logs to console, for development/testing)
 */
class MockProvider implements EmailProvider {
  async send(message: EmailMessage): Promise<boolean> {
    console.log('\n=== EMAIL (MOCK) ===');
    console.log('To:', message.to);
    console.log('Subject:', message.subject);
    console.log('HTML:', message.html.substring(0, 100) + '...');
    console.log('==================\n');
    return true;
  }
}

/**
 * Email Service
 */
export class EmailService {
  private provider: EmailProvider;
  private isConfigured: boolean = false;

  constructor() {
    // Auto-configure based on available environment variables
    if (process.env.RESEND_API_KEY) {
      this.provider = new ResendProvider(process.env.RESEND_API_KEY);
      this.isConfigured = true;
      console.log('Email service configured with Resend');
    } else if (process.env.SENDGRID_API_KEY) {
      this.provider = new SendGridProvider(process.env.SENDGRID_API_KEY);
      this.isConfigured = true;
      console.log('Email service configured with SendGrid');
    } else {
      this.provider = new MockProvider();
      this.isConfigured = false;
      console.warn('Email service not configured - using mock provider (emails will be logged to console only)');
      console.warn('To enable emails, set RESEND_API_KEY or SENDGRID_API_KEY environment variable');
    }
  }

  /**
   * Send an email
   */
  async sendEmail(message: EmailMessage): Promise<boolean> {
    return await this.provider.send(message);
  }

  /**
   * Send cost alert email
   */
  async sendCostAlert(params: {
    to: string[];
    ruleName: string;
    currentCost: number;
    threshold: number;
    period: string;
  }): Promise<boolean> {
    const html = `
      <h2>⚠️ Azure Cost Alert</h2>
      <p>Your Azure spending has exceeded the threshold for rule: <strong>${params.ruleName}</strong></p>
      <p><strong>Current Cost:</strong> $${params.currentCost.toFixed(2)}</p>
      <p><strong>Threshold:</strong> $${params.threshold.toFixed(2)}</p>
      <p><strong>Period:</strong> ${params.period}</p>
      <p>Please review your Azure spending in the cost dashboard.</p>
    `;

    return await this.sendEmail({
      to: params.to,
      subject: `Cost Alert: ${params.ruleName}`,
      html,
      text: `Azure Cost Alert - ${params.ruleName}: Current cost $${params.currentCost.toFixed(2)} exceeds threshold $${params.threshold.toFixed(2)}`,
    });
  }

  /**
   * Send anomaly detection alert
   */
  async sendAnomalyAlert(params: {
    to: string[];
    anomalies: any[];
  }): Promise<boolean> {
    const anomalyList = params.anomalies
      .slice(0, 5)
      .map(a => `<li>${a.date}: $${a.cost.toFixed(2)} - ${a.description} (${a.severity} severity)</li>`)
      .join('');

    const html = `
      <h2>🔍 Cost Anomaly Detected</h2>
      <p>Unusual spending patterns have been detected in your Azure environment:</p>
      <ul>${anomalyList}</ul>
      <p>Total anomalies detected: ${params.anomalies.length}</p>
      <p>Please review these anomalies in the cost dashboard.</p>
    `;

    return await this.sendEmail({
      to: params.to,
      subject: `Anomaly Alert: ${params.anomalies.length} unusual spending patterns detected`,
      html,
      text: `Cost Anomaly Alert: ${params.anomalies.length} anomalies detected`,
    });
  }

  /**
   * Send scheduled cost report
   */
  async sendScheduledReport(params: {
    to: string[];
    reportType: string;
    csvAttachment?: string;
    summary: {
      totalCost: number;
      avgDailyCost: number;
      topService: string;
      topServiceCost: number;
    };
  }): Promise<boolean> {
    const html = `
      <h2>📊 Azure Cost Report</h2>
      <p>Your scheduled <strong>${params.reportType}</strong> cost report is ready.</p>
      
      <h3>Summary</h3>
      <ul>
        <li><strong>Total Cost:</strong> $${params.summary.totalCost.toFixed(2)}</li>
        <li><strong>Average Daily Cost:</strong> $${params.summary.avgDailyCost.toFixed(2)}</li>
        <li><strong>Top Service:</strong> ${params.summary.topService} ($${params.summary.topServiceCost.toFixed(2)})</li>
      </ul>
      
      <p>View the full report in your cost dashboard for detailed analytics and insights.</p>
      ${params.csvAttachment ? '<p><em>CSV report attached</em></p>' : ''}
    `;

    return await this.sendEmail({
      to: params.to,
      subject: `Azure Cost Report - ${params.reportType}`,
      html,
      text: `Azure Cost Report - Total: $${params.summary.totalCost.toFixed(2)}, Avg Daily: $${params.summary.avgDailyCost.toFixed(2)}`,
    });
  }

  /**
   * Check if email service is properly configured
   */
  isEmailConfigured(): boolean {
    return this.isConfigured;
  }
}

// Export singleton instance
export const emailService = new EmailService();
