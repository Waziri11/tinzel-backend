import mongoose from 'mongoose';
const sessionSchema=new mongoose.Schema({
 _id:String, kind:{type:String,enum:['staff','client','printer','tracking_device'],required:true}, subjectId:String,
 tokenVersion:Number, role:String, purpose:String, contactFingerprint:String,
 verifiedAt:Date, expiresAt:{type:Date,index:{expireAfterSeconds:0}}, idleUntil:Date,
 createdAt:{type:Date,default:Date.now}, lastSeenAt:Date, browser:String, ipAddress:String,
 csrf:String, previewId:String, scope:mongoose.Schema.Types.Mixed,
},{versionKey:false});
export const AccessSession=mongoose.model('AccessSession',sessionSchema);
const challengeSchema=new mongoose.Schema({
 _id:String, subjectId:String, purpose:String, channel:String, destination:String,
 codeHash:String, attempts:{type:Number,default:0}, consumedAt:Date, ready:{type:Boolean,default:false},
 expiresAt:{type:Date,index:{expireAfterSeconds:0}}, scope:mongoose.Schema.Types.Mixed,
},{versionKey:false});
export const AccessChallenge=mongoose.model('AccessChallenge',challengeSchema);
