import { describe, expect, test } from 'bun:test';

import { rendererContract } from '../../src/testing/renderer-contract.ts';
import { renderToText } from '../support/tui.ts';

rendererContract({ describe, expect, test }, 'tui', (view) => Promise.resolve(renderToText(view)));
