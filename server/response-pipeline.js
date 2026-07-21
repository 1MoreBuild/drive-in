import { pipeline } from "stream/promises";

const RESPONSE_PIPELINE_MAX_LISTENERS = 16;

export async function pipelineToResponse(source, response) {
  const previousMaxListeners = response.getMaxListeners();
  // stream.pipeline installs several temporary close/error listeners in
  // addition to our request metrics and cancellation listeners. Raise the
  // per-response limit only while that bounded pipeline is active.
  if (previousMaxListeners < RESPONSE_PIPELINE_MAX_LISTENERS) {
    response.setMaxListeners(RESPONSE_PIPELINE_MAX_LISTENERS);
  }
  try {
    await pipeline(source, response);
  } finally {
    response.setMaxListeners(previousMaxListeners);
  }
}
