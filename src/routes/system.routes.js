import { Router } from 'express';
import { verifyStaffToken, requireRoles } from '../middlewares/auth.middleware.js';
import { systemSection } from '../services/systemSummaryService.js';
const router=Router();
router.use(verifyStaffToken,requireRoles('admin','manager'));
router.get('/summary/:section',async(req,res)=>{
  res.set('Cache-Control','no-store');
  if(!['runtime','storage','messaging'].includes(req.params.section))return res.status(404).json({message:'Section not found.'});
  try{res.json({success:true,...await systemSection(req.params.section)});}catch{res.status(503).json({message:'System measurement unavailable.',measuredAt:new Date().toISOString()});}
});
export default router;
