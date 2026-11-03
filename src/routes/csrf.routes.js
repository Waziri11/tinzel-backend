import { Router } from 'express';
import { readSession } from '../services/accessSessionService.js';
import { csrfError, isAllowedOrigin } from '../services/csrfService.js';

const router = Router();
router.get('/:kind', async (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  res.vary('Cookie');
  res.vary('Origin');
  try {
    if (!['staff', 'client', 'printer'].includes(req.params.kind)) return res.sendStatus(404);
    if ((req.headers.origin && !isAllowedOrigin(req.headers.origin)) ||
        (!req.headers.origin && req.headers['sec-fetch-site'] === 'cross-site')) throw csrfError('CSRF_ORIGIN_INVALID');
    const session = await readSession(req, req.params.kind);
    res.json({ csrf: session.csrf });
  } catch (error) { next(error); }
});
export default router;
