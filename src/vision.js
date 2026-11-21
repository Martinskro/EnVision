import { FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision';

// Keep the WASM version identical to the npm package version (0.10.14).
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const DETECTOR_MODEL =
  'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';

let fileset = null;

async function getFileset() {
  if (!fileset) fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  return fileset;
}

// Tries GPU first, falls back to CPU. Add ?cpu to the URL to force CPU.
export async function createObjectDetector({ forceCpu = false } = {}) {
  const fs = await getFileset();
  const delegates = forceCpu ? ['CPU'] : ['GPU', 'CPU'];
  let lastErr = null;
  for (const delegate of delegates) {
    try {
      const detector = await ObjectDetector.createFromOptions(fs, {
        baseOptions: { modelAssetPath: DETECTOR_MODEL, delegate },
        runningMode: 'VIDEO',
        scoreThreshold: 0.2, // low on purpose: weak detections still help tracking; display filters at 0.3
        maxResults: 15,
      });
      return { detector, delegate };
    } catch (err) {
      console.warn(`ObjectDetector ${delegate} failed`, err);
      lastErr = err;
    }
  }
  throw lastErr;
}
