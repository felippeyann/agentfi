// Test helper: tries to take the ledger lock, prints OK or BUSY, holds it for argv[3] ms, exits.
import { acquireInstanceLock } from '../../src/ledger.js';

const [, , ledgerPath, holdMs = '1500'] = process.argv;
try {
  acquireInstanceLock(ledgerPath!);
  console.log('OK');
  setTimeout(() => process.exit(0), Number(holdMs));
} catch {
  console.log('BUSY');
  process.exit(3);
}
