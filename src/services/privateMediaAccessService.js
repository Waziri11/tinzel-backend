import {Order} from '../models/Order.model.js';
import {StaffUser} from '../models/StaffUser.model.js';
import {readSession,cookieValue,contactFingerprint,digest} from './accessSessionService.js';
import {permits} from './authorizationService.js';
export async function authorizePrivatePhoto(req,assetId,url){
 const clauses=[];if(assetId)clauses.push({'uploadedPhotos.assetId':assetId},{'uploadedPhotos.url':`/api/public/photos/${assetId}`},{'uploadedPhotos.url':`/api/public/media/assets/${assetId}`});if(url)clauses.push({'uploadedPhotos.url':url});
 const order=await Order.findOne({$or:clauses});if(!order)throw Object.assign(new Error('Photo not found'),{status:404});
 const kind=cookieValue(req,'staff')||req.headers.authorization?'staff':'client';
 const session=await readSession(req,kind);
 if(kind==='client'){if(session.subjectId!==String(order._id) || session.contactFingerprint!==digest(`${order.trackingId}|${order.clientWhatsApp}`))throw Object.assign(new Error('Photo access denied'),{status:403});return order;}
 const user=await StaffUser.findById(session.subjectId);
 if(!user?.isActive||user.deletedAt||session.role!==user.role||session.tokenVersion!==(user.tokenVersion||0)||session.contactFingerprint!==contactFingerprint(user)||user.mustChangePassword||(['admin','manager'].includes(user.role)&&!session.verifiedAt)||!permits(user,'photo.read',order))throw Object.assign(new Error('Photo access denied'),{status:403});
 return order;
}
