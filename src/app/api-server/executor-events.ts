/** Builders for the A2A events the executor publishes from what a task's run streams. */
import type { Task } from '@a2a-js/sdk';
import { TaskState } from '@a2a-js/sdk';
import type { AgentEvent } from '@a2a-js/sdk/server';

import type { Activity, StreamedAudio } from '../../harness/core/task-port.ts';
import type { HubEvent } from '../stream-hub.ts';
import { agentMessage, metadataObject, resultArtifact } from './convert.ts';
import { EXT } from './extensions/index.ts';
import { replyArtifactId, speechArtifactId } from './task-port.ts';

type StatusUpdate = Parameters<typeof AgentEvent.statusUpdate>[0];
type ArtifactUpdate = Parameters<typeof AgentEvent.artifactUpdate>[0];

/** A `working` status update that says what the agent is doing. Streamed, never stored. */
export function activityEvent(task: Task, activity: Activity): StatusUpdate {
  return {
    taskId: task.id,
    contextId: task.contextId,
    metadata: undefined,
    status: {
      state: TaskState.TASK_STATE_WORKING,
      timestamp: new Date().toISOString(),
      message: agentMessage({
        messageId: `activity-${activity.id}-${activity.phase}`,
        taskId: task.id,
        contextId: task.contextId,
        parts: [],
        metadata: metadataObject({ [EXT.activity]: activity }),
        extensions: [EXT.activity],
      }),
    },
  };
}

/** One piece of a spoken answer: raw audio, with how to play it as voice-extension data. */
function speechArtifact(artifactId: string, chunk: StreamedAudio): ArtifactUpdate['artifact'] {
  const { parts } = resultArtifact(artifactId, [
    { type: 'file', mediaType: chunk.mediaType, source: { kind: 'base64', data: chunk.data } },
  ]);
  const format = { sampleRate: chunk.sampleRate, channels: chunk.channels, encoding: 's16le' };
  return {
    artifactId,
    name: 'speech',
    description: '',
    parts,
    metadata: metadataObject({ [EXT.voice]: format }),
    extensions: [EXT.voice],
  };
}

/**
 * The artifact update for what a model call streamed or stored: a chunk appended to the
 * call's artifact, a reset that voids what was streamed, or the final content.
 */
export function artifactEvent(
  task: Task,
  event: Exclude<HubEvent, { type: 'status' | 'activity' }>,
): ArtifactUpdate {
  const base = { taskId: task.id, contextId: task.contextId, metadata: undefined };
  if (event.type === 'artifact') {
    const artifact = resultArtifact(event.artifactId, event.parts, event.name);
    return { ...base, artifact, append: false, lastChunk: true };
  }
  if (event.type === 'audio') {
    const artifact = speechArtifact(speechArtifactId(event.key), event.chunk);
    return { ...base, artifact, append: true, lastChunk: event.chunk.last };
  }
  const artifactId = replyArtifactId(event.key);
  if (event.type === 'reset') {
    // The step is being attempted again: what it streamed so far is void.
    return { ...base, artifact: resultArtifact(artifactId, []), append: false, lastChunk: false };
  }
  const artifact = resultArtifact(artifactId, [{ type: 'text', text: event.text }]);
  return { ...base, artifact, append: true, lastChunk: false };
}
