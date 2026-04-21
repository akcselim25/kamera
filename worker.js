import { ObjectDetector, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.js';

let detector = null;

async function init() {
    try {
        const resolver = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm');
        detector = await ObjectDetector.createFromOptions(resolver, {
            baseOptions: {
                modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite',
                delegate: 'GPU'
            },
            categoryAllowlist: ['person'],
            scoreThreshold: 0.40,
            maxResults: 15,
            runningMode: 'IMAGE' // IMAGE is better for worker processing frames individually
        });
        postMessage({ type: 'ready' });
    } catch (e) {
        postMessage({ type: 'error', error: e.toString() });
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
