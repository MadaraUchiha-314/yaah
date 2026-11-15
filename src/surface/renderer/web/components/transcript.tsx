/**
 * The conversation: what the user said, what the agent answered and did, what it asks,
 * and what commands replied. Everything an agent or a tool wrote is shown as plain text.
 */
import { ArrowDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import type { CommandInfo } from '../../../../app/api-server/extensions/index.ts';
import { t } from '../../../../kernel/strings.ts';
import type { TaskView, TranscriptItem } from '../../../view.ts';
import type { ActionMessage } from '../a2ui/stage.ts';
import type { Block, TurnPart } from '../lib/blocks.ts';
import { toBlocks } from '../lib/blocks.ts';
import { readCommand, splitCommand } from '../lib/command.ts';
import { plainText } from '../lib/text.ts';
import { A2uiBlock } from './a2ui-block.tsx';
import { ToolGroup } from './tool-group.tsx';
import { Bubble, BubbleContent } from './ui/bubble.tsx';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from './ui/message-scroller.tsx';
import { Message, MessageContent, MessageHeader } from './ui/message.tsx';

/** Props of {@link Transcript}. */
export interface TranscriptProps {
  readonly view: TaskView;
  /** The commands the harness lists, to colour a command the user sent. */
  readonly commands: readonly CommandInfo[];
  /** Receives a user's action on an A2UI surface. */
  readonly onAction: (message: ActionMessage) => void;
}

type Handlers = Pick<TranscriptProps, 'commands' | 'onAction'>;

function UserMessage({ text, commands }: { text: string } & Pick<Handlers, 'commands'>): ReactNode {
  const { first, rest } = splitCommand(plainText(text));
  const isCommand = readCommand(text, commands).command !== null;
  return (
    <Message align="end" data-slot="user-message">
      <MessageContent>
        <Bubble align="end" variant="muted" className="max-w-[85%]">
          <BubbleContent className="text-[0.9375rem] whitespace-pre-wrap">
            {isCommand ? (
              <>
                <span data-slot="command" className="font-mono font-medium text-command">
                  {first}
                </span>
                {rest}
              </>
            ) : (
              plainText(text)
            )}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

/** A request for input: boxed, tinted and labelled, so it cannot pass for an answer. */
export function AskBlock({ text }: { readonly text: string }): ReactNode {
  return (
    <section
      data-slot="ask"
      aria-label={t('view.ask.label')}
      className="rounded-xl border border-attention bg-attention-soft px-3 py-2.5"
    >
      <p className="text-xs font-semibold tracking-wider text-attention uppercase">
        {t('view.ask.label')}
      </p>
      <p className="mt-1 whitespace-pre-wrap text-foreground">{plainText(text)}</p>
    </section>
  );
}

function Answer({
  item,
  onAction,
}: {
  item: Extract<TranscriptItem, { kind: 'agent' }>;
} & Pick<Handlers, 'onAction'>): ReactNode {
  return (
    <>
      {item.text !== '' && (
        <p
          data-slot="answer"
          data-streaming={item.streaming}
          className="whitespace-pre-wrap data-[streaming=true]:streaming-caret"
        >
          {plainText(item.text)}
        </p>
      )}
      <A2uiBlock batches={item.a2ui} onAction={onAction} />
    </>
  );
}

function Part({ part, onAction }: { part: TurnPart } & Pick<Handlers, 'onAction'>): ReactNode {
  if (part.kind === 'tools') {
    return <ToolGroup calls={part.calls} />;
  }
  return part.kind === 'ask' ? (
    <AskBlock text={part.text} />
  ) : (
    <Answer item={part} onAction={onAction} />
  );
}

function BlockView({ block, commands, onAction }: { block: Block } & Handlers): ReactNode {
  if (block.kind === 'user') {
    return <UserMessage text={block.text} commands={commands} />;
  }
  if (block.kind === 'note') {
    return (
      <p data-slot="note" className="text-center text-xs text-muted-foreground">
        {plainText(block.text)}
      </p>
    );
  }
  return (
    <Message data-slot="agent-turn">
      <MessageContent className="text-[0.9375rem] leading-relaxed">
        <MessageHeader className="px-0">{t('web.who.agent')}</MessageHeader>
        {block.parts.map((part) => (
          <Part key={`${part.kind}-${part.id}`} part={part} onAction={onAction} />
        ))}
      </MessageContent>
    </Message>
  );
}

/** The scrolling log of the conversation; new content is announced politely. */
export function Transcript({ view, commands, onAction }: TranscriptProps): ReactNode {
  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent
            role="log"
            aria-live="polite"
            aria-label={t('web.log.label')}
            aria-busy={view.state === 'working'}
            className="mx-auto w-full max-w-3xl gap-5 px-4 pt-6 pb-3"
          >
            {toBlocks(view.items).map((block) => (
              <MessageScrollerItem
                key={`${block.kind}-${block.id}`}
                messageId={`${block.kind}-${block.id}`}
                scrollAnchor={block.kind === 'user'}
              >
                <BlockView block={block} commands={commands} onAction={onAction} />
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton aria-label={t('web.scroll.end')}>
          <ArrowDownIcon aria-hidden="true" />
        </MessageScrollerButton>
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
