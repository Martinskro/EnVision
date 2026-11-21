import { FilesetResolver, HandLandmarker, ObjectDetector } from '@mediapipe/tasks-vision';

// Keep the WASM version identical to the npm package version (0.10.14).
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
// EfficientDet-Lite2 (448 px input) is clearly more accurate on small objects like a can than
// Lite0 (320 px) but slower. Add ?lite0 to the URL to switch back if fps drops too far.
const DETECTOR_VARIANT = new URLSearchParams(location.search).has('lite0') ? 'efficientdet_lite0' : 'efficientdet_lite2';
const DETECTOR_MODEL = `https://storage.googleapis.com/mediapipe-models/object_detector/${DETECTOR_VARIANT}/float16/1/${DETECTOR_VARIANT}.tflite`;
export const DETECTOR_NAME = DETECTOR_VARIANT.replace('efficientdet_', '');
const HAND_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

let fileset = null;

async function getFileset() {
  if (!fileset) fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  return fileset;
}

// Tries GPU first, falls back to CPU. Add ?cpu to the URL to force CPU.
async function createWithFallback(TaskClass, modelAssetPath, options, forceCpu) {
  const fs = await getFileset();
  const delegates = forceCpu ? ['CPU'] : ['GPU', 'CPU'];
  let lastErr = null;
  for (const delegate of delegates) {
    try {
      const task = await TaskClass.createFromOptions(fs, {
        baseOptions: { modelAssetPath, delegate },
        runningMode: 'VIDEO',
        ...options,
      });
      return { task, delegate };
    } catch (err) {
      console.warn(`${TaskClass.name} ${delegate} failed`, err);
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function createObjectDetector({ forceCpu = false } = {}) {
  const { task, delegate } = await createWithFallback(
    ObjectDetector,
    DETECTOR_MODEL,
    {
      scoreThreshold: 0.2, // low on purpose: weak detections still help tracking; display filters at 0.3
      maxResults: 15,
    },
    forceCpu,
  );
  return { detector: task, delegate };
}

export async function createHandLandmarker({ forceCpu = false } = {}) {
  const { task, delegate } = await createWithFallback(
    HandLandmarker,
    HAND_MODEL,
    {
      numHands: 1,
      minHandDetectionConfidence: 0.4,
      minHandPresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
    },
    forceCpu,
  );
  return { hands: task, delegate };
}
