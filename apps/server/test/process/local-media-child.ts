/**
 * Run by ./local-media.test.ts as a process of its own: a PDF reader in the
 * middle of a read when the process is told to stop.
 *
 * The reader's "program" is a stand-in the test wrote (a script that sleeps):
 * no PDF program is run. This process turns SIGTERM into an exit exactly as
 * the server does (src/index.ts), prints the folder the PDF is in once the
 * program is running, and waits. What the test then checks is what is left on
 * disk, and what is left running, after it has been stopped.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makePdfReader } from '../../src/pdf-text';
import { textPdf } from '../../src/synthetic-files';

const tmp = process.env.READER_TMP!;
const program = process.env.READER_PROGRAM!;
// As src/index.ts does.
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => process.exit(0));

const reader = makePdfReader({ reader: 'pdftotext', program }, { tmp });
void reader.read(textPdf([['A PDF that is being read when Flint is stopped: KEPTONDISKQ8.']]));
const started = Date.now();
const timer = setInterval(() => {
  const folders = readdirSync(tmp).filter((n) => n.startsWith('flint-pdf-'));
  const folder = folders[0];
  if (folder && readdirSync(join(tmp, folder, 'read.noindex')).includes('started')) {
    clearInterval(timer);
    console.log(`READING ${folder}`);
    // Stay alive, as a server does, until it is told to stop.
    setInterval(() => {}, 1000);
  } else if (Date.now() - started > 30_000) {
    console.log('NEVER STARTED');
    process.exit(3);
  }
}, 20);
