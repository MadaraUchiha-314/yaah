/** The agent card: what the harness tells the world it is and speaks. */
import type { AgentCard, AgentExtension } from '@a2a-js/sdk';

import type { CommandInfo, DurableExecutionParams } from './extensions/index.ts';
import { EXT } from './extensions/index.ts';

/** The path of the JSON-RPC binding, relative to the harness's base URL. */
export const JSONRPC_PATH = '/a2a';
/** The path of the HTTP+JSON binding, relative to the harness's base URL. */
export const REST_PATH = '/a2a/rest';

/** What the card is built from. */
export interface AgentCardInit {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  /** Where the harness listens, without a trailing slash. */
  readonly baseUrl: string;
  readonly commands: readonly CommandInfo[];
  readonly durable: DurableExecutionParams;
  /** Extensions contributed by plugins (A2UI, …). */
  readonly extensions?: readonly AgentExtension[] | undefined;
}

function extension(uri: string, description: string, params?: object): AgentExtension {
  return {
    uri,
    description,
    required: false,
    params: params === undefined ? undefined : { ...params },
  };
}

function yaahExtensions(init: AgentCardInit): AgentExtension[] {
  return [
    extension(
      EXT.taskLifecycle,
      'Keep a task open across turns; sub-states of input-required; complete a task.',
    ),
    extension(
      EXT.taskModel,
      'Goal, acceptance criteria, participants, parent and sub tasks of a task.',
    ),
    extension(EXT.inboxEvents, 'A2A task events as inbox input; interrupting messages.'),
    extension(EXT.commands, 'Slash commands the harness understands.', {
      commands: init.commands,
    }),
    extension(
      EXT.durableExecution,
      'How tasks are executed durably, and where to watch them.',
      init.durable,
    ),
    extension(EXT.activity, 'Tool calls as they start and finish, on working status updates.'),
    ...(init.extensions ?? []),
  ];
}

/**
 * Builds the agent card.
 *
 * Every yaah-specific protocol element is listed as an extension, none of them required:
 * a client that knows none still talks plain A2A. No security scheme is declared, because
 * this harness has none until an authentication plugin adds one.
 */
export function buildAgentCard(init: AgentCardInit): AgentCard {
  return {
    name: init.name,
    description: init.description,
    version: init.version,
    supportedInterfaces: [
      {
        url: `${init.baseUrl}${JSONRPC_PATH}`,
        protocolBinding: 'JSONRPC',
        tenant: '',
        protocolVersion: '1.0',
      },
      {
        url: `${init.baseUrl}${REST_PATH}`,
        protocolBinding: 'HTTP+JSON',
        tenant: '',
        protocolVersion: '1.0',
      },
    ],
    provider: undefined,
    capabilities: {
      streaming: true,
      pushNotifications: true,
      extendedAgentCard: false,
      extensions: yaahExtensions(init),
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'assist',
        name: 'Assist',
        description: init.description,
        tags: ['assistant'],
        examples: [],
        inputModes: [],
        outputModes: [],
        securityRequirements: [],
      },
    ],
    signatures: [],
  };
}
