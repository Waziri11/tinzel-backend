import { randomUUID } from 'node:crypto';
const definitions = {
  PROOF_SOURCE_UNAVAILABLE: ['The magazine source file is unavailable. Contact staff with the reference below.', false],
  PROOF_PDF_ENCRYPTED: ['This PDF is password protected. Upload an unlocked PDF.', false],
  PROOF_PDF_INVALID: ['This PDF could not be read. Staff can inspect the original using the reference below.', false],
  PROOF_RENDERER_UNAVAILABLE: ['The rendering service is missing a required component. Contact staff.', false],
  PROOF_MEMORY_LIMIT: ['This page exceeded the rendering memory limit. Staff can retry it on the rendering service.', true],
  PROOF_TIMEOUT: ['Page preparation took too long. It will retry automatically.', true],
  PROOF_LEASE_LOST: ['The rendering worker restarted. Preparation will resume automatically.', true],
  PROOF_STORAGE_UNAVAILABLE: ['Magazine storage is temporarily unavailable. Preparation will retry.', true],
  PROOF_RENDER_FAILED: ['Page preparation failed. Contact staff with the reference below.', false],
};
export function proofDiagnostic(error) {
  let code = error.code;
  const message = String(error.message || error);
  if (!definitions[code]) {
    if (error.name === 'PasswordException' || /password|encrypted/i.test(message)) code = 'PROOF_PDF_ENCRYPTED';
    else if (error.status === 404 || /ENOENT|source.*unavailable|Draft PDF is unavailable|version is unavailable/i.test(message)) code = 'PROOF_SOURCE_UNAVAILABLE';
    else if (/ERR_DLOPEN_FAILED|Cannot find.*(?:canvas|sharp|pdf)|native binding|shared object|module.*not found|DOMMatrix is not defined/i.test(message)) code = 'PROOF_RENDERER_UNAVAILABLE';
    else if (/heap|out of memory|allocation failed|SIGKILL|memory limit/i.test(message)) code = 'PROOF_MEMORY_LIMIT';
    else if (error.name === 'TimeoutError' || /timed? ?out|timeout|deadline/i.test(message)) code = 'PROOF_TIMEOUT';
    else if (/lease|worker.*(?:stopped|exited|restart)/i.test(message)) code = 'PROOF_LEASE_LOST';
    else if (error.name === 'InvalidPDFException' || /invalid pdf|PDF.*limit|bad.*PDF|PDF.*corrupt/i.test(message)) code = 'PROOF_PDF_INVALID';
    else if (/ECONN|MongoNetwork|fetch failed|storage|503|502/i.test(message)) code = 'PROOF_STORAGE_UNAVAILABLE';
    else code = 'PROOF_RENDER_FAILED';
  }
  return { errorCode: code, errorReference: randomUUID(), publicMessage: definitions[code][0], retryable: definitions[code][1],
    error: message.replace(/Bearer\s+\S+|mongodb(?:\+srv)?:\/\/\S+|vercel_blob_rw_\S+/gi, '[redacted]').slice(0, 2000), errorName: error.name || 'Error' };
}
export function publicProofDiagnostic(job) {
  const diagnostic = definitions[job?.errorCode] || definitions.PROOF_RENDER_FAILED;
  return { code: job?.errorCode || 'PROOF_RENDER_FAILED', reference: job?.errorReference || String(job?._id || ''), message: diagnostic[0], retryable: diagnostic[1], page: job?.page, attempts: job?.attempts };
}
