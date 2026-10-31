const copy = {
  order_submitted: ['Verify payment', 'Thibitisha malipo', 'A new magazine order from {client} awaits payment verification.', 'Oda mpya ya jarida kutoka kwa {client} inasubiri uthibitisho wa malipo.'],
  payment_verified: ['Payment confirmed', 'Malipo yamethibitishwa', 'Your payment is confirmed. Use your tracking number to follow your magazine.', 'Malipo yako yamethibitishwa. Tumia namba ya ufuatiliaji kufuatilia jarida lako.'],
  assignment_queued: ['Assign a designer', 'Mkabidhi mbunifu', 'Payment is verified, but no designer has capacity. Assign a designer to this order.', 'Malipo yamethibitishwa lakini hakuna mbunifu mwenye nafasi. Mkabidhi mbunifu oda hii.'],
  order_assigned: ['Your design task is ready', 'Kazi yako ya usanifu iko tayari', 'You have been assigned the magazine for {client}. Open the order and begin design.', 'Umekabidhiwa jarida la {client}. Fungua oda na uanze usanifu.'],
  draft_uploaded: ['Design completed — review required', 'Usanifu umekamilika — kagua rasimu', 'Magazine version {version} for {client} is completed and awaits your review.', 'Toleo la {version} la jarida la {client} limekamilika na linasubiri ukaguzi wako.'],
  draft_released: ['Your magazine awaits approval', 'Jarida lako linasubiri idhini', 'Your magazine version {version} is ready. Review the entire magazine and approve it or request corrections.', 'Toleo la {version} la jarida lako liko tayari. Kagua jarida zima, uliidhinishe au uombe marekebisho.'],
  draft_returned: ['Magazine corrections required', 'Marekebisho ya jarida yanahitajika', 'The manager requested corrections to version {version}. Open the order and address every correction.', 'Meneja ameomba marekebisho ya toleo la {version}. Fungua oda na ukamilishe kila rekebisho.'],
  client_revision_requested: ['Customer requested corrections', 'Mteja ameomba marekebisho', 'The customer requested corrections to version {version}. The assigned designer must complete the correction list.', 'Mteja ameomba marekebisho ya toleo la {version}. Mbunifu aliyekabidhiwa akamilishe orodha ya marekebisho.'],
  client_approved: ['Customer approved — prepare print file', 'Mteja ameidhinisha — andaa faili la uchapishaji', 'The customer approved version {version}. The assigned designer must prepare the final print file.', 'Mteja ameidhinisha toleo la {version}. Mbunifu aliyekabidhiwa aandaye faili la mwisho la uchapishaji.'],
  print_document_uploaded: ['Authorize printing', 'Idhinisha uchapishaji', 'The final print file is ready. Review the file and authorize printing.', 'Faili la mwisho la uchapishaji liko tayari. Likague na uidhinishe uchapishaji.'],
  print_dispatched: ['New print job', 'Kazi mpya ya uchapishaji', 'A magazine is authorized for printing. Review the WhatsApp document and specifications. Reply POKEA {ref} to acknowledge.', 'Jarida limeidhinishwa kuchapishwa. Kagua faili na maelekezo ya WhatsApp. Jibu POKEA {ref} kuthibitisha.'],
  printing_in_progress: ['Printing started', 'Uchapishaji umeanza', 'Printing of this magazine has been acknowledged and is in progress.', 'Uchapishaji wa jarida hili umethibitishwa na unaendelea.'],
  printing_completed: ['Printing complete — arrange delivery', 'Uchapishaji umekamilika — andaa usafirishaji', 'Printing is complete. Arrange the courier and authorize delivery.', 'Uchapishaji umekamilika. Andaa msafirishaji na uidhinishe usafirishaji.'],
  order_dispatched: ['Your magazine has been dispatched', 'Jarida lako limesafirishwa', 'Your magazine has been dispatched. Courier: {carrier}. Tracking reference: {tracking}.', 'Jarida lako limesafirishwa. Msafirishaji: {carrier}. Namba ya ufuatiliaji: {tracking}.'],
  order_closed: ['Magazine delivered', 'Jarida limewasilishwa', 'Delivery has been confirmed and the order is complete. Thank you for choosing Tinzel.', 'Uwasilishaji umethibitishwa na oda imekamilika. Asante kwa kuchagua Tinzel.'],
};
export const language = value => value === 'en' ? 'en' : 'sw';
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function workflowMessage(type, order, event, recipient, lang, actionUrl) {
  const sw = language(lang) === 'sw';
  const words = type === 'order_submitted' && recipient.role === 'client'
    ? ['Order received','Oda imepokelewa','Your magazine order has been received. Complete payment so the manager can verify it and issue your tracking number.','Oda yako ya jarida imepokelewa. Kamilisha malipo ili meneja ayathibitishe na akupe namba ya ufuatiliaji.']
    : copy[type];
  if (!words) throw new Error('Unsupported workflow notification');
  const ref = order.trackingId || order.submissionId;
  const vars = { client: order.clientName, version: event.version || 1, ref, carrier: order.dispatchDetails?.carrier || '—', tracking: order.dispatchDetails?.trackingReference || '—' };
  const fill = text => text.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? ''));
  const title = `${words[sw ? 1 : 0]}: ${ref}`;
  let text = `Tinzel · ${ref}\n${fill(words[sw ? 3 : 2])}`;
  if (actionUrl) text += `\n${actionUrl}`;
  if (type === 'print_dispatched' && recipient.channel === 'whatsapp') {
    const specs = order.printDocument?.specs || {};
    text += `\n${sw ? 'Nakala' : 'Copies'}: ${specs.quantity || 1}\n${sw ? 'Karatasi' : 'Paper'}: ${specs.paperType || '—'}\n${sw ? 'Kava' : 'Cover'}: ${specs.coverFinish || '—'}\nBinding: ${specs.binding || '—'}`;
  }
  return { title, message: text, html: `<html lang="${language(lang)}"><body><h2>${escape(title)}</h2><p>${escape(text).replaceAll('\n','<br>')}</p>${actionUrl ? `<p><a href="${escape(actionUrl)}">${sw ? 'Fungua Tinzel' : 'Open Tinzel'}</a></p>` : ''}</body></html>` };
}
