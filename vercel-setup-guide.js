#!/usr/bin/env node

/**
 * Vercel Environment Variables Setup Guide
 * This script shows exactly what needs to be configured in Vercel Dashboard
 */

require('dotenv').config();

function showVercelConfig() {
    console.log('=== Vercel Environment Variables Setup ===\n');
    
    console.log('🔧 REQUIRED ENVIRONMENT VARIABLES IN VERCEL DASHBOARD:\n');
    
    const envVars = [
        {
            name: 'FIREBASE_SERVICE_ACCOUNT_JSON',
            value: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
            description: 'Firebase service account JSON (full string)',
            type: 'Plain Text'
        },
        {
            name: 'GOOGLE_CLIENT_ID', 
            value: process.env.GOOGLE_CLIENT_ID,
            description: 'Google OAuth 2.0 Client ID',
            type: 'Plain Text'
        },
        {
            name: 'GOOGLE_CLIENT_SECRET',
            value: process.env.GOOGLE_CLIENT_SECRET,
            description: 'Google OAuth 2.0 Client Secret',
            type: 'Secret'
        },
        {
            name: 'NEXT_PUBLIC_BASE_URL',
            value: 'https://rin-xzyqrn.vercel.app',
            description: 'Public base URL for the application',
            type: 'Plain Text'
        }
    ];
    
    envVars.forEach(env => {
        const status = env.value ? '✅' : '❌';
        const displayValue = env.value ? 
            (env.name.includes('SECRET') || env.name.includes('TOKEN') ? 
                env.value.substring(0, 20) + '...' : 
                env.value.substring(0, 50) + '...') : 
            'NOT SET';
        
        console.log(`${status} ${env.name}`);
        console.log(`   Current: ${displayValue}`);
        console.log(`   Type: ${env.type}`);
        console.log(`   Description: ${env.description}\n`);
    });
    
    console.log('📋 STEPS TO CONFIGURE IN VERCEL:\n');
    console.log('1. Go to Vercel Dashboard > Your Project > Settings > Environment Variables');
    console.log('2. Add each variable above with the correct type');
    console.log('3. Make sure to select the correct environments (Production, Preview, Development)');
    console.log('4. Redeploy your application');
    
    console.log('\n🔍 REDIRECT URI CONFIGURATION:\n');
    console.log('Make sure this is added to Google Cloud Console:');
    console.log('https://rin-xzyqrn.vercel.app/api/auth/google/callback');
    
    console.log('\n⚠️  IMPORTANT NOTES:');
    console.log('- FIREBASE_SERVICE_ACCOUNT_JSON should be the complete JSON string');
    console.log('- GOOGLE_CLIENT_SECRET should be marked as "Secret" in Vercel');
    console.log('- After configuring, redeploy the application');
    console.log('- Check Vercel Function Logs for debugging output');
}

showVercelConfig();
