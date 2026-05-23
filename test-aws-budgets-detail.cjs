/**
 * Test AWS Budgets - Show Detailed Budget Information
 * This will show you exactly what budgets are configured in your AWS account
 */

const { BudgetsClient, DescribeBudgetsCommand } = require("@aws-sdk/client-budgets");
const { STSClient, GetCallerIdentityCommand } = require("@aws-sdk/client-sts");

async function testAWSBudgets() {
  console.log('========================================');
  console.log('AWS Budgets Detail Report');
  console.log('========================================\n');

  try {
    // You'll need to set these from your database or environment
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

    if (!accessKeyId || !secretAccessKey) {
      console.error('❌ AWS credentials not found in environment variables');
      console.log('Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY');
      process.exit(1);
    }

    // Get account ID
    const stsClient = new STSClient({
      region: "us-east-1",
      credentials: { accessKeyId, secretAccessKey },
    });
    
    const identity = await stsClient.send(new GetCallerIdentityCommand({}));
    const accountId = identity.Account;
    
    console.log(`AWS Account ID: ${accountId}\n`);

    // Fetch budgets
    const budgetsClient = new BudgetsClient({
      region: "us-east-1",
      credentials: { accessKeyId, secretAccessKey },
    });

    const command = new DescribeBudgetsCommand({
      AccountId: accountId,
    });

    const response = await budgetsClient.send(command);
    
    if (!response.Budgets || response.Budgets.length === 0) {
      console.log('❌ No budgets found in AWS account');
      console.log('\nTo create budgets:');
      console.log('1. Go to AWS Console → Billing → Budgets');
      console.log('2. Create a new budget');
      console.log('3. Set the budget amount and time period');
      process.exit(0);
    }

    console.log(`Found ${response.Budgets.length} budget(s):\n`);
    console.log('========================================\n');

    let totalMonthly = 0;
    let monthlyCount = 0;

    for (let i = 0; i < response.Budgets.length; i++) {
      const budget = response.Budgets[i];
      console.log(`Budget ${i + 1}: ${budget.BudgetName}`);
      console.log(`  Type: ${budget.BudgetType}`);
      console.log(`  Time Unit: ${budget.TimeUnit}`);
      console.log(`  Amount: $${budget.BudgetLimit?.Amount || 'N/A'} ${budget.BudgetLimit?.Unit || ''}`);
      console.log(`  Time Period: ${budget.TimePeriod?.Start} to ${budget.TimePeriod?.End || 'Ongoing'}`);
      
      if (budget.TimeUnit === "MONTHLY") {
        const amount = parseFloat(budget.BudgetLimit?.Amount || '0');
        totalMonthly += amount;
        monthlyCount++;
        console.log(`  ✅ Included in monthly total`);
      } else {
        console.log(`  ⚠️  Not monthly - excluded from total`);
      }
      
      console.log();
    }

    console.log('========================================');
    console.log(`Total Monthly Budgets: ${monthlyCount}`);
    console.log(`Total Monthly Amount: $${totalMonthly.toFixed(2)}`);
    console.log('========================================\n');

    if (totalMonthly < 100) {
      console.log('⚠️  WARNING: Your total monthly budget ($' + totalMonthly.toFixed(2) + ') seems low');
      console.log('   Current MTD spend is likely higher than this budget');
      console.log('   Consider updating your AWS Budgets to match your actual spending\n');
    }

    console.log('✅ This is the amount that will be shown in the FinOps reports');

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.name === 'AccessDeniedException') {
      console.log('\n⚠️  Your AWS credentials do not have permission to access AWS Budgets');
      console.log('Required permission: budgets:DescribeBudgets');
    }
    process.exit(1);
  }
}

testAWSBudgets();
