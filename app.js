/* DJ: Firebase-powered shared room chat + 1:1 WebRTC voice/video calls.
   Before use, insert your Firebase web settings into config.js.
   Firebase Cloud Storage requires the Blaze billing plan (see README).
*/
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getFirestore, collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, onSnapshot, query, where, orderBy, limitToLast, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { getStorage, ref as storageRef, uploadBytesResumable, getDownloadURL } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';

const $ = (id) => document.getElementById(id);
const nodes = Object.fromEntries([
  'welcomeView','chatView','entryForm','nameInput','roomInput','setupNotice','createBtn','joinBtn',
  'sidebar','sidebarScrim','menuBtn','closeSidebar','memberCount','memberList','sidebarRoomName',
  'roomTitle','headerMembers','meAvatar','meName','roomCodeDisplay','messageList','conversationContent',
  'messageInput','sendBtn','attachBtn','fileInput','uploadStatus','uploadLabel','uploadProgress',
  'inviteSidebarBtn','copyInviteBtn','leaveBtn','voiceBtn','videoBtn','peopleModal','closePeopleModal',
  'callPeopleList','peopleHelp','incomingModal','incomingTitle','incomingSubtitle','incomingAvatar',
  'acceptBtn','declineBtn','callOverlay','callStateText','audioPlaceholder','audioAvatar','audioPeerName',
  'localVideo','remoteVideo','remoteAudio','localPlaceholder','localPreview','micToggle','cameraToggle',
  'hangupBtn','callFooterText','toastArea'
].map((id) => [id,$(id)]));

const cfg = window.DJ_FIREBASE_CONFIG || {};
const configured = Boolean(cfg.apiKey && cfg.projectId && cfg.appId && !String(cfg.apiKey).includes('PASTE_') && !String(cfg.projectId).includes('YOUR_'));
let app, auth, db, storage;
let me = null, roomId = null, displayName = '';
let members = new Map();
let cleanup = [];
let activeCall = null, pendingIncoming = null, inviteCallType = 'audio';
let callingBusy = false, uploading = false;
const MAX_IMAGE = 15 * 1024 * 1024;
const MAX_VIDEO = 100 * 1024 * 1024;
const AVATAR_COLORS = [
  ['#d9d3ff','#564b9f'],['#c9e9d7','#326c57'],['#f8d4c8','#875843'],
  ['#cde4fd','#3f658e'],['#ffe7b9','#956f2f'],['#f4d3e8','#925078']
];
const ICE_SERVERS = [{ urls: [ 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302' ] }];

function errMessage(e) {
  const code = String(e?.code || '');
  if (code.includes('operation-not-allowed')) return 'Enable Anonymous sign-in in Firebase Authentication.';
  if (code.includes('permission-denied') || code.includes('unauthorized')) return 'Access denied. Check that your Firestore and Storage security rules are published.';
  if (code.includes('storage/quota-exceeded') || code.includes('storage/unknown')) return 'Media storage is unavailable. Confirm Firebase Storage and the Blaze plan are enabled.';
  if (code.includes('storage/retry-limit-exceeded')) return 'The upload timed out. Check your connection and try again.';
  if (code.includes('NotAllowedError')) return 'Allow camera/microphone access in your browser settings to make calls.';
  if (code.includes('NotFoundError')) return 'No working microphone/camera was found on this device.';
  return e?.message || 'Something went wrong. Please try again.';
}
function toast(message, error = false) {
  const el = document.createElement('div'); el.className = `toast${error ? ' error':''}`;
  el.textContent = message; nodes.toastArea.append(el);
  setTimeout(() => el.remove(), 4800);
}
function setBusy(busy) { nodes.createBtn.disabled = busy; nodes.joinBtn.disabled = busy; }
function firstLetter(s) { return (String(s || '?').trim().charAt(0) || '?').toUpperCase(); }
function colorPair(s) { let hash = 0; for (const c of String(s)) hash = (hash * 31 + c.charCodeAt(0)) | 0; return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]; }
function avatar(name, className = 'member-avatar') {
  const el = document.createElement('span'); el.className = className;
  const [bg,fg] = colorPair(name); el.style.background = bg; el.style.color = fg; el.textContent = firstLetter(name);
  return el;
}
function roomRef(id = roomId) { return doc(db, 'rooms', id); }
function membersCol(id = roomId) { return collection(db, 'rooms', id, 'members'); }
function messagesCol(id = roomId) { return collection(db, 'rooms', id, 'messages'); }
function callsCol(id = roomId) { return collection(db, 'rooms', id, 'calls'); }
function inviteUrl() { const url = new URL(window.location.href); url.searchParams.set('room', roomId); url.hash = ''; return url.toString(); }
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch { const temp = document.createElement('textarea');temp.value=text;temp.style.position='fixed';temp.style.opacity='0';document.body.append(temp);temp.select();const ok=document.execCommand('copy');temp.remove();if(!ok) throw Error('Clipboard unavailable'); }
}
function getCode(raw) {
  const input = String(raw || '').trim();
  try { const url = new URL(input); return (url.searchParams.get('room') || '').trim().toUpperCase(); }
  catch { return input.replace(/^#?room=/i, '').replace(/\s/g, '').toUpperCase(); }
}
function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(20); crypto.getRandomValues(bytes);
  return Array.from(bytes, (x) => chars[x % chars.length]).join('');
}
function validateName() {
  const name = nodes.nameInput.value.trim().replace(/\s+/g,' ');
  if (!name) { nodes.nameInput.focus(); toast('Enter your name to continue.',true); return null; }
  if (name.length > 40) { toast('Name is too long.',true); return null; }
  return name;
}
function requireConnected() {
  if (configured) return true;
  nodes.setupNotice.hidden = false;
  toast('First connect your Firebase project in config.js. See README.md.', true);
  return false;
}
async function ensureAuth() {
  if (!auth) throw Error('Firebase is not configured.');
  if (auth.currentUser) return auth.currentUser;
  const result = await signInAnonymously(auth);
  return result.user;
}
async function createRoom() {
  if (!requireConnected()) return;
  const name = validateName(); if (!name) return;
  setBusy(true);
  try {
    const user = await ensureAuth();
    const id = newCode();
    await setDoc(roomRef(id), { createdBy:user.uid, createdAt:serverTimestamp(), label: `${name}'s space` });
    await enterRoom(id, name, user, {label:`${name}'s space`});
    toast('Room created. Invite your friends!');
  } catch (e) { console.error(e); toast(errMessage(e), true); }
  finally { setBusy(false); }
}
async function joinRoom(raw = nodes.roomInput.value) {
  if (!requireConnected()) return;
  const name = validateName(); if (!name) return;
  const id = getCode(raw);
  if (!/^[A-HJ-NP-Z2-9]{20}$/.test(id)) { toast('Enter a valid DJ room code or invite link.',true); return; }
  setBusy(true);
  try {
    const user = await ensureAuth();
    const roomDoc = await getDoc(roomRef(id));
    if (!roomDoc.exists()) throw Error('Room not found. Please check the invitation link.');
    await enterRoom(id,name,user,roomDoc.data());
  } catch(e) { console.error(e); toast(errMessage(e),true); }
  finally { setBusy(false); }
}
async function enterRoom(id,name,user,data) {
  displayName = name; me = user;
  await setDoc(doc(membersCol(id),user.uid), { uid:user.uid, name:name, joinedAt:serverTimestamp() }, { merge:true });
  roomId = id;
  localStorage.setItem('dj_name',name);
  history.replaceState({},'',`${location.pathname}?room=${encodeURIComponent(id)}`);
  nodes.welcomeView.classList.add('hidden'); nodes.chatView.classList.remove('hidden');
  nodes.meName.textContent = name; nodes.meAvatar.textContent = firstLetter(name);
  nodes.roomTitle.textContent = data?.label || 'Our space';
  nodes.sidebarRoomName.textContent = data?.label || 'Our space';
  nodes.roomCodeDisplay.textContent = `ROOM · ${id.slice(0,6)}…`;
  nodes.messageInput.focus();
  listenRoom();
}
function unsubscribeRoom() {
  for (const unsub of cleanup.splice(0)) { try { unsub(); } catch(e) { console.warn(e); } }
  members.clear();
}
async function leaveRoom() {
  closePeopleModal(); nodes.incomingModal.classList.add('hidden'); pendingIncoming = null;
  if (activeCall) await endCall(true);
  const previousRoom = roomId;
  unsubscribeRoom(); roomId = null;
  history.replaceState({},'',location.pathname);
  nodes.chatView.classList.add('hidden'); nodes.welcomeView.classList.remove('hidden');
  nodes.roomInput.value=''; nodes.messageInput.value='';
  hideSidebar();
  try { if(previousRoom && me) await deleteDoc(doc(db,'rooms',previousRoom,'members',me.uid)); }
  catch(e){toast('Could not remove room membership: '+errMessage(e),true);}
}
function listenRoom() {
  cleanup.push(onSnapshot(membersCol(), (snap) => {
    members = new Map(snap.docs.map((d) => [d.id, d.data()]));
    renderMembers();
  }, (e)=>toast('Member list: ' + errMessage(e),true)));
  const mq = query(messagesCol(), orderBy('createdAt','asc'), limitToLast(150));
  cleanup.push(onSnapshot(mq, (snap) => renderMessages(snap.docs.map(d=>({...d.data(),id:d.id}))), (e)=>toast('Messages: '+errMessage(e),true)));
  const cq = query(callsCol(), where('to','==',me.uid));
  cleanup.push(onSnapshot(cq, (snap) => {
    const candidates = snap.docs.map((d)=>({id:d.id,...d.data()}))
      .filter((c)=>c.status==='ringing' && c.from !== me.uid && c.createdAt?.toMillis && Date.now()-c.createdAt.toMillis()<90_000)
      .sort((a,b)=>(b.createdAt?.toMillis?.()||0)-(a.createdAt?.toMillis?.()||0));
    if (!activeCall && !pendingIncoming && candidates.length) offerIncoming(candidates[0]);
    if (pendingIncoming && !candidates.some((c)=>c.id===pendingIncoming.id)) {
      pendingIncoming=null; nodes.incomingModal.classList.add('hidden');
    }
  }, (e)=>console.warn('Incoming call subscription:',e)));
}
function renderMembers() {
  nodes.memberCount.textContent = String(members.size);
  nodes.headerMembers.textContent = `${members.size} member${members.size===1?'':'s'}`;
  nodes.memberList.replaceChildren();
  const ordered = [...members.values()].sort((a,b)=>a.uid===me.uid?-1:b.uid===me.uid?1:String(a.name).localeCompare(String(b.name)));
  for (const member of ordered) {
    const row = document.createElement('div'); row.className='member-row';
    row.append(avatar(member.name));
    const info=document.createElement('div'); info.className='member-info';
    const name=document.createElement('strong'); name.textContent=member.name;
    const status=document.createElement('span');status.textContent=member.uid===me.uid?'You': 'Room member';
    info.append(name,status); row.append(info);nodes.memberList.append(row);
  }
}
function formatTime(value) {
  const time=value?.toDate ? value.toDate() : new Date();
  return time.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
}
function dateLabel(value) {
  const d=value?.toDate ? value.toDate() : new Date();
  const today=new Date(); if(d.toDateString()===today.toDateString()) return 'TODAY';
  const yesterday=new Date();yesterday.setDate(today.getDate()-1);
  if(d.toDateString()===yesterday.toDateString()) return 'YESTERDAY';
  return d.toLocaleDateString([], {day:'numeric',month:'short',year:'numeric'}).toUpperCase();
}
function safeHttpsUrl(value) {
  try { const u=new URL(value); return u.protocol==='https:' ? u.href : null; } catch { return null; }
}
function renderMessages(items) {
  const wrap=nodes.messageList, scroller=nodes.conversationContent;
  const nearBottom=scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<170;
  wrap.replaceChildren();
  if(!items.length) {
    const empty=document.createElement('div');empty.className='empty-state';
    const symbol=document.createElement('div');symbol.className='empty-illustration';symbol.textContent='✦';
    const title=document.createElement('h2');title.textContent='A space for connection.';
    const desc=document.createElement('p');desc.textContent='Say hello to start the conversation.';
    empty.append(symbol,title,desc);wrap.append(empty);return;
  }
  let lastDay='';
  for(const item of items) {
    const day=dateLabel(item.createdAt);
    if(day!==lastDay){const div=document.createElement('div');div.className='date-divider';div.textContent=day;wrap.append(div);lastDay=day;}
    const mine=item.senderId===me.uid;
    const row=document.createElement('div');row.className=`message-row ${mine?'mine':'theirs'}`;
    row.append(avatar(item.senderName||'?', 'message-avatar'));
    const main=document.createElement('div');main.className='message-main';
    const meta=document.createElement('div');meta.className='message-meta';
    const author=document.createElement('strong');author.textContent=mine?'You':String(item.senderName||'Guest');
    const when=document.createElement('span');when.textContent=formatTime(item.createdAt);
    meta.append(author,when);main.append(meta);
    const bubble=document.createElement('div');bubble.className='message-bubble';
    if((item.kind==='image'||item.kind==='video')&&safeHttpsUrl(item.mediaUrl)){
      bubble.classList.add('media-bubble');
      if(item.kind==='image'){
        const pic=document.createElement('img');pic.src=safeHttpsUrl(item.mediaUrl);pic.alt=item.mediaName||'Shared image';pic.loading='lazy';bubble.append(pic);
      }else{
        const vid=document.createElement('video');vid.src=safeHttpsUrl(item.mediaUrl);vid.controls=true;vid.playsInline=true;vid.preload='metadata';bubble.append(vid);
      }
      if(item.mediaName){const caption=document.createElement('div');caption.className='media-caption';caption.textContent=item.mediaName;bubble.append(caption);}
    }else { bubble.textContent=String(item.text||'[Media unavailable]'); }
    main.append(bubble);row.append(main);wrap.append(row);
  }
  if (nearBottom) requestAnimationFrame(()=>{scroller.scrollTop=scroller.scrollHeight;});
}
async function sendMessage(){
  if(!roomId||!me)return;
  const text=nodes.messageInput.value.trim();
  if(!text) return;
  if(text.length>4000){toast('Messages must be under 4,000 characters.',true);return;}
  nodes.messageInput.value='';autoResize();
  try {await addDoc(messagesCol(),{senderId:me.uid,senderName:displayName,kind:'text',text,createdAt:serverTimestamp()});}
  catch(e){nodes.messageInput.value=text;toast(errMessage(e),true);}
}
function autoResize(){ const box=nodes.messageInput;box.style.height='auto';box.style.height=`${Math.min(box.scrollHeight,150)}px`; }
async function uploadSelected(files){
  if(uploading){toast('An upload is already in progress.');return;}
  for(const file of files){
    if(!roomId||!me)return;
    const isImage=file.type.startsWith('image/'),isVideo=file.type.startsWith('video/');
    if(!isImage&&!isVideo){toast(`Unsupported file type: ${file.name}`,true);continue;}
    const limit=isImage?MAX_IMAGE:MAX_VIDEO;
    if(file.size>limit){toast(`${file.name} is too large. Limit: ${isImage?'15 MB':'100 MB'}.`,true);continue;}
    uploading=true;nodes.uploadStatus.classList.remove('hidden');nodes.uploadProgress.style.width='0%';
    nodes.uploadLabel.textContent=`Uploading ${file.name}…`;
    const id=roomId;const who=me.uid;
    try{
      const cleanName=(file.name||'media').replace(/[^a-zA-Z0-9._-]/g,'_').slice(-90);
      const key=(crypto.randomUUID?.()||newCode())+'-'+cleanName;
      const fileRef=storageRef(storage,`rooms/${id}/${who}/${key}`);
      const task=uploadBytesResumable(fileRef,file,{contentType:file.type});
      await new Promise((resolve,reject)=>task.on('state_changed',(snap)=>{
        const pct=snap.totalBytes?Math.round((snap.bytesTransferred/snap.totalBytes)*100):0;
        nodes.uploadProgress.style.width=pct+'%';nodes.uploadLabel.textContent=`Uploading ${file.name} · ${pct}%`;
      },reject,resolve));
      const url=await getDownloadURL(task.snapshot.ref);
      await addDoc(messagesCol(id),{senderId:who,senderName:displayName,kind:isImage?'image':'video',mediaUrl:url,mediaName:file.name.slice(0,140),mediaSize:file.size,createdAt:serverTimestamp()});
      toast(`${isImage?'Image':'Video'} shared successfully.`);
    }catch(e){console.error(e);toast(errMessage(e),true);}
    finally{uploading=false;nodes.uploadStatus.classList.add('hidden');nodes.uploadProgress.style.width='0%';}
  }
}
function showSidebar(){nodes.sidebar.classList.add('open');nodes.sidebarScrim.classList.remove('hidden');}
function hideSidebar(){nodes.sidebar.classList.remove('open');nodes.sidebarScrim.classList.add('hidden');}
async function copyInvite(){if(!roomId)return;try{await copyText(inviteUrl());toast('Invite link copied. Share it with a friend!');}catch(e){toast(errMessage(e),true);}}
function showPeopleModal(type){
  if(activeCall){toast('End your current call first.',true);return;}
  inviteCallType=type;
  nodes.peopleHelp.textContent=`Choose someone in this room for a ${type==='video'?'video':'voice'} call.`;
  nodes.callPeopleList.replaceChildren();
  const others=[...members.values()].filter(member=>member.uid!==me.uid);
  if(!others.length){const info=document.createElement('p');info.className='no-people';info.textContent='No one else has joined yet. Copy the invite link and ask a friend to join.';nodes.callPeopleList.append(info);}
  for(const member of others){
    const person=document.createElement('div');person.className='call-person';
    person.append(avatar(member.name));
    const name=document.createElement('strong');name.textContent=member.name;person.append(name);
    const btn=document.createElement('button');btn.type='button';btn.textContent='Call ↗';
    btn.addEventListener('click',()=>{closePeopleModal();startCall(member,inviteCallType);});
    person.append(btn);nodes.callPeopleList.append(person);
  }
  nodes.peopleModal.classList.remove('hidden');
}
function closePeopleModal(){nodes.peopleModal.classList.add('hidden');}
function offerIncoming(candidate){
  pendingIncoming=candidate;
  nodes.incomingTitle.textContent=`${candidate.fromName||'Someone'} is calling`;
  nodes.incomingSubtitle.textContent=candidate.type==='video'?'Incoming video call':'Incoming voice call';
  nodes.incomingAvatar.textContent=firstLetter(candidate.fromName);
  nodes.incomingModal.classList.remove('hidden');
}
async function declineIncoming(){
  const offered=pendingIncoming;pendingIncoming=null;nodes.incomingModal.classList.add('hidden');
  if(offered){try{await updateDoc(doc(callsCol(),offered.id),{status:'declined',endedAt:serverTimestamp()});}catch(e){console.warn(e);}}
}
function videoUI(type,peer){
  nodes.callOverlay.classList.remove('hidden');
  nodes.audioPlaceholder.classList.remove('hidden');nodes.remoteVideo.classList.remove('video-active');
  nodes.audioAvatar.textContent=firstLetter(peer);nodes.audioPeerName.textContent=peer;
  nodes.callStateText.textContent=`Calling ${peer}…`;
  nodes.cameraToggle.classList.toggle('hidden',type!=='video');
  nodes.localPreview.classList.toggle('hidden',type!=='video');
  nodes.localPlaceholder.classList.add('hidden');
  nodes.micToggle.classList.remove('off');nodes.cameraToggle.classList.remove('off');
}
function applyRemoteVideo(type){
  if(type==='video'){
    nodes.audioPlaceholder.classList.add('hidden');nodes.remoteVideo.classList.add('video-active');
    nodes.remoteVideo.play().catch(()=>{nodes.callStateText.textContent='Tap the video to enable playback';});
  }else{nodes.remoteAudio.play().catch(()=>{nodes.callStateText.textContent='Tap anywhere to enable audio';});}
}
async function getLocalMedia(type){
  if(!navigator.mediaDevices?.getUserMedia) throw Error('Microphone and camera access require HTTPS (or localhost) and a supported browser.');
  return await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:type==='video'?{facingMode:'user',width:{ideal:960},height:{ideal:720}}:false});
}
function makePeer(callObj){
  const pc=new RTCPeerConnection({iceServers:ICE_SERVERS});
  const remote=new MediaStream();
  callObj.pc=pc;callObj.remote=remote;callObj.pendingCandidates=[];callObj.remoteDescriptionReady=false;callObj.closed=false;
  pc.ontrack=event=>{
    for(const track of event.streams[0]?.getTracks()||[event.track]){
      if(!remote.getTracks().find((t)=>t.id===track.id))remote.addTrack(track);
    }
    if(callObj.type==='video')nodes.remoteVideo.srcObject=remote;
    else nodes.remoteAudio.srcObject=remote;
    applyRemoteVideo(callObj.type);
  };
  pc.onconnectionstatechange=()=>{
    if(activeCall!==callObj)return;
    if(pc.connectionState==='connected')nodes.callStateText.textContent=`Connected with ${callObj.peerName}`;
    if(pc.connectionState==='failed') {toast('Call connection failed. A TURN server may be needed on this network.',true);endCall(true);}
    if(pc.connectionState==='closed')endCall(false);
  };
  for(const track of callObj.local.getTracks())pc.addTrack(track,callObj.local);
  if(callObj.type==='video'){
    nodes.localVideo.srcObject=callObj.local;
    nodes.localVideo.play().catch(()=>{});
  }
  return pc;
}
function watchCandidates(callObj,kind){
  callObj.unsubCandidates=onSnapshot(collection(doc(callsCol(),callObj.id),kind),(snapshot)=>{
    for(const change of snapshot.docChanges()){
      if(change.type!=='added')continue;
      if(activeCall!==callObj)continue;
      const item=change.doc.data();
      if(!item?.candidate)continue;
      if(callObj.remoteDescriptionReady){callObj.pc.addIceCandidate(new RTCIceCandidate(item)).catch(console.warn);}
      else callObj.pendingCandidates.push(item);
    }
  },e=>console.warn('ICE candidate issue',e));
}
async function setRemote(callObj,description){
  if(!description||activeCall!==callObj||callObj.remoteDescriptionReady)return;
  await callObj.pc.setRemoteDescription(new RTCSessionDescription(description));
  callObj.remoteDescriptionReady=true;
  for(const item of callObj.pendingCandidates.splice(0)){
    try{await callObj.pc.addIceCandidate(new RTCIceCandidate(item));}catch(e){console.warn(e);}
  }
}
function watchCall(callObj){
  callObj.unsubCall=onSnapshot(doc(callsCol(),callObj.id),async(snapshot)=>{
    if(activeCall!==callObj||!snapshot.exists())return;
    const data=snapshot.data();
    if(['ended','declined','missed'].includes(data.status)){
      const word=data.status==='declined'?'Call declined':data.status==='missed'?'No answer':'Call ended';
      toast(word);endCall(false);return;
    }
    if(callObj.role==='caller'&&data.answer&&!callObj.remoteDescriptionReady){
      try {await setRemote(callObj,data.answer);nodes.callStateText.textContent=`Connecting to ${callObj.peerName}…`;}
      catch(e){console.error(e);toast(errMessage(e),true);endCall(true);}
    }
  },e=>{console.error(e);toast(errMessage(e),true);});
}
async function startCall(person,type){
  if(!roomId||!me||callingBusy||activeCall)return;
  if(!window.RTCPeerConnection){toast('This browser does not support live calls.',true);return;}
  callingBusy=true;
  let stream;
  try{
    stream=await getLocalMedia(type);
    if(!roomId){stream.getTracks().forEach(t=>t.stop());return;}
    const ref=doc(callsCol());
    const callObj={id:ref.id,role:'caller',type,peerName:person.name,local:stream,room:roomId};
    activeCall=callObj;
    videoUI(type,person.name);
    const pc=makePeer(callObj);
    let parentReady = false;
    const earlyCandidates=[];
    const publishCandidate=(candidate)=>addDoc(collection(ref,'offerCandidates'),candidate).catch(console.warn);
    pc.onicecandidate=(event)=>{
      if(!event.candidate)return;
      const candidate=event.candidate.toJSON();
      if(parentReady)publishCandidate(candidate);else earlyCandidates.push(candidate);
    };
    const offer=await pc.createOffer();await pc.setLocalDescription(offer);
    await setDoc(ref,{from:me.uid,fromName:displayName,to:person.uid,type,status:'ringing',offer:{type:offer.type,sdp:offer.sdp},createdAt:serverTimestamp()});
    parentReady=true;earlyCandidates.forEach(publishCandidate);
    watchCandidates(callObj,'answerCandidates');watchCall(callObj);
    callObj.ringTimer=setTimeout(async()=>{
      if(activeCall===callObj&&!callObj.remoteDescriptionReady){
        try{await updateDoc(ref,{status:'missed',endedAt:serverTimestamp()});}catch(e){console.warn(e);}
        toast('No answer.');endCall(false);
      }
    },60_000);
  }catch(e){console.error(e);toast(errMessage(e),true);if(activeCall)await endCall(true);else stream?.getTracks().forEach(t=>t.stop());}
  finally{callingBusy=false;}
}
async function acceptIncoming(){
  const offered=pendingIncoming;
  if(!offered||activeCall||callingBusy)return;
  pendingIncoming=null;nodes.incomingModal.classList.add('hidden');callingBusy=true;
  let stream;
  try{
    if(!window.RTCPeerConnection)throw Error('This browser does not support WebRTC calls.');
    stream=await getLocalMedia(offered.type);
    const callObj={id:offered.id,role:'recipient',type:offered.type,peerName:offered.fromName||'Friend',local:stream,room:roomId};
    activeCall=callObj;videoUI(offered.type,callObj.peerName);
    const pc=makePeer(callObj);const ref=doc(callsCol(),offered.id);
    pc.onicecandidate=(e)=>{if(e.candidate)addDoc(collection(ref,'answerCandidates'),e.candidate.toJSON()).catch(console.warn);};
    watchCandidates(callObj,'offerCandidates');
    await setRemote(callObj,offered.offer);
    const answer=await pc.createAnswer();await pc.setLocalDescription(answer);
    await updateDoc(ref,{answer:{type:answer.type,sdp:answer.sdp},status:'connected'});
    watchCall(callObj);nodes.callStateText.textContent=`Connecting to ${callObj.peerName}…`;
  }catch(e){console.error(e);toast(errMessage(e),true);
    if(activeCall)await endCall(true);else{stream?.getTracks().forEach(t=>t.stop());try{await updateDoc(doc(callsCol(),offered.id),{status:'declined',endedAt:serverTimestamp()});}catch{}}
  }finally{callingBusy=false;}
}
async function endCall(publishEnd){
  const callObj=activeCall;if(!callObj||callObj.closed)return;
  callObj.closed=true;activeCall=null;
  clearTimeout(callObj.ringTimer);
  try{callObj.unsubCall?.();callObj.unsubCandidates?.();}catch{}
  callObj.pc?.close();callObj.local?.getTracks().forEach(t=>t.stop());
  nodes.localVideo.srcObject=null;nodes.remoteVideo.srcObject=null;nodes.remoteAudio.srcObject=null;
  nodes.callOverlay.classList.add('hidden');
  if(publishEnd && db && callObj.room){
    try{await updateDoc(doc(db,'rooms',callObj.room,'calls',callObj.id),{status:'ended',endedAt:serverTimestamp(),endedBy:me.uid});}catch(e){console.warn(e);}
  }
}
function toggleMic(){
  if(!activeCall)return;
  const tracks=activeCall.local.getAudioTracks();if(!tracks.length)return;
  const next=!tracks[0].enabled;tracks.forEach(t=>t.enabled=next);
  nodes.micToggle.classList.toggle('off',!next);nodes.micToggle.title=next?'Mute microphone':'Unmute microphone';
}
function toggleCamera(){
  if(!activeCall)return;
  const tracks=activeCall.local.getVideoTracks();if(!tracks.length)return;
  const next=!tracks[0].enabled;tracks.forEach(t=>t.enabled=next);
  nodes.cameraToggle.classList.toggle('off',!next);nodes.cameraToggle.title=next?'Turn camera off':'Turn camera on';
  nodes.localPlaceholder.classList.toggle('hidden',next);
}
function registerEvents(){
  nodes.createBtn.addEventListener('click',createRoom);
  nodes.joinBtn.addEventListener('click',()=>joinRoom());
  nodes.entryForm.addEventListener('submit',e=>{e.preventDefault();nodes.roomInput.value.trim()?joinRoom():createRoom();});
  nodes.sendBtn.addEventListener('click',sendMessage);
  nodes.messageInput.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}});
  nodes.messageInput.addEventListener('input',autoResize);
  nodes.attachBtn.addEventListener('click',()=>nodes.fileInput.click());
  nodes.fileInput.addEventListener('change',e=>{const files=[...e.target.files];e.target.value='';uploadSelected(files);});
  nodes.inviteSidebarBtn.addEventListener('click',copyInvite);nodes.copyInviteBtn.addEventListener('click',copyInvite);
  nodes.leaveBtn.addEventListener('click',leaveRoom);
  nodes.menuBtn.addEventListener('click',showSidebar);nodes.closeSidebar.addEventListener('click',hideSidebar);nodes.sidebarScrim.addEventListener('click',hideSidebar);
  nodes.voiceBtn.addEventListener('click',()=>showPeopleModal('audio'));nodes.videoBtn.addEventListener('click',()=>showPeopleModal('video'));
  nodes.closePeopleModal.addEventListener('click',closePeopleModal);
  nodes.peopleModal.addEventListener('click',e=>{if(e.target===nodes.peopleModal)closePeopleModal();});
  nodes.declineBtn.addEventListener('click',declineIncoming);nodes.acceptBtn.addEventListener('click',acceptIncoming);
  nodes.hangupBtn.addEventListener('click',()=>endCall(true));nodes.micToggle.addEventListener('click',toggleMic);nodes.cameraToggle.addEventListener('click',toggleCamera);
  nodes.callOverlay.addEventListener('click',()=>{if(activeCall)applyRemoteVideo(activeCall.type);});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){closePeopleModal();hideSidebar();}});
  window.addEventListener('pagehide',()=>{activeCall?.local?.getTracks().forEach(t=>t.stop());});
}
async function boot(){
  registerEvents();
  const savedName=localStorage.getItem('dj_name');if(savedName)nodes.nameInput.value=savedName;
  const urlRoom=new URLSearchParams(location.search).get('room');if(urlRoom)nodes.roomInput.value=urlRoom;
  if(!configured){nodes.setupNotice.hidden=false;return;}
  try{
    app=initializeApp(cfg);auth=getAuth(app);db=getFirestore(app);storage=getStorage(app);
    await new Promise((resolve)=>{const unsub=onAuthStateChanged(auth,()=>{unsub();resolve();},()=>{unsub();resolve();});});
    if(urlRoom&&savedName)await joinRoom(urlRoom);
  }catch(e){console.error(e);toast('Firebase connection issue: '+errMessage(e),true);}
}
boot();
