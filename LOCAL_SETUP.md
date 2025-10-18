# Local Setup Guide

This guide will help you download and run the Azure Cost Analysis Dashboard on your local system.

## Prerequisites

Before you begin, ensure you have the following installed on your local machine:

1. **Node.js** (v18 or higher) - [Download here](https://nodejs.org/)
2. **npm** (comes with Node.js)
3. **Python** (v3.10 or higher) - [Download here](https://python.org/)
4. **uv** (Python package manager) - [Install here](https://docs.astral.sh/uv/)
5. **PostgreSQL** database (local or cloud instance like Neon)
6. **Git** (optional, for cloning)

## Step 1: Download the Project

### Option A: Download as ZIP
1. In your Replit workspace, click on the three dots menu (⋮)
2. Select "Download as zip"
3. Extract the zip file to your desired location

### Option B: Clone from GitHub (if connected)
```bash
git clone <your-github-repo-url>
cd <project-folder>
```

## Step 2: Install Dependencies

Open a terminal in the project directory and run:

```bash
# Install Node.js dependencies
npm install

# Install Python dependencies (uv will handle this automatically when needed)
# The Python packages are: numpy, pandas, scikit-learn, openai
```

## Step 3: Environment Setup

Create a `.env` file in the root directory with the following variables:

```env
# Database Configuration (Required)
DATABASE_URL=postgresql://username:password@localhost:5432/azure_cost_db

# PostgreSQL Connection Details
PGHOST=localhost
PGPORT=5432
PGUSER=your_username
PGPASSWORD=your_password
PGDATABASE=azure_cost_db

# Session Secret (Required)
SESSION_SECRET=your-super-secret-session-key-change-this

# OpenAI API Configuration (Required for AI features)
AI_INTEGRATIONS_OPENAI_API_KEY=sk-your-openai-api-key
AI_INTEGRATIONS_OPENAI_BASE_URL=https://api.openai.com/v1

# Email Service (Optional - for alerts and reports)
# Option 1: Resend
RESEND_API_KEY=your-resend-api-key

# Option 2: SendGrid
SENDGRID_API_KEY=your-sendgrid-api-key

# Development Environment
NODE_ENV=development
```

### How to Get These Values:

1. **Database URL**: 
   - Local PostgreSQL: `postgresql://postgres:password@localhost:5432/azure_cost_db`
   - Cloud (Neon): Sign up at [neon.tech](https://neon.tech) and copy your connection string

2. **Azure AD Authentication** (Required):
   - Go to [Azure Portal - App Registrations](https://portal.azure.com/#blade/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/RegisteredApps)
   - Click "New registration"
   - Enter app name (e.g., "Azure Cost Dashboard")
   - Select "Accounts in this organizational directory only" for single tenant
   - Set Redirect URI: Web platform, `http://localhost:5000/auth/callback`
   - Click "Register"
   - Copy **Application (client) ID** → `AZURE_CLIENT_ID`
   - Copy **Directory (tenant) ID** → `AZURE_TENANT_ID`
   - Go to "Certificates & secrets" → "New client secret"
   - Copy the secret value → `AZURE_CLIENT_SECRET`
   - Go to "Authentication" → Enable "ID tokens" and "Access tokens"

3. **OpenAI API Key**: 
   - Sign up at [platform.openai.com](https://platform.openai.com/)
   - Create an API key in your account settings

4. **Session Secret**: 
   - Generate a random string (min 32 characters)
   - Example: `openssl rand -base64 32` (run in terminal)

5. **Email Service** (optional):
   - Resend: Sign up at [resend.com](https://resend.com)
   - SendGrid: Sign up at [sendgrid.com](https://sendgrid.com)

## Step 4: Database Setup

1. **Create the database**:
```bash
# If using local PostgreSQL
createdb azure_cost_db

# Or connect to your PostgreSQL and run:
# CREATE DATABASE azure_cost_db;
```

2. **Push the database schema**:
```bash
npm run db:push
```

If you encounter any issues, use:
```bash
npm run db:push -- --force
```

## Step 5: Run the Application

Start the development server:

```bash
npm run dev
```

The application will be available at:
- **Frontend & Backend**: http://localhost:5000

You should see:
```
[express] serving on port 5000
```

## Step 6: Access the Dashboard

1. Open your browser and navigate to `http://localhost:5000`
2. You'll be redirected to the login page
3. Click "Sign in with Microsoft" to authenticate with your Azure AD account
4. After successful login, you'll see the Azure Cost Analysis Dashboard
5. Initially, it will use sample data since no Azure accounts are configured

## Step 7: Configure Azure Integration (Optional)

To analyze real Azure cost data:

1. Navigate to the Settings page in the dashboard
2. Click "Add Azure Account"
3. Provide:
   - Azure Tenant ID
   - Azure Client ID
   - Azure Client Secret
   - Subscription IDs (comma-separated)
4. The credentials will be encrypted and stored securely

## Troubleshooting

### Port Already in Use
If port 5000 is already in use, you can change it:

Edit `server/index.ts` and change the port:
```typescript
const PORT = process.env.PORT || 3000; // Change 5000 to 3000
```

Also update `vite.config.ts`:
```typescript
server: {
  port: 3000, // Match the new port
  strictPort: false,
  hmr: {
    port: 3000, // Match the new port
  },
}
```

### Database Connection Issues
- Ensure PostgreSQL is running: `pg_ctl status`
- Check your connection string in `.env`
- Verify your database exists: `psql -l`

### Python/ML Features Not Working
- Ensure Python 3.10+ is installed: `python --version`
- Install uv: `pip install uv`
- The Python scripts in `server/ml/` will be executed automatically

### Missing Dependencies
If you see module errors, run:
```bash
npm install
```

## Project Structure

```
├── client/              # Frontend React application
│   ├── src/
│   │   ├── components/  # React components
│   │   ├── pages/       # Page components
│   │   └── lib/         # Utilities
├── server/              # Backend Express server
│   ├── ml/              # Python ML scripts
│   ├── routes.ts        # API routes
│   └── index.ts         # Server entry point
├── shared/              # Shared types and schemas
│   └── schema.ts        # Database schema
├── .env                 # Environment variables (create this)
└── package.json         # Dependencies
```

## Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run db:push` - Push database schema changes
- `npm run db:studio` - Open Drizzle Studio (database GUI)

## Features Available Locally

All features work locally, including:
- ✅ Interactive cost visualizations
- ✅ Chart type switching (Line, Bar, Area, Pie)
- ✅ Light/Dark theme toggle
- ✅ AI-powered cost analysis (requires OpenAI API key)
- ✅ ML anomaly detection
- ✅ Cost forecasting
- ✅ CSV exports
- ✅ Email alerts (requires email service API key)

## Need Help?

- Check the console for error messages
- Verify all environment variables are set
- Ensure the database is running and accessible
- Make sure all dependencies are installed

## Production Deployment

For production deployment, you'll need to:
1. Set `NODE_ENV=production`
2. Use a production database
3. Set up proper SSL certificates
4. Configure a reverse proxy (nginx/Apache)
5. Use a process manager (PM2/systemd)

Alternatively, you can deploy back to Replit using the "Publish" button for automatic hosting with SSL and custom domains.
