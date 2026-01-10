import firebase from 'firebase/compat/app';
import { getFirestore, collection, addDoc, Firestore, getDocs, query, orderBy, deleteDoc, doc, getCountFromServer, where, limit, writeBatch } from 'firebase/firestore';
import { SynthLogItem, FirebaseConfig, VerifierItem } from '../types';
import { logger } from '../utils/logger';

let db: Firestore | null = null;
let app: any | null = null;

export interface SavedSession {
    id: string;
    name: string;
    createdAt: string;
    config: any;
}

const getEnvConfig = (): FirebaseConfig => {
    const env = (import.meta as any).env || {};
    return {
        apiKey: env.VITE_FIREBASE_API_KEY || '',
        authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || '',
        projectId: env.VITE_FIREBASE_PROJECT_ID || '',
        storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || '',
        messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
        appId: env.VITE_FIREBASE_APP_ID || ''
    };
};

export const initializeFirebase = async (config: FirebaseConfig): Promise<boolean> => {
    try {
        if (!config.apiKey || !config.projectId) {
            logger.warn("Invalid Firebase Config Provided");
            return false;
        }

        // Clean up existing app if re-initializing
        if (app) {
            try {
                await app.delete();
            } catch (e) {
                logger.warn("Failed to delete existing Firebase app", e);
            }
        } else {
            // Check for default app created elsewhere (e.g. hot reload)
            const apps = firebase.apps;
            if (apps.length > 0) {
                await Promise.all(apps.map(a => a.delete()));
            }
        }

        app = firebase.initializeApp(config);
        db = getFirestore(app);
        logger.log("Firebase Initialized Successfully via dynamic config");
        return true;
    } catch (e) {
        console.error("Firebase Initialization Failed:", e);
        return false;
    }
};

// Auto-init on load if env vars exist
const envConfig = getEnvConfig();
if (envConfig.apiKey) {
    initializeFirebase(envConfig).catch(console.error);
}

export const isFirebaseConfigured = () => !!db;

export const saveLogToFirebase = async (log: SynthLogItem, collectionName: string = 'synth_logs') => {
    if (!db) {
        throw new Error("Firebase is not configured. Set keys in GUI or .env.");
    }

    try {
        // Explicitly construct data to save
        const docData: any = {
            sessionUid: log.sessionUid || 'unknown',
            seed_preview: log.seed_preview,
            full_seed: log.full_seed,
            query: log.query,
            reasoning: log.reasoning,
            answer: log.answer,
            timestamp: log.timestamp,
            duration: log.duration || 0,
            tokenCount: log.tokenCount || 0,
            modelUsed: log.modelUsed,
            createdAt: new Date()
        };

        if (log.deepMetadata) {
            // Firestore doesn't support undefined values, so we must sanitize or convert to null
            const cleanMetadata: any = { ...log.deepMetadata };
            Object.keys(cleanMetadata).forEach(key => {
                if (cleanMetadata[key] === undefined) {
                    delete cleanMetadata[key]; // Remove undefined keys
                }
            });
            docData.deepMetadata = cleanMetadata;
        }

        if (log.deepTrace) {
            docData.deepTrace = log.deepTrace;
        }

        await addDoc(collection(db, collectionName), docData);
    } catch (e) {
        console.error("Error saving to Firebase:", e);
        throw e;
    }
};

export const getDbStats = async (currentSessionUid?: string): Promise<{ total: number, session: number }> => {
    if (!db) return { total: 0, session: 0 };
    try {
        const coll = collection(db, 'synth_logs');

        // Parallel fetch for efficiency
        const totalPromise = getCountFromServer(coll);
        let sessionPromise = Promise.resolve({ data: () => ({ count: 0 }) });

        if (currentSessionUid) {
            const q = query(coll, where("sessionUid", "==", currentSessionUid));
            sessionPromise = getCountFromServer(q);
        }

        const [totalSnap, sessionSnap] = await Promise.all([totalPromise, sessionPromise]);

        return {
            total: totalSnap.data().count,
            session: sessionSnap.data().count
        };
    } catch (e) {
        console.error("Failed to fetch DB stats", e);
        return { total: 0, session: 0 };
    }
};

export const saveSessionToFirebase = async (sessionData: any, name: string) => {
    if (!db) throw new Error("Firebase not initialized");
    try {
        await addDoc(collection(db, 'synth_sessions'), {
            name,
            config: sessionData,
            createdAt: new Date().toISOString()
        });
    } catch (e) {
        console.error("Error saving session", e);
        throw e;
    }
};

export const getSessionsFromFirebase = async (): Promise<SavedSession[]> => {
    if (!db) throw new Error("Firebase not initialized");
    try {
        const q = query(collection(db, 'synth_sessions'), orderBy('createdAt', 'desc'));
        const snapshot = await getDocs(q);
        return snapshot.docs.map(d => ({
            id: d.id,
            ...d.data()
        } as SavedSession));
    } catch (e) {
        console.error("Error fetching sessions", e);
        throw e;
    }
};

export const deleteSessionFromFirebase = async (id: string) => {
    if (!db) throw new Error("Firebase not initialized");
    try {
        await deleteDoc(doc(db, 'synth_sessions', id));
    } catch (e) {
        console.error("Error deleting session", e);
        throw e;
    }
};

// --- Verifier Functions ---

export const fetchAllLogs = async (limitCount?: number, sessionUid?: string): Promise<VerifierItem[]> => {
    if (!db) throw new Error("Firebase not initialized");
    try {
        const constraints: any[] = [];

        // Filter by Session
        if (sessionUid) {
            constraints.push(where('sessionUid', '==', sessionUid));
        }

        // Ordering
        // Note: Using 'orderBy' combined with 'where' on different fields requires a composite index in Firestore.
        // To avoid breaking the app for users without indexes, we only orderBy createdAt if NO session filter is active,
        // or we accept that an index creation link will appear in console.
        // For safety/ease-of-use in this demo, we'll sort client-side if a specific session is requested to avoid index errors,
        // unless it's a simple query.
        constraints.push(orderBy('createdAt', 'desc'));

        // Limit
        if (limitCount && limitCount > 0) {
            constraints.push(limit(limitCount));
        }

        const q = query(collection(db, 'synth_logs'), ...constraints);

        const snapshot = await getDocs(q);

        return snapshot.docs.map(d => ({
            ...d.data(),
            id: d.id, // Use firestore ID
            score: 0 // Initialize score
        } as VerifierItem));
    } catch (e: any) {
        console.error("Error fetching logs", e);
        // Fallback: If index is missing for orderBy, try fetching without sort and sort locally
        if (e.code === 'failed-precondition' && sessionUid) {
            logger.warn("Falling back to client-side sort due to missing Firestore index.");
            const constraintsRetry: any[] = [where('sessionUid', '==', sessionUid)];
            if (limitCount && limitCount > 0) constraintsRetry.push(limit(limitCount));

            const qRetry = query(collection(db, 'synth_logs'), ...constraintsRetry);
            const snapRetry = await getDocs(qRetry);
            const items = snapRetry.docs.map(d => ({ ...d.data(), id: d.id, score: 0 } as VerifierItem));
            // Sort desc
            return items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        }
        throw e;
    }
};

export const saveFinalDataset = async (items: VerifierItem[], collectionName = 'synth_final') => {
    if (!db) throw new Error("Firebase not initialized");
    try {
        const batch = writeBatch(db);
        const coll = collection(db, collectionName);

        let count = 0;
        for (const item of items) {
            const docRef = doc(coll); // Auto ID
            const { id, isDuplicate, duplicateGroupId, isDiscarded, ...dataToSave } = item; // Strip internal flags, keep data
            batch.set(docRef, {
                ...dataToSave,
                verifiedAt: new Date().toISOString(),
                finalScore: item.score
            });
            count++;
        }

        await batch.commit();
        return count;
    } catch (e) {
        console.error("Error saving final dataset", e);
        throw e;
    }
};
