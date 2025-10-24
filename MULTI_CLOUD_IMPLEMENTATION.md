# Multi-Cloud FinOps Implementation Guide

This document provides a complete guide to the multi-cloud cost optimization dashboard implementation.

## Overview

This system provides comprehensive FinOps capabilities across Azure, AWS, and GCP, including:

- **Cost & Usage Tracking**: Daily/weekly/monthly spending per service across all cloud providers
- **Budget Management**: Track budget limits with multi-threshold alerts
- **Resource Inventory**: Track EC2, S3, Lambda, Compute Engine, Cloud Storage, RDS, etc.
- **Cost Allocation**: Tag/label-based cost breakdown for teams and projects
- **Savings Optimization**: RI/Savings Plans/CUD recommendations
- **AI-Powered Insights**: Predictive forecasting, anomaly detection, rightsizing
- **Multi-Cloud Comparison**: Cost comparison and workload placement recommendations

## Architecture

### Database Schema

The multi-cloud system uses these key tables:

1. **`cloud_accounts`** - Unified credential storage for all providers
2. **`cost_history`** - Historical cost data with provider field
3. **`budgets`** - Spending limits per provider/account/service
4. **`alert_rules`** - Budget threshold notifications (email/webhook)
5. **`resource_inventory`** - Active resources across all clouds
6. **`tag_analysis`** - Cost allocation by tags/labels
7. **`forecast_data`** - ML predictions per provider
8. **`optimization_recommendations`** - Rightsizing, RI, spot instance suggestions
9. **`savings_plans`** - RI/Savings Plan/CUD tracking
10. **`anomaly_events`** - Cost anomalies with root cause analysis

### Multi-Cloud Data Flow

```
┌─────────────────────────────────────────────────────────┐
│                   Cloud Providers                       │
├─────────────────┬─────────────────┬────────────────────┤
│  Azure Cost     │   AWS Cost      │  GCP Cloud         │
│  Management API │   Explorer API  │  Billing API       │
└────────┬────────┴────────┬────────┴──────────┬─────────┘
         │                 │                    │
         ▼                 ▼                    ▼
┌────────────────────────────────────────────────────────┐
│           Cost Data Normalization Layer                │
│  - normalize-azure-costs()                             │
│  - normalize-aws-costs()                               │
│  - normalize-gcp-costs()                               │
└────────┬───────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────────────┐
│        Unified Cost Data (UnifiedCostData[])           │
│  provider | accountId | date | service | cost | tags  │
└────────┬───────────────────────────────────────────────┘
         │
         ├─────────────────┬──────────────────┬──────────┐
         ▼                 ▼                  ▼          ▼
    ┌─────────┐      ┌──────────┐     ┌─────────┐  ┌─────────┐
    │Database │      │   ML     │     │  Multi  │  │   Tag   │
    │ Storage │      │Pipeline  │     │  Cloud  │  │Analysis │
    │         │      │(Forecast │     │Compare  │  │         │
    └─────────┘      │Anomaly)  │     └─────────┘  └─────────┘
                     └──────────┘
```

## Cloud Provider Integration

### AWS Integration

**Required SDK Packages:**
```bash
npm install @aws-sdk/client-cost-explorer @aws-sdk/client-ec2 @aws-sdk/client-s3 @aws-sdk/client-lambda @aws-sdk/client-rds @aws-sdk/client-cloudwatch
```

**Environment Variables:**
```env
# AWS Credentials (for serverless/backend access)
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_REGION=us-east-1
```

**Configuration Storage:**
```typescript
{
  provider: 'aws',
  accountName: 'Production AWS',
  accountId: '123456789012',
  credentials: {
    accessKeyId: 'encrypted-key',
    secretAccessKey: 'encrypted-secret',
    region: 'us-east-1'
  }
}
```

**APIs Used:**
- **Cost Explorer**: `GetCostAndUsage` for historical costs
- **EC2**: `DescribeInstances`, `DescribeVolumes` for inventory
- **CloudWatch**: `GetMetricStatistics` for utilization metrics
- **Cost Explorer**: `GetReservationPurchaseRecommendation` for RI recommendations
- **Cost Explorer**: `GetSavingsPlansPurchaseRecommendation` for Savings Plans

**Implementation Status:**
- ✅ Cost data structure defined
- ✅ Mock data generator
- 🔄 Real API integration (requires AWS SDK installation)
- 📝 Resource inventory (TODO)
- 📝 RI/Savings Plans recommendations (TODO)

### GCP Integration

**Required SDK Packages:**
```bash
npm install @google-cloud/billing @google-cloud/bigquery @google-cloud/compute @google-cloud/storage
```

**Environment Variables:**
```env
# GCP Service Account Credentials
GCP_PROJECT_ID=your-project-id
GCP_CLIENT_EMAIL=service-account@project.iam.gserviceaccount.com
GCP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

**Configuration Storage:**
```typescript
{
  provider: 'gcp',
  accountName: 'Production GCP',
  accountId: 'my-gcp-project',
  credentials: {
    projectId: 'my-gcp-project',
    clientEmail: 'encrypted-email',
    privateKey: 'encrypted-key',
    billingAccountId: '012345-67890A-BCDEF0'
  }
}
```

**APIs Used:**
- **BigQuery**: Billing export table queries for cost data
- **Compute Engine**: `instances().list()` for VM inventory
- **Cloud Storage**: `buckets().list()` for storage inventory
- **Recommender API**: CUD (Committed Use Discount) recommendations

**BigQuery Billing Export Setup:**
1. Enable Cloud Billing API
2. Create BigQuery dataset for billing export
3. Configure billing export in Cloud Console
4. Query the export table: `gcp_billing_export_v1_<BILLING_ACCOUNT_ID>`

**Implementation Status:**
- ✅ Cost data structure defined
- ✅ Mock data generator
- ✅ BigQuery query structure
- 🔄 Real API integration (requires GCP SDK installation)
- 📝 Resource inventory (TODO)
- 📝 CUD recommendations (TODO)

### Azure Integration

**Status**: ✅ Already implemented

**APIs Used:**
- Cost Management Query API
- Resource Graph API (for inventory)
- Advisor API (for recommendations)

## API Endpoints

### Multi-Cloud Cost Endpoints

```typescript
// Get cost data for all providers or specific provider
GET /api/multi-cloud/costs?provider=aws&startDate=2025-01-01&endDate=2025-01-31

// Get multi-cloud comparison
GET /api/multi-cloud/comparison?period=monthly

// Get cost breakdown by provider
GET /api/multi-cloud/breakdown?groupBy=provider,service
```

### Budget & Alerts

```typescript
// Budgets CRUD
POST   /api/budgets          // Create budget
GET    /api/budgets          // List all budgets
GET    /api/budgets/:id      // Get specific budget
PUT    /api/budgets/:id      // Update budget
DELETE /api/budgets/:id      // Delete budget

// Alert Rules CRUD
POST   /api/alerts           // Create alert rule
GET    /api/alerts           // List alert rules
PUT    /api/alerts/:id       // Update alert rule
DELETE /api/alerts/:id       // Delete alert rule

// Trigger manual alert check
POST   /api/alerts/check     // Check all rules and send alerts
```

### Resource Inventory

```typescript
// Get resource inventory across all providers
GET /api/resources?provider=aws&state=idle&utilizationLt=20

// Get idle/underutilized resources
GET /api/resources/idle

// Get rightsizing recommendations
GET /api/resources/rightsizing
```

### Tag/Label Analysis

```typescript
// Get cost allocation by tags
GET /api/tags/allocation?provider=aws&period=monthly

// Find untagged resources
GET /api/tags/untagged

// Get tagging compliance report
GET /api/tags/compliance
```

### Savings Optimization

```typescript
// Get RI/Savings Plans/CUD recommendations
GET /api/savings/recommendations?provider=aws

// Get active savings plans
GET /api/savings/plans

// Calculate potential savings
GET /api/savings/potential
```

### Anomaly Detection

```typescript
// Get recent anomalies
GET /api/anomalies?provider=aws&severity=high

// Get anomaly details with root cause
GET /api/anomalies/:id

// Mark anomaly as resolved
PUT /api/anomalies/:id/resolve
```

## Frontend Components

### Multi-Cloud Provider Selector

```typescript
// Component: client/src/components/provider-selector.tsx
<ProviderSelector
  selectedProvider={provider}
  onProviderChange={setProvider}
  showAll={true}  // Include "All Providers" option
/>
```

### Multi-Cloud Dashboard

**Pages:**
1. **Overview** - Multi-cloud cost summary
2. **Provider Comparison** - Side-by-side cost comparison
3. **Budgets** - Budget tracking and alerts
4. **Resources** - Resource inventory and utilization
5. **Tags** - Cost allocation analysis
6. **Recommendations** - Optimization opportunities
7. **Anomalies** - Cost anomaly investigation

### Budget Alert Components

```typescript
// Budget creation form
<BudgetForm onSubmit={createBudget} />

// Budget list with progress bars
<BudgetList budgets={budgets} />

// Alert rule configuration
<AlertRuleForm onSubmit={createAlertRule} />
```

## ML & AI Features

### Predictive Forecasting

**Models per Provider:**
- Time-series forecasting (Prophet, ARIMA, or LSTM)
- Separate models for each provider to account for pricing patterns
- 30/60/90-day predictions with confidence intervals

### Anomaly Detection

**Algorithms:**
- Isolation Forest for cost spike detection
- One-Class SVM for pattern deviation
- Threshold-based alerts for dramatic changes

### Rightsizing Recommendations

**Analysis:**
- EC2/Compute Engine utilization < 20% → downsize or stop
- Lambda memory allocation optimization
- RDS instance rightsizing based on CloudWatch metrics

### Natural Language Queries

**Integration:**
- OpenAI GPT-5 for query parsing
- Context-aware responses using cost data
- Examples:
  - "What will next month's AWS EC2 cost be?"
  - "Which GCP resources are idle for 7 days?"
  - "Compare costs between AWS and Azure for compute services"

## Security & Credentials

### Credential Encryption

All cloud provider credentials are encrypted using AES-256-GCM before storage:

```typescript
import crypto from 'crypto';

const algorithm = 'aes-256-gcm';
const key = crypto.scryptSync(process.env.ENCRYPTION_KEY!, 'salt', 32);

function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return JSON.stringify({
    iv: iv.toString('hex'),
    encrypted: encrypted.toString('hex'),
    authTag: authTag.toString('hex')
  });
}
```

### Environment Variables Required

```env
# Encryption
ENCRYPTION_KEY=your-32-character-encryption-key-here

# Database
DATABASE_URL=postgresql://...

# OpenAI (for AI features)
AI_INTEGRATIONS_OPENAI_API_KEY=sk-...
AI_INTEGRATIONS_OPENAI_BASE_URL=https://api.openai.com/v1

# Email/Notifications (optional)
RESEND_API_KEY=re_...
# OR
SENDGRID_API_KEY=SG....

# Webhook for Slack/Teams (optional)
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
TEAMS_WEBHOOK_URL=https://outlook.office.com/webhook/...
```

## Implementation Phases

### Phase 1: Core Multi-Cloud Infrastructure ✅ (Current)
- [x] Database schema extension
- [x] AWS cost client structure
- [x] GCP cost client structure
- [x] Multi-cloud cost processor
- [ ] API routes for multi-cloud costs

### Phase 2: Budget & Alerts
- [ ] Budget management API
- [ ] Alert rules API
- [ ] Email/webhook notification service
- [ ] Budget UI components

### Phase 3: Resource Inventory
- [ ] AWS resource discovery (EC2, S3, Lambda, RDS)
- [ ] GCP resource discovery (Compute, Storage, Functions)
- [ ] Azure resource discovery
- [ ] Resource inventory UI

### Phase 4: Tag/Cost Allocation
- [ ] Tag analysis engine
- [ ] Untagged resource detection
- [ ] Cost allocation reports
- [ ] Tag compliance dashboard

### Phase 5: Savings Optimization
- [ ] RI/Savings Plans/CUD recommendations
- [ ] Rightsizing analysis
- [ ] Idle resource detection
- [ ] Savings opportunity UI

### Phase 6: Advanced ML Features
- [ ] Multi-cloud forecasting
- [ ] Enhanced anomaly detection
- [ ] Root cause analysis
- [ ] Spot instance/preemptible VM predictions

### Phase 7: Advanced Features
- [ ] Multi-cloud comparison dashboard
- [ ] Workload placement recommendations
- [ ] Natural language cost queries
- [ ] Custom team-based forecasting

## Testing Strategy

### Unit Tests
- Cost normalization functions
- Tag analysis logic
- Budget threshold calculations

### Integration Tests
- Multi-cloud API endpoint flows
- Database operations
- Alert triggering logic

### E2E Tests
- Multi-cloud dashboard navigation
- Budget creation and alert triggering
- Resource inventory filtering
- Provider switching

## Deployment Checklist

- [ ] Install AWS SDK packages
- [ ] Install GCP SDK packages
- [ ] Set up encryption keys
- [ ] Configure email service (Resend/SendGrid)
- [ ] Set up webhook URLs (Slack/Teams)
- [ ] Push database schema changes
- [ ] Configure cloud provider credentials
- [ ] Test each provider integration
- [ ] Set up automated cost refresh jobs
- [ ] Configure alert monitoring

## Next Steps

1. Install required cloud SDK packages
2. Implement API routes for multi-cloud costs
3. Create provider selector UI component
4. Build multi-cloud dashboard
5. Implement budget management
6. Add resource inventory features
7. Enhance ML capabilities

---

**Current Status**: Infrastructure complete, moving to API implementation and UI development.
