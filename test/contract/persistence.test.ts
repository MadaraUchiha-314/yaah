import { describe, expect, test } from 'bun:test';

import { createMemoryPersistence } from '../../src/harness/core/memory-persistence.ts';
import { persistenceContract } from '../../src/testing/persistence-contract.ts';

persistenceContract({ describe, expect, test }, createMemoryPersistence);
