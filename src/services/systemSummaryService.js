import mongoose from 'mongoose';
import { getDBStatus } from '../config/db.js';
import { getNextSMSHealth, isNextSMSConfigured } from './smsService.js';
import { isEmailConfigured } from './emailService.js';
import { isTwilioConfigured } from './notificationService.js';
const cache = new Map();
export function extractSmsBalance(value) {
  const candidates=[value?.data?.sms_balance,value?.data?.balance,value?.sms_balance,value?.balance,value?.data?.credits,value?.credits];
  for (const item of candidates) if ((typeof item==='number'||typeof item==='string') && String(item).trim()!=='' && Number.isFinite(Number(item)) && Number(item)>=0) return Number(item);
  return null;
}
export async function systemSection(section) {
  const old=cache.get(section); if(old && old.expires>Date.now()) return old.promise;
  const promise=(async()=>{
    const measuredAt=new Date().toISOString();
    if(section==='runtime') {
      const mem=process.memoryUsage();
      return {measuredAt,processMemoryBytes:mem.rss,heapUsedBytes:mem.heapUsed,heapAllocatedBytes:mem.heapTotal,hostingRamAvailableBytes:null,uptimeSeconds:Math.floor(process.uptime()),database:getDBStatus()};
    }
    if(section==='storage') {
      if(!mongoose.connection.db) throw new Error('unavailable');
      const stats=await mongoose.connection.db.stats({scale:1,maxTimeMS:5000});
      const names=(await mongoose.connection.db.listCollections({}, {nameOnly:true}).toArray()).map(x=>x.name).filter(x=>x.endsWith('.files'));
      const files=await Promise.all(names.map(name=>mongoose.connection.db.collection(name).aggregate([{$group:{_id:null,bytes:{$sum:'$length'},count:{$sum:1}}}],{maxTimeMS:5000}).toArray()));
      return {measuredAt,databaseDataBytes:stats.dataSize,databaseStorageBytes:stats.storageSize,indexBytes:stats.indexSize,fileBytes:files.reduce((n,x)=>n+(x[0]?.bytes||0),0),fileCount:files.reduce((n,x)=>n+(x[0]?.count||0),0),externalStorageBytes:null,quotaBytes:null};
    }
    if(section==='messaging') {
      const sms=await getNextSMSHealth();
      return {measuredAt,sms:{configured:sms.configured,connected:sms.authenticated,remaining:extractSmsBalance(sms.balance)},email:{configured:isEmailConfigured()},whatsapp:{configured:isTwilioConfigured()}};
    }
    throw new Error('unavailable');
  })();
  cache.set(section,{expires:Date.now()+15000,promise});
  try{return await promise;}catch(error){cache.delete(section);throw error;}
}
export function clearSystemSummaryCache(){cache.clear();}
