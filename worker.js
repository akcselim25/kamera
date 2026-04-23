let detector = null;

const DB_NAME = 'MediaPipeCache';
const STORE_NAME = 'models';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite';

async function getCachedModel() {
    return new Promise((resolve) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
        req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction(STORE_NAME, 'readonly');
            const getReq = tx.objectStore(STORE_NAME).get(MODEL_URL);
            getReq.onsuccess = () => resolve(getReq.result);
            getReq.onerror = () => resolve(null);
        };
        req.onerror = () => resolve(null);
    });
}

async function cacheModel(buffer) {
    return new Promise((resolve) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(buffer, MODEL_URL);
            tx.oncomplete = () => resolve();
        };
        req.onerror = () => resolve();
    });
}

async function init() {
    try {
        postMessage({ type: 'progress', message: 'Hafıza Kontrol Ediliyor...' });
        let buffer = await getCachedModel();
        
        if (!buffer) {
            postMessage({ type: 'progress', message: 'Yapay Zeka Modeli İndiriliyor (3MB)...' });
            const resp = await fetch(MODEL_URL);
            const arrayBuf = await resp.arrayBuffer();
            buffer = new Uint8Array(arrayBuf);
            await cacheModel(buffer);
            postMessage({ type: 'progress', message: 'Model Kaydedildi!' });
        } else {
            postMessage({ type: 'progress', message: 'Model Hafızadan Yüklendi 🚀' });
        }

        const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.js');
        const { ObjectDetector, FilesetResolver } = vision;

        postMessage({ type: 'progress', message: 'Yapay Zeka Çekirdeği Başlatılıyor...' });
        const resolver = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm');
        detector = await ObjectDetector.createFromOptions(resolver, {
            baseOptions: {
                modelAssetBuffer: buffer,
                delegate: 'CPU'
            },
            categoryAllowlist: ['person'],
            scoreThreshold: 0.40,
            maxResults: 15,
            runningMode: 'IMAGE'
        });
        postMessage({ type: 'ready' });
    } catch (e) {
        postMessage({ type: 'error', error: e.toString() + " | " + e.stack });
    }
}

self.onmessage = async (e) => {
    if (e.data.type === 'init') {
        init();
    } else if (e.data.type === 'detect') {
        if (!detector) return;
        const bitmap = e.data.bitmap;
        // In worker, we just process the bitmap as a static image for that moment
        const results = detector.detect(bitmap);
        postMessage({ type: 'result', detections: results.detections });
        bitmap.close(); // free memory immediately
    }
};
