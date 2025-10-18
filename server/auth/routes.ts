import { Router, type Request, type Response, type NextFunction } from "express";
import passport from "passport";
import { type User } from "@shared/schema";

const router = Router();

// Type augmentation for user in request
declare global {
  namespace Express {
    interface User extends Omit<import("@shared/schema").User, 'createdAt'> {
      createdAt: Date;
    }
  }
}

// Check if Azure AD is configured
const isAzureConfigured = Boolean(
  process.env.AZURE_TENANT_ID && 
  process.env.AZURE_CLIENT_ID && 
  process.env.AZURE_CLIENT_SECRET
);

// Login route - redirect to Azure AD (only if configured)
router.get('/login', (req: Request, res: Response, next: NextFunction) => {
  if (!isAzureConfigured) {
    return res.status(503).json({
      error: 'Authentication not configured',
      message: 'Azure AD authentication is not set up. Please configure Azure AD credentials in environment variables.',
    });
  }
  
  passport.authenticate('azuread-openidconnect', { 
    failureRedirect: '/',
    prompt: 'select_account'
  })(req, res, next);
});

// Callback route - Azure AD redirects here after authentication
router.post('/callback', (req: Request, res: Response, next: NextFunction) => {
  if (!isAzureConfigured) {
    return res.redirect('/');
  }
  
  passport.authenticate('azuread-openidconnect', { 
    failureRedirect: '/',
  }, (err: any, user: any) => {
    if (err || !user) {
      console.error('Authentication error:', err);
      return res.redirect('/');
    }
    
    // Regenerate session after authentication (security best practice)
    req.session.regenerate((sessionErr: any) => {
      if (sessionErr) {
        console.error('Session regeneration error:', sessionErr);
        return res.redirect('/');
      }
      
      // Re-establish login after session regeneration
      req.logIn(user, (loginErr: any) => {
        if (loginErr) {
          console.error('Login error after session regeneration:', loginErr);
          return res.redirect('/');
        }
        res.redirect('/');
      });
    });
  })(req, res, next);
});

// Also handle GET callback for certain Azure AD configurations
router.get('/callback', (req: Request, res: Response, next: NextFunction) => {
  if (!isAzureConfigured) {
    return res.redirect('/');
  }
  
  passport.authenticate('azuread-openidconnect', { 
    failureRedirect: '/',
  }, (err: any, user: any) => {
    if (err || !user) {
      console.error('Authentication error:', err);
      return res.redirect('/');
    }
    
    req.session.regenerate((sessionErr: any) => {
      if (sessionErr) {
        console.error('Session regeneration error:', sessionErr);
        return res.redirect('/');
      }
      
      req.logIn(user, (loginErr: any) => {
        if (loginErr) {
          console.error('Login error after session regeneration:', loginErr);
          return res.redirect('/');
        }
        res.redirect('/');
      });
    });
  })(req, res, next);
});

// Logout route
router.get('/logout', (req: Request, res: Response, next: NextFunction) => {
  req.logout((err: any) => {
    if (err) {
      console.error('Logout error:', err);
      return next(err);
    }
    
    req.session.destroy((destroyErr: any) => {
      if (destroyErr) {
        console.error('Session destroy error:', destroyErr);
      }
      
      // Redirect to Azure AD logout to clear SSO session
      const cloudInstance = process.env.AZURE_CLOUD_INSTANCE || 'https://login.microsoftonline.com/';
      const tenantId = process.env.AZURE_TENANT_ID || 'common';
      const postLogoutRedirectUri = process.env.APPLICATION_URL || 'http://localhost:5000';
      
      const logoutUrl = `${cloudInstance}${tenantId}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(postLogoutRedirectUri)}`;
      res.redirect(logoutUrl);
    });
  });
});

// Check authentication status
router.get('/status', (req: Request, res: Response) => {
  if (req.isAuthenticated() && req.user) {
    const user = req.user as Express.User;
    res.json({
      authenticated: true,
      configured: isAzureConfigured,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    });
  } else {
    res.json({ 
      authenticated: false,
      configured: isAzureConfigured,
    });
  }
});

export default router;
