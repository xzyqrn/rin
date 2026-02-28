#!/usr/bin/env node

/**
 * Vercel Deployment Checklist
 * Ensures everything is ready for production deployment
 */

require('dotenv').config();

function showDeploymentChecklist() {
    console.log('=== Vercel Deployment Checklist ===\n');
    
    console.log('🔧 PRE-DEPLOYMENT CHECKS:\n');
    
    // Check local environment
    const checks = [
        {
            name: 'FIREBASE_SERVICE_ACCOUNT_JSON',
            status: !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
            critical: true
        },
        {
            name: 'GOOGLE_CLIENT_ID',
            status: !!process.env.GOOGLE_CLIENT_ID,
            critical: true
        },
        {
            name: 'GOOGLE_CLIENT_SECRET',
            status: !!process.env.GOOGLE_CLIENT_SECRET,
            critical: true
        },
        {
            name: 'NEXT_PUBLIC_BASE_URL',
            status: !!process.env.NEXT_PUBLIC_BASE_URL,
            critical: true
        },
        {
            name: 'GOOGLE_OAUTH_BASE_URL',
            status: !!(process.env.GOOGLE_OAUTH_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL),
            critical: true
        }
    ];
    
    let allPassed = true;
    checks.forEach(check => {
        const status = check.status ? '✅' : '❌';
        const critical = check.critical ? ' (CRITICAL)' : '';
        console.log(`${status} ${check.name}${critical}`);
        if (!check.status && check.critical) allPassed = false;
    });
    
    if (allPassed) {
        console.log('\n✅ All local environment variables are set!');
    } else {
        console.log('\n❌ Some critical environment variables are missing locally');
        console.log('   Fix these before deploying to Vercel');
    }
    
    console.log('\n📋 VERCEL DEPLOYMENT STEPS:\n');
    console.log('1. Configure Environment Variables in Vercel Dashboard:');
    console.log('   - Go to Project > Settings > Environment Variables');
    console.log('   - Add all variables from the checklist above');
    console.log('   - Set GOOGLE_CLIENT_SECRET as "Secret"');
    console.log('   - Set GOOGLE_OAUTH_BASE_URL to your webview/Vercel app URL');
    console.log('   - Select Production, Preview, and Development environments');
    
    console.log('\n2. Deploy to Vercel:');
    console.log('   - Push changes to GitHub (if connected)');
    console.log('   - Or use Vercel CLI: vercel --prod');
    
    console.log('\n3. Post-Deployment Verification:');
    console.log('   - Check Vercel Function Logs for errors');
    console.log('   - Test Google OAuth flow');
    console.log('   - Verify tokens in Firestore');
    
    console.log('\n🔍 REDIRECT URI CONFIGURATION:');
    console.log('Make sure this is in Google Cloud Console:');
    const oauthBase = process.env.GOOGLE_OAUTH_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || 'https://your-vercel-app.vercel.app';
    console.log(`${oauthBase.replace(/\/+$/, '')}/api/auth/google/callback`);
    
    console.log('\n📊 DEBUGGING TIPS:');
    console.log('- Check Vercel Function Logs for detailed debugging');
    console.log('- Use browser dev tools to inspect network requests');
    console.log('- Verify Google Cloud Console redirect URIs match exactly');
    console.log('- Check Firebase rules allow write access to users collection');
    
    console.log('\n🚀 READY TO DEPLOY?');
    console.log(allPassed ? '✅ Yes! All checks passed.' : '❌ No. Fix missing variables first.');
}

showDeploymentChecklist();
