# Optimization Recommendations Feature

## Overview

The optimization recommendations feature analyzes your cloud infrastructure across AWS, Azure, and GCP to identify cost-saving opportunities. It automatically detects idle resources, oversized instances, and inefficient configurations.

## How It Works

### 1. Resource Inventory Collection

The system collects real-time resource inventory from your configured cloud providers:

- **AWS**: EC2 instances, EBS volumes, Lambda functions, RDS databases, S3 buckets, CloudWatch logs, snapshots, Elastic IPs
- **Azure**: Virtual Machines, Managed Disks, SQL Databases, Storage Accounts, Resource Groups
- **GCP**: Compute Engine instances, Cloud Functions, Cloud Storage buckets

### 2. Recommendation Generation

The optimization generator (`server/optimization-generator.ts`) analyzes resources and generates recommendations based on:

#### AWS Recommendations:
- **Idle Resources**: Stopped EC2 instances, unattached EBS volumes, unassociated Elastic IPs
- **Storage Optimization**: Old EBS snapshots (>90 days), CloudWatch logs without retention policies
- **Cost Reduction**: Identifies resources incurring costs without providing value

#### Azure Recommendations:
- **Idle Resources**: Deallocated VMs, unattached managed disks
- **Right-sizing**: SQL databases on Basic tier, storage accounts with Hot tier for infrequent access
- **Cost Optimization**: Suggests moving to serverless or cooler storage tiers

#### GCP Recommendations:
- **Idle Resources**: Stopped Compute Engine instances
- **Right-sizing**: Cloud Functions with excessive memory allocation, storage buckets using Standard class
- **Cost Reduction**: Suggests Nearline/Coldline storage for infrequently accessed data

### 3. Recommendation Types

- **idle_resource**: Resources that are not in use but still incurring costs
- **right_sizing**: Resources that are oversized for their workload
- **reserved_instance**: Opportunities to purchase reserved instances or savings plans
- **savings_plan**: Commitment-based savings opportunities
- **spot_instance**: Workloads suitable for spot/preemptible instances

### 4. Priority Levels

- **Critical**: Immediate action required, high cost impact
- **High**: Should be addressed soon, significant savings
- **Medium**: Moderate savings opportunity
- **Low**: Minor optimization, low priority

## Usage

### Generate Recommendations

1. Navigate to the **Optimization** page in the UI
2. Click the **Generate Recommendations** button
3. The system will analyze all configured cloud accounts and generate recommendations
4. Recommendations appear grouped by priority and provider

### Review Recommendations

Each recommendation shows:
- **Service Name**: The cloud service (EC2, Storage, etc.)
- **Resource ID**: Specific resource identifier
- **Current Cost**: Estimated monthly cost
- **Optimized Cost**: Cost after optimization
- **Potential Savings**: Monthly savings amount and percentage
- **Description**: What the issue is
- **Action Required**: Specific steps to implement the recommendation

### Take Action

For each recommendation, you can:
- **Mark Implemented**: After you've applied the optimization
- **Dismiss**: If the recommendation doesn't apply to your use case

### Filter Recommendations

Use the provider filter to view recommendations for:
- All Providers
- AWS Only
- GCP Only
- Azure Only

## API Endpoints

### GET `/api/optimization/recommendations`

Fetch active recommendations.

**Query Parameters:**
- `provider` (optional): Filter by provider (aws, gcp, azure)
- `accountId` (optional): Filter by specific account

**Response:**
```json
{
  "success": true,
  "recommendations": [
    {
      "id": 1,
      "provider": "aws",
      "accountId": "123456789",
      "resourceId": "i-1234567890abcdef0",
      "serviceName": "EC2",
      "recommendationType": "idle_resource",
      "currentCost": 50.00,
      "optimizedCost": 0.00,
      "potentialSavings": 50.00,
      "savingsPercent": 100.00,
      "priority": "high",
      "description": "EC2 instance is stopped but still incurring costs",
      "actionRequired": "Terminate the instance if no longer needed",
      "status": "active",
      "createdAt": "2024-01-15T10:30:00Z"
    }
  ]
}
```

### POST `/api/optimization/recommendations/generate`

Trigger recommendation generation for all configured cloud accounts.

**Response:**
```json
{
  "success": true,
  "message": "Recommendations generated successfully"
}
```

### PATCH `/api/optimization/recommendations/:id`

Update recommendation status.

**Request Body:**
```json
{
  "status": "implemented"
}
```

**Valid Status Values:**
- `active`: Recommendation is active
- `implemented`: User has implemented the recommendation
- `dismissed`: User has dismissed the recommendation
- `expired`: Recommendation is no longer relevant

## Automation

### Scheduled Generation

To automatically generate recommendations on a schedule, you can:

1. **Add a cron job** (Linux/Mac):
```bash
# Generate recommendations daily at 2 AM
0 2 * * * curl -X POST http://localhost:5000/api/optimization/recommendations/generate
```

2. **Add a Windows Task Scheduler** task:
```powershell
$action = New-ScheduledTaskAction -Execute 'curl' -Argument '-X POST http://localhost:5000/api/optimization/recommendations/generate'
$trigger = New-ScheduledTaskTrigger -Daily -At 2am
Register-ScheduledTask -Action $action -Trigger $trigger -TaskName "GenerateOptimizationRecommendations"
```

3. **Use a background job** in your application (recommended for production)

## Best Practices

1. **Generate recommendations regularly**: Run generation at least weekly to catch new optimization opportunities
2. **Review high-priority recommendations first**: Focus on critical and high-priority items for maximum impact
3. **Track implemented recommendations**: Mark recommendations as implemented to measure your optimization progress
4. **Don't dismiss too quickly**: Some recommendations may seem minor but add up over time
5. **Validate before implementing**: Always verify recommendations in a test environment first
6. **Monitor after changes**: Track cost changes after implementing recommendations

## Limitations

- Recommendations are based on resource configuration, not real-time utilization metrics
- Cost estimates are approximate and may vary based on region and pricing changes
- Some recommendations require manual verification before implementation
- The system does not automatically implement recommendations (human approval required)

## Future Enhancements

- Real-time utilization metrics integration (CloudWatch, Azure Monitor, GCP Monitoring)
- ML-based anomaly detection for unusual resource patterns
- Automated implementation with approval workflows
- Historical tracking of savings achieved
- Custom recommendation rules and thresholds
- Integration with cloud provider native recommendation services (AWS Trusted Advisor, Azure Advisor, GCP Recommender)
