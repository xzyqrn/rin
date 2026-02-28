import * as admin from 'firebase-admin';

if (!admin.apps.length) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
        if (Object.keys(serviceAccount).length > 0) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('Firebase admin initialized globally.');
        } else {
            console.warn('FIREBASE_SERVICE_ACCOUNT_JSON is empty or invalid.');
        }
    } catch (error) {
        console.error('Firebase admin initialization error', error);
    }
}

export const db = admin.apps.length ? admin.firestore() : null;
