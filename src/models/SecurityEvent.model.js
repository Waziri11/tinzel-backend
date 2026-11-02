import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  eventId: {type:String,required:true,unique:true},
  actorId: String, role: String, action: {type:String,required:true},
  orderId: String, version: Number, fileHash: String, requestId: String,
  ipAddress: String, outcome: String, transferId: String,
  createdAt: {type:Date,default:Date.now,immutable:true},
  expiresAt: {type:Date,required:true,index:{expireAfterSeconds:0}},
}, {versionKey:false});
for (const operation of ['updateOne','updateMany','findOneAndUpdate','replaceOne','findOneAndReplace','deleteOne','deleteMany','findOneAndDelete']) {
  schema.pre(operation, function () { throw new Error('Security events are append-only'); });
}
schema.pre('save',function(){if(!this.isNew)throw new Error('Security events are append-only');});
schema.index({createdAt:-1});
export const SecurityEvent = mongoose.model('SecurityEvent', schema);
const delivery = new mongoose.Schema({
  _id:String, exportedAt:Date, attempts:{type:Number,default:0},
  nextAttemptAt:{type:Date,default:Date.now}, leaseUntil:Date,
  expiresAt:{type:Date,required:true,index:{expireAfterSeconds:0}},
},{versionKey:false});
export const SecurityEventDelivery = mongoose.model('SecurityEventDelivery',delivery);
