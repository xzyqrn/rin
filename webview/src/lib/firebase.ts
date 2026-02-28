import * as admin from 'firebase-admin';

let db: admin.firestore.Firestore | null = null;

if (!admin.apps.length) {
    try {
        // In production (Vercel), environment variables are already loaded
        // In development, they should be available from .env loading
        const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
        
        if (!serviceAccountJson) {
            console.error('[Firebase] FIREBASE_SERVICE_ACCOUNT_JSON environment variable is not set');
        } else {
            const serviceAccount = JSON.parse(serviceAccountJson);
            if (Object.keys(serviceAccount).length === 0) {
                console.error('[Firebase] FIREBASE_SERVICE_ACCOUNT_JSON is empty');
            } else {
                admin.initializeApp({
                    credential: admin.credential.cert(serviceAccount)
                });
                console.log('[Firebase] Firebase admin initialized successfully.');
            }
        }
    } catch (error) {
        console.error('[Firebase] Firebase admin initialization error:', error);
        console.error('[Firebase] Error details:', error instanceof Error ? error.message : error);
    }
} else {
    // Firebase admin already initialized
}

db = admin.apps.length ? admin.firestore() : null;

if (!db) {
    console.error('[Firebase] Firebase Firestore is not available - Google authentication will not work');
    console.error('[Firebase] Please check FIREBASE_SERVICE_ACCOUNT_JSON environment variable');
}

export { db };
