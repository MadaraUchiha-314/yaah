import { describe, expect, test } from 'bun:test';

import { InProcessDurable } from '../../src/app/durable/in-process.ts';
import { durableContract } from '../../src/testing/durable-contract.ts';

let counter = 0;

durableContract(
  { describe, expect, test },
  'in-process',
  (deps) => Promise.resolve(new InProcessDurable(deps)),
  () => {
    counter += 1;
    return `task-${String(counter)}`;
  },
);
