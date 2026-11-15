/**
 * Prints the history of a demo task's workflow, one event per line, read from Temporal
 * with the same connection settings as the demo harness:
 *
 *   bun run scripts/demo/history.ts <taskId>
 */
import { Client, Connection } from '@temporalio/client';
import { temporal } from '@temporalio/proto';

import { ensureKey } from '../../test/live/keys.ts';

const [taskId = ''] = process.argv.slice(2);
const remote = (process.env['YAAH_DEMO_DURABLE'] ?? 'temporal-remote') === 'temporal-remote';
ensureKey('TEMPORAL_API_KEY', 'temporal');

const connection = await Connection.connect(
  remote
    ? {
        address: process.env['YAAH_DEMO_TEMPORAL_ADDRESS'] ?? 'yaah.gtebu.tmprl.cloud:7233',
        tls: true,
        apiKey: process.env['TEMPORAL_API_KEY'] ?? '',
      }
    : { address: '127.0.0.1:17233' },
);
const namespace = remote
  ? (process.env['YAAH_DEMO_TEMPORAL_NAMESPACE'] ?? 'yaah.gtebu')
  : 'default';
const handle = new Client({ connection, namespace }).workflow.getHandle(`yaah-${taskId}`);
const description = await handle.describe();
console.log(`workflow ${description.workflowId} — ${description.status.name}`);
const history = await handle.fetchHistory();
for (const event of history.events ?? []) {
  const code = event.eventType ?? 0;
  const type = (temporal.api.enums.v1.EventType[code] ?? String(code)).replace('EVENT_TYPE_', '');
  const activity = event.activityTaskScheduledEventAttributes?.activityType?.name ?? '';
  const signal = event.workflowExecutionSignaledEventAttributes?.signalName ?? '';
  console.log(`${String(event.eventId).padStart(4)}  ${type} ${activity}${signal}`.trimEnd());
}
await connection.close();
