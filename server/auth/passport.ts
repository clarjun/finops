import passport from "passport";
import { OIDCStrategy } from "passport-azure-ad";
import { type User, users, insertUserSchema } from "@shared/schema";
import { db } from "../db";
import { eq } from "drizzle-orm";

export interface AzureProfile {
  oid: string;
  displayName: string;
  _json: {
    email?: string;
    preferred_username?: string;
    given_name?: string;
    family_name?: string;
    name?: string;
  };
}

export function initializePassport() {
  // Check if Azure AD credentials are configured
  const isAzureConfigured = Boolean(
    process.env.AZURE_TENANT_ID && 
    process.env.AZURE_CLIENT_ID && 
    process.env.AZURE_CLIENT_SECRET
  );

  if (!isAzureConfigured) {
    console.warn('\n⚠️  Azure AD authentication is not configured.');
    console.warn('Please set the following environment variables:');
    console.warn('  - AZURE_TENANT_ID');
    console.warn('  - AZURE_CLIENT_ID');
    console.warn('  - AZURE_CLIENT_SECRET');
    console.warn('See LOCAL_SETUP.md for setup instructions.\n');
    
    // Setup dummy serialization for development
    passport.serializeUser((user: any, done) => {
      done(null, user);
    });
    
    passport.deserializeUser((user: any, done) => {
      done(null, user);
    });
    
    return;
  }

  const config = {
    identityMetadata: `${process.env.AZURE_CLOUD_INSTANCE || 'https://login.microsoftonline.com/'}${process.env.AZURE_TENANT_ID}/v2.0/.well-known/openid-configuration`,
    clientID: process.env.AZURE_CLIENT_ID,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
    responseType: 'code id_token',
    responseMode: 'form_post',
    redirectUrl: process.env.AZURE_REDIRECT_URI || 'http://localhost:5000/auth/callback',
    allowHttpForRedirectUrl: process.env.NODE_ENV === 'development',
    validateIssuer: false,
    passReqToCallback: true as const,
    scope: ['openid', 'profile', 'email'],
    loggingLevel: process.env.NODE_ENV === 'development' ? 'info' as const : 'error' as const,
    nonceLifetime: 3600,
    nonceMaxAmount: 5,
    useCookieInsteadOfSession: false,
  };

  passport.use(
    new OIDCStrategy(
      config,
      async (
        req: any,
        iss: string,
        sub: string,
        profile: AzureProfile,
        accessToken: string,
        refreshToken: string,
        params: any,
        done: (error: any, user?: any) => void
      ) => {
        try {
          if (!profile.oid) {
            return done(new Error('No OID found in user profile'));
          }

          const azureId = profile.oid;
          const email = profile._json.email || profile._json.preferred_username || '';
          const name = profile.displayName || profile._json.name || '';
          const firstName = profile._json.given_name || '';
          const lastName = profile._json.family_name || '';

          // Check if user exists
          const existingUsers = await db
            .select()
            .from(users)
            .where(eq(users.azureId, azureId))
            .limit(1);

          let user: User;

          if (existingUsers.length > 0) {
            // Update last login time
            const updated = await db
              .update(users)
              .set({ lastLogin: new Date() })
              .where(eq(users.azureId, azureId))
              .returning();
            user = updated[0];
          } else {
            // Create new user
            const newUser = await db
              .insert(users)
              .values({
                azureId,
                email,
                name,
                firstName,
                lastName,
                lastLogin: new Date(),
              })
              .returning();
            user = newUser[0];
          }

          return done(null, user);
        } catch (error) {
          console.error('Error in Azure AD authentication:', error);
          return done(error);
        }
      }
    )
  );

  // Serialize user to session
  passport.serializeUser((user: any, done) => {
    done(null, user.id);
  });

  // Deserialize user from session
  passport.deserializeUser(async (id: number, done) => {
    try {
      const userResult = await db
        .select()
        .from(users)
        .where(eq(users.id, id))
        .limit(1);

      if (userResult.length === 0) {
        return done(new Error('User not found'));
      }

      done(null, userResult[0]);
    } catch (error) {
      done(error);
    }
  });
}

// Middleware to check if user is authenticated
export function ensureAuthenticated(req: any, res: any, next: any) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized', message: 'Please login to access this resource' });
}
