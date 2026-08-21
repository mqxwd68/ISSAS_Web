/* =====================================================================
   ISSAS web — client
   All annotation is stored at NATIVE frame resolution. Zoom/pan are a pure
   display transform; screen->image conversion happens in toImg().
   ===================================================================== */

const $ = (id) => document.getElementById(id);
const API = {
  post: (url, body) => fetch(url, {method:'POST', headers:{'Content-Type':'application/json'},
                                   body: JSON.stringify(body||{})}).then(r=>r.json().then(j=>({ok:r.ok,j}))),
  get:  (url) => fetch(url).then(r=>r.json()),
};

// ---------- global state ----------
const S = {
  frames: [], count: 0, idx: 0, W: 0, H: 0,
  sam2: false, device: 'cpu',
  classMap: {},
  classGroups: {tissue:{}, instrument:{}},
  defaultPath: null,
  user: 'ISSAS_USER',
  objects: new Map(),     // objId -> {id, classId, name, color:[r,g,b], bin:Uint8Array, tint:Canvas|null, visible, centroid:[x,y]}
  order: [],              // objId order for W/S cycling & list
  currentId: null,
  // per-frame prompt state (display only)
  points: new Map(),      // objId -> [{x,y,label}]
  boxes:  new Map(),      // objId -> [x1,y1,x2,y2]
  // view transform (CSS px)
  scale: 1, panX: 0, panY: 0,
  // interaction
  brush: false, brushSize: 20, brushing: false, brushPositive: true,
  dragBox: false, boxStart: null, tempBox: null,
  panning: false, panStart: null, spaceDown: false,
  // visualization toggles
  vis: {fill:true, boundary:true, ids:true, points:true, boxes:false, all:true},
  visRev: 0,
  boxFlash: null,
  propagation: true,
  // post-processing params
  gauss: 17, morph: 17, comp: 1,
  // undo
  history: [], maxHistory: 15,
  dirty: false,            // unsaved human edits on the current frame
  refineSrc: null,         // when set, each new frame auto-imports this annotator's mask
  // sticky import folders: chosen once, then reused for every later import (Q / click)
  maskDir: null,
  promptsDir: null,
  // per-frame mask memory + object flash
  frameMasks: new Map(),   // frameIdx -> Map(objId -> Uint8Array bin)   [human-final]
  rawMasks: new Map(),     // frameIdx -> Map(objId -> {bin, kind, classId, locked})  [SAM2 raw]
  flash: null,             // {id, start, dur}
  img: null,               // HTMLImageElement of current frame
};

const V = {
  available: false, configured: false, fps: 0, duration: 0, name: null, caseName: null,
  clipStart: 0, clipEnd: 20, center: 0, mode: 'float', open: false,
  sourceKey: null, seekToken: 0, seekPending: false, fpsSource: null, frameIndex: 0,
  sourceFrames: null, compare: false,
  floatRect: null, playbackRate: 1, contextSeconds: 10, loop: false,
  workflow: {available:false,phaseNames:{},intervals:[]},
};

const CA = {
  open:false, mode:'dock', dirty:false, saveDir:null, importDir:null, defaultDir:null,
  floatRect:null, history:[], future:[], restoring:false, activeEditor:null, suggestions:[], suggestionIndex:0,
  drafts:new Map(), activeFrame:null, dockedVideoRect:null, caseRoot:null,
  appear:[], appearFrame:null, appearToken:0,
};
try{
  CA.mode=localStorage.getItem('issas.contextMode')||'dock';
}catch(_){}

// ---------- canvas ----------
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const mini = $('minimap');
const mctx = mini.getContext('2d');
let dpr = window.devicePixelRatio || 1;

function resizeCanvas(){
  const vp = $('viewport');
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(vp.clientWidth * dpr);
  canvas.height = Math.floor(vp.clientHeight * dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  mini.width = mini.clientWidth * dpr;
  mini.height = mini.clientHeight * dpr;
  mctx.setTransform(dpr,0,0,dpr,0,0);
  render();
}

// The viewport changes size for four reasons now: window resize, panel collapse,
// gutter drag and fullscreen. Keep whatever image point was at the centre at the
// centre, so zoom and position survive the change instead of drifting.
let lastVp=[0,0];
function onViewportResize(){
  const vp=$('viewport');
  const nw=vp.clientWidth, nh=vp.clientHeight;
  if(S.W && S.scale && lastVp[0] && lastVp[1] && (nw!==lastVp[0]||nh!==lastVp[1])){
    const ix=(lastVp[0]/2 - S.panX)/S.scale, iy=(lastVp[1]/2 - S.panY)/S.scale;
    S.panX = nw/2 - ix*S.scale;
    S.panY = nh/2 - iy*S.scale;
  }
  lastVp=[nw,nh];
  resizeCanvas();
}
if(window.ResizeObserver) new ResizeObserver(onViewportResize).observe($('viewport'));
window.addEventListener('resize', onViewportResize);

// ---------- helpers ----------
function toImg(sx, sy){ return [ (sx - S.panX)/S.scale, (sy - S.panY)/S.scale ]; }
function vpSize(){ const vp=$('viewport'); return [vp.clientWidth, vp.clientHeight]; }
function clampi(v,a,b){ return Math.max(a, Math.min(b, v)); }

function hslToRgb(h,s,l){
  h/=360; s/=100; l/=100;
  if(s===0){const v=Math.round(l*255); return [v,v,v];}
  const hue2=(p,q,t)=>{ if(t<0)t+=1; if(t>1)t-=1;
    if(t<1/6)return p+(q-p)*6*t; if(t<1/2)return q; if(t<2/3)return p+(q-p)*(2/3-t)*6; return p; };
  const q = l<0.5 ? l*(1+s) : l+s-l*s; const p=2*l-q;
  return [Math.round(hue2(p,q,h+1/3)*255), Math.round(hue2(p,q,h)*255), Math.round(hue2(p,q,h-1/3)*255)];
}
function colorForObj(objId){ return hslToRgb((objId*137.5)%360, 65, 60); }
function classNameForId(cid){
  for(const [n,i] of Object.entries(S.classMap)) if(i===cid) return n;
  return 'class '+cid;
}
function nameForObjId(objId){
  const cid = objId>999? Math.floor(objId/1000): objId;
  const suffix = objId%1000;
  return classNameForId(cid) + (suffix? ' '+suffix : '');
}

function toast(msg, kind){
  if(Array.isArray(msg)) msg = msg.map(e=> e&&e.msg? `${e.msg}${e.loc?' ('+e.loc.join('.')+')':''}` : String(e)).join('; ');
  else if(msg && typeof msg==='object') msg = msg.msg || JSON.stringify(msg);
  const t=$('toast'); t.textContent=msg; t.className='toast '+(kind||'');
  t.classList.remove('hidden');
  clearTimeout(t._t); t._t=setTimeout(()=>t.classList.add('hidden'), 2600);
}
function showOverlay(text){ $('overlayText').textContent=text||'Working…'; $('overlay').classList.remove('hidden'); }
function hideOverlay(){ $('overlay').classList.add('hidden'); }
// styled confirm dialog (replaces native confirm) -> Promise<bool>
function uiConfirm(message, opts){
  opts=opts||{};
  return new Promise(resolve=>{
    $('uiDialogTitle').textContent=opts.title||'Please confirm';
    $('uiDialogBody').textContent=message;
    const ok=$('uiDialogOk'), cancel=$('uiDialogCancel'), modal=$('uiDialog');
    const option=$('uiDialogOption'), check=$('uiDialogCheck');
    check.checked=false;
    option.classList.toggle('hidden', !opts.checkboxLabel);
    $('uiDialogCheckLabel').textContent=opts.checkboxLabel||'';
    ok.textContent=opts.okText||'OK';
    ok.style.cssText = opts.danger? 'background:#7a2a2a;border-color:#7a2a2a;color:#ffdede' : '';
    ok.className='btn '+(opts.danger?'':'btn-accent');
    modal.classList.remove('hidden');
    const done=(v)=>{
      const checked=check.checked;
      modal.classList.add('hidden'); option.classList.add('hidden');
      ok.onclick=cancel.onclick=modal.onclick=null;
      resolve(opts.checkboxLabel? {confirmed:v, checked:v&&checked} : v);
    };
    ok.onclick=()=>done(true); cancel.onclick=()=>done(false);
    modal.onclick=e=>{ if(e.target.id==='uiDialog') done(false); };
  });
}
// styled text-input dialog -> Promise<string|null>
function uiPrompt(message, opts){
  opts=opts||{};
  return new Promise(resolve=>{
    $('uiDialogTitle').textContent=opts.title||'Enter a value';
    $('uiDialogBody').innerHTML=`<div style="margin-bottom:10px">${message}</div><input id="uiDialogInput" class="path-input" style="width:100%" spellcheck="false" value="${(opts.value||'').replace(/"/g,'&quot;')}"/>`;
    const ok=$('uiDialogOk'), cancel=$('uiDialogCancel'), modal=$('uiDialog');
    ok.textContent=opts.okText||'Create'; ok.className='btn btn-accent'; ok.style.cssText='';
    modal.classList.remove('hidden');
    const inp=$('uiDialogInput'); setTimeout(()=>{ inp.focus(); inp.select(); },30);
    const done=(v)=>{ modal.classList.add('hidden'); ok.onclick=cancel.onclick=modal.onclick=inp.onkeydown=null; resolve(v); };
    ok.onclick=()=>done(inp.value.trim()||null);
    cancel.onclick=()=>done(null);
    inp.onkeydown=e=>{ if(e.key==='Enter'){ e.preventDefault(); done(inp.value.trim()||null); } };
    modal.onclick=e=>{ if(e.target.id==='uiDialog') done(null); };
  });
}

// decode base64 PNG mask -> Uint8Array(W*H) 0/1
function pngB64ToBin(b64){
  return new Promise((resolve)=>{
    const im = new Image();
    im.onload = ()=>{
      const c=document.createElement('canvas'); c.width=S.W; c.height=S.H;
      const cx=c.getContext('2d'); cx.drawImage(im,0,0,S.W,S.H);
      const d=cx.getImageData(0,0,S.W,S.H).data;
      const bin=new Uint8Array(S.W*S.H);
      for(let i=0,p=0;i<bin.length;i++,p+=4) bin[i]= d[p]>127?1:0;
      resolve(bin);
    };
    im.src='data:image/png;base64,'+b64;
  });
}
// encode Uint8Array bin -> base64 PNG
function binToPngB64(bin){
  const c=document.createElement('canvas'); c.width=S.W; c.height=S.H;
  const cx=c.getContext('2d'); const img=cx.createImageData(S.W,S.H); const d=img.data;
  for(let i=0,p=0;i<bin.length;i++,p+=4){ const v=bin[i]?255:0; d[p]=d[p+1]=d[p+2]=v; d[p+3]=255; }
  cx.putImageData(img,0,0);
  return c.toDataURL('image/png').split(',')[1];
}

// ---------- object mask tint (fill + boundary + centroid) ----------
function buildTint(obj){
  const {W,H}=S; const c=document.createElement('canvas'); c.width=W; c.height=H;
  const cx=c.getContext('2d'); const img=cx.createImageData(W,H); const d=img.data;
  const [r,g,b]=obj.color; const bin=obj.bin;
  let sx=0,sy=0,n=0;
  const fillA = S.vis.fill ? 115 : 0;
  const edgeA = S.vis.boundary ? 240 : fillA;
  for(let y=0;y<H;y++){
    for(let x=0;x<W;x++){
      const i=y*W+x;
      if(!bin[i]) continue;
      sx+=x; sy+=y; n++;
      let edge=false;
      if(S.vis.boundary){
        if(x===0||y===0||x===W-1||y===H-1) edge=true;
        else if(!bin[i-1]||!bin[i+1]||!bin[i-W]||!bin[i+W]) edge=true;
      }
      const p=i*4; d[p]=r; d[p+1]=g; d[p+2]=b; d[p+3]= edge?edgeA:fillA;
    }
  }
  cx.putImageData(img,0,0);
  obj.tint=c;
  obj.centroid = n? [sx/n, sy/n] : null;
}
function invalidateTint(obj){ obj.tint=null; obj.flashTint=null; }
function ensureTint(obj){ if(!obj.tint) buildTint(obj); }
function buildFlashTint(obj){
  const {W,H}=S; const c=document.createElement('canvas'); c.width=W; c.height=H;
  const cx=c.getContext('2d'); const img=cx.createImageData(W,H); const d=img.data;
  const [r,g,b]=obj.color; const bin=obj.bin;
  for(let i=0,p=0;i<bin.length;i++,p+=4){
    if(bin[i]){ d[p]=Math.min(255,r+120); d[p+1]=Math.min(255,g+120); d[p+2]=Math.min(255,b+120); d[p+3]=255; }
  }
  cx.putImageData(img,0,0); obj.flashTint=c;
}
function flashObject(id, silent){
  const obj=S.objects.get(id); if(!obj) return;
  if(!obj.bin.some(v=>v)){ if(!silent) toast('No mask on this frame for '+obj.name); return; }
  buildFlashTint(obj);
  S.flash={id, start:performance.now(), dur:500};
  tickFlash();
}
function tickFlash(){
  if(!S.flash) return;
  render();
  if(S.flash) requestAnimationFrame(tickFlash);
}
function tickBoxFlash(){ render(); if(S.boxFlash) requestAnimationFrame(tickBoxFlash); }
function invalidateAllTints(){ for(const o of S.objects.values()) o.tint=null; }

// ---------- render ----------
function render(){
  const [vw,vh]=vpSize();
  ctx.clearRect(0,0,vw,vh);
  if(!S.img){ return; }

  ctx.save();
  ctx.translate(S.panX,S.panY); ctx.scale(S.scale,S.scale);

  // base frame (smooth)
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(S.img,0,0,S.W,S.H);

  // masks (pixelated for crisp edges when zoomed)
  ctx.imageSmoothingEnabled = false;
  if(S.vis.all){
    for(const id of S.order){
      const obj=S.objects.get(id); if(!obj||!obj.visible) continue;
      ensureTint(obj);
      ctx.drawImage(obj.tint,0,0,S.W,S.H);
    }
  }
  ctx.restore();

  // object flash (double-click a button to locate its mask)
  if(S.flash){
    const obj=S.objects.get(S.flash.id);
    const t=(performance.now()-S.flash.start)/S.flash.dur;
    if(!obj || t>=1){ S.flash=null; }
    else {
      if(!obj.flashTint) buildFlashTint(obj);
      const pulse=Math.sin(t*Math.PI);   // single highlight: 0 -> 1 -> 0
      ctx.save();
      ctx.translate(S.panX,S.panY); ctx.scale(S.scale,S.scale);
      ctx.imageSmoothingEnabled=false; ctx.globalAlpha=0.15+0.75*pulse;
      ctx.drawImage(obj.flashTint,0,0,S.W,S.H);
      ctx.restore(); ctx.globalAlpha=1;
    }
  }

  if(S.vis.all){
    // boxes — persistent only when the Boxes toggle is on
    if(S.vis.boxes){
      for(const [id,box] of S.boxes){
        const obj=S.objects.get(id); if(!obj||!obj.visible) continue;
        drawBoxScreen(box, id===S.currentId? '#ffffff' : `rgb(${obj.color.join(',')})`);
      }
    }
    // live drag box + brief post-draw flash (shown regardless of toggle)
    if(S.tempBox) drawBoxScreen(S.tempBox, '#37e5a0');
    if(S.boxFlash){
      const t=(performance.now()-S.boxFlash.start)/S.boxFlash.dur;
      if(t>=1){ S.boxFlash=null; } else { drawBoxScreen(S.boxFlash.box, S.boxFlash.color); }
    }
    // points
    if(S.vis.points){
      for(const [id,pts] of S.points){
        const obj=S.objects.get(id); if(!obj||!obj.visible) continue;
        for(const pt of pts) drawPointScreen(pt, obj.color);
      }
    }
    // track ids
    if(S.vis.ids){
      for(const id of S.order){
        const obj=S.objects.get(id); if(!obj||!obj.visible||!obj.centroid) continue;
        const [cx,cy]=obj.centroid; const sx=cx*S.scale+S.panX, sy=cy*S.scale+S.panY;
        ctx.font='600 12px Inter, system-ui'; ctx.textAlign='center';
        ctx.fillStyle='rgba(0,0,0,.55)'; ctx.fillText(`${obj.name} #${id}`, sx+1, sy+1);
        ctx.fillStyle=`rgb(${obj.color.join(',')})`; ctx.fillText(`${obj.name} #${id}`, sx, sy);
      }
    }
  }

  // brush cursor
  if(S.brush && S.currentId!=null && lastMouse){
    const rad=(S.brushSize/2)*S.scale;
    ctx.beginPath(); ctx.arc(lastMouse[0],lastMouse[1],rad,0,Math.PI*2);
    ctx.strokeStyle='rgba(255,255,0,.9)'; ctx.lineWidth=1; ctx.stroke();
  }
  renderMini();
}
function drawBoxScreen(box,color){
  const x=box[0]*S.scale+S.panX, y=box[1]*S.scale+S.panY;
  const w=(box[2]-box[0])*S.scale, h=(box[3]-box[1])*S.scale;
  ctx.strokeStyle=color; ctx.lineWidth=2; ctx.strokeRect(x,y,w,h);
}
function drawPointScreen(pt,color){
  const x=pt.x*S.scale+S.panX, y=pt.y*S.scale+S.panY;
  ctx.lineWidth=3;
  if(pt.label===1){ ctx.strokeStyle=`rgb(${color.join(',')})`;
    ctx.beginPath(); ctx.moveTo(x-6,y); ctx.lineTo(x+6,y); ctx.moveTo(x,y-6); ctx.lineTo(x,y+6); ctx.stroke();
  } else { ctx.strokeStyle='#ff5d5d';
    ctx.beginPath(); ctx.moveTo(x-6,y); ctx.lineTo(x+6,y); ctx.stroke(); }
}

// ---------- minimap ----------
function renderMini(){
  const mw=mini.clientWidth, mh=mini.clientHeight;
  mctx.clearRect(0,0,mw,mh);
  if(!S.img) return;
  const s=Math.min(mw/S.W, mh/S.H); const iw=S.W*s, ih=S.H*s;
  const ox=(mw-iw)/2, oy=(mh-ih)/2;
  mctx.imageSmoothingEnabled=true; mctx.drawImage(S.img,ox,oy,iw,ih);
  mini._map={s,ox,oy};
  // viewport rect (what part of the image is visible)
  const [vw,vh]=vpSize();
  const vx0=(-S.panX)/S.scale, vy0=(-S.panY)/S.scale;
  const vx1=(vw-S.panX)/S.scale, vy1=(vh-S.panY)/S.scale;
  const rx=ox+clampi(vx0,0,S.W)*s, ry=oy+clampi(vy0,0,S.H)*s;
  const rw=(clampi(vx1,0,S.W)-clampi(vx0,0,S.W))*s, rh=(clampi(vy1,0,S.H)-clampi(vy0,0,S.H))*s;
  mctx.strokeStyle='#37e5a0'; mctx.lineWidth=1.5; mctx.strokeRect(rx,ry,rw,rh);
  mctx.fillStyle='rgba(55,229,160,.12)'; mctx.fillRect(rx,ry,rw,rh);
}
function miniToImage(mx,my){
  const m=mini._map; if(!m) return null;
  return [ (mx-m.ox)/m.s, (my-m.oy)/m.s ];
}

// ---------- view: zoom / pan / fit ----------
function setZoom(newScale, cx, cy){
  const [vw,vh]=vpSize();
  if(cx==null){ cx=vw/2; cy=vh/2; }
  newScale=clampi(newScale, 0.1, 8);
  const [ix,iy]=toImg(cx,cy);
  S.scale=newScale; S.panX=cx-ix*S.scale; S.panY=cy-iy*S.scale;
  syncZoomUI(); render();
}
function fitView(){
  const [vw,vh]=vpSize(); if(!S.W) return;
  const s=Math.min((vw-24)/S.W,(vh-24)/S.H);
  S.scale=s; S.panX=(vw-S.W*s)/2; S.panY=(vh-S.H*s)/2;
  syncZoomUI(); render();
}
// Fit AFTER the browser has laid the viewport out. Calling fitView() synchronously
// at the end of a load measures a viewport that has not settled yet (panels, fonts,
// scrollbars), which leaves the image scaled for a narrower stage and off-centre.
function fitViewSoon(){
  requestAnimationFrame(()=>{
    resizeCanvas();
    fitView();
    lastVp=[$('viewport').clientWidth, $('viewport').clientHeight];
    requestAnimationFrame(()=>{ fitView(); lastVp=[$('viewport').clientWidth,$('viewport').clientHeight]; });
  });
}
function syncZoomUI(){
  $('zoomSlider').value=Math.round(S.scale*100);
  $('zoomLabel').textContent=Math.round(S.scale*100)+'%';
}

// first mask import of a case turns propagation off; later ones don't.
// Declared here because the undo snapshots capture and restore it.
let importedThisSession=false;

// ---------- undo ----------
// Two kinds of history entry:
//   'bins' — a brush stroke / prediction / post-process: mask pixels only (cheap, frequent)
//   'full' — a structural change such as a replace-import: the whole object list, the
//            prompts, this frame's SAM2-raw record and the propagation toggle.
function pushHistory(entry){
  S.history.push(entry);
  if(S.history.length>S.maxHistory) S.history.shift();
}
function snapshot(){
  const bins=new Map();
  for(const [id,obj] of S.objects) bins.set(id, obj.bin? obj.bin.slice(0):null);
  pushHistory({kind:'bins', frame:S.idx, bins});
}
// Capture without pushing, so a failed operation can discard it instead of
// leaving a no-op entry on the stack.
function captureFull(){
  const objects=[];
  for(const id of S.order){
    const o=S.objects.get(id); if(!o) continue;
    objects.push({id:o.id, classId:o.classId, name:o.name, color:o.color.slice(0),
                  visible:o.visible, bin:o.bin? o.bin.slice(0):null});
  }
  const raw=S.rawMasks.get(S.idx);
  return {
    kind:'full', frame:S.idx,
    objects, order:S.order.slice(0), currentId:S.currentId,
    points:new Map([...S.points].map(([k,v])=>[k, v.map(p=>({...p}))])),
    boxes: new Map([...S.boxes].map(([k,v])=>[k, v.slice(0)])),
    raw: raw? new Map([...raw].map(([k,v])=>[k, {...v, bin:v.bin? v.bin.slice(0):null}])) : null,
    propagation:S.propagation, imported:importedThisSession, dirty:S.dirty,
  };
}
function restoreFull(snap){
  S.objects.clear();
  for(const o of snap.objects){
    S.objects.set(o.id, {id:o.id, classId:o.classId, name:o.name, color:o.color.slice(0),
      bin:o.bin? o.bin.slice(0): new Uint8Array(S.W*S.H),
      tint:null, visible:o.visible, centroid:null});
  }
  S.order=snap.order.filter(id=>S.objects.has(id));
  S.currentId = S.objects.has(snap.currentId)? snap.currentId : (S.order[0] ?? null);
  S.points=new Map([...snap.points].map(([k,v])=>[k, v.map(p=>({...p}))]));
  S.boxes =new Map([...snap.boxes ].map(([k,v])=>[k, v.slice(0)]));
  if(snap.raw) S.rawMasks.set(snap.frame, new Map([...snap.raw].map(([k,v])=>[k, {...v, bin:v.bin? v.bin.slice(0):null}])));
  else S.rawMasks.delete(snap.frame);
  S.propagation=snap.propagation;
  $('propBtn').textContent='Propagation: '+(S.propagation?'ON':'OFF');
  $('propBtn').classList.toggle('on', S.propagation);
  importedThisSession=snap.imported;
  S.dirty=snap.dirty;
  rebuildObjList();
}
function undo(){
  if(S.history.length===0){ toast('Nothing to undo'); return; }
  const snap=S.history.pop();
  if(snap.kind==='full'){
    restoreFull(snap); render();
    toast('Import undone — frame restored','ok');
    return;
  }
  for(const [id,bin] of snap.bins){
    const obj=S.objects.get(id); if(!obj) continue;
    obj.bin= bin? bin.slice(0): new Uint8Array(S.W*S.H); invalidateTint(obj);
  }
  render();
}

// ---------- objects ----------
function addObject(classId, name){
  // A class may have multiple independent objects on one frame. Keep the
  // class id shared for export/metrics, but allocate a distinct object id for
  // prompts, visibility and undo history.
  const base=classId*1000;
  let suffix=0, id=base;
  while(S.objects.has(id)){ suffix++; id=base+suffix; }
  const obj={id, classId, name:(suffix>0?`${name} ${suffix+1}`:name),
             color:annotationColorForClass(classId), bin:new Uint8Array(S.W*S.H), tint:null, visible:true, centroid:null};
  S.objects.set(id,obj); S.order.push(id);
  rebuildObjList(); selectObject(id);
  return obj;
}
function ensureObject(id, classId, name, color){
  if(S.objects.has(id)) return S.objects.get(id);
  const obj={id, classId, name, color:color||annotationColorForClass(classId),
             bin:new Uint8Array(S.W*S.H), tint:null, visible:true, centroid:null};
  S.objects.set(id,obj); S.order.push(id); rebuildObjList();
  return obj;
}
function deleteObject(id){
  S.objects.delete(id); S.order=S.order.filter(x=>x!==id);
  S.points.delete(id); S.boxes.delete(id);
  if(S.currentId===id) S.currentId = S.order[0]??null;
  S.dirty=true; rebuildObjList(); render();
}
function selectObject(id){
  S.currentId=id;
  document.querySelectorAll('.obj-item').forEach(el=>el.classList.toggle('active', +el.dataset.id===id));
  if(S.brush) canvas.style.cursor='none';
}
function cycleObject(dir){
  if(S.order.length===0) return;
  let i=S.order.indexOf(S.currentId); i=(i+dir+S.order.length)%S.order.length;
  selectObject(S.order[i]); flashObject(S.order[i], true);
}
function rebuildObjList(){
  const box=$('objList'); box.innerHTML='';
  for(const id of S.order){
    const obj=S.objects.get(id);
    const hasMask = obj.bin && obj.bin.some(v=>v);
    const greyed = !obj.visible || !hasMask;   // grey when hidden OR no mask on this frame
    const el=document.createElement('div');
    el.className='obj-item'+(id===S.currentId?' active':'')+(greyed?' hidden-mask':'');
    el.dataset.id=id;
    el.innerHTML=`<span class="obj-dot" style="background:rgb(${obj.color.join(',')})"></span>
      <span class="obj-name">${obj.name}</span>
      <span class="obj-eye" title="Toggle visibility">${obj.visible?'👁':'—'}</span>
      <span class="obj-del" title="Delete">✕</span>`;
    el.addEventListener('click',(e)=>{
      if(e.target.classList.contains('obj-eye')){ obj.visible=!obj.visible; rebuildObjList(); render(); return; }
      if(e.target.classList.contains('obj-del')){ deleteObject(id); return; }
      selectObject(id);
    });
    el.addEventListener('dblclick',(e)=>{
      if(e.target.classList.contains('obj-eye')||e.target.classList.contains('obj-del')) return;
      selectObject(id); flashObject(id);
    });
    box.appendChild(el);
  }
  if(CA.open) refreshContextAppear();
}

// ---------- prediction ----------
async function runPredict(){
  const id=S.currentId; if(id==null) return;
  const pts=(S.points.get(id)||[]).map(p=>[p.x,p.y]);
  const labs=(S.points.get(id)||[]).map(p=>p.label);
  const box=S.boxes.get(id)||null;
  if(pts.length===0 && !box) return;
  const {ok,j}=await API.post('/api/predict',{frame_idx:S.idx, obj_id:id, points:pts, labels:labs, box});
  if(!ok){ toast(j.detail||'predict failed','err'); return; }
  const bin=await pngB64ToBin(j.mask);
  const obj=S.objects.get(id); snapshot(); obj.bin=bin; invalidateTint(obj);
  captureRaw(id, bin, 'prompt', true);   // SAM2's first-prompt proposal, frozen (later prompts are human-guided)
  S.dirty=true; rebuildObjList(); render();
}

// ---------- brush ----------
function paintCircle(ix,iy,add){
  const obj=S.objects.get(S.currentId); if(!obj) return;
  const r=Math.floor(S.brushSize/2); const {W,H}=S;
  const x0=clampi(Math.floor(ix-r),0,W-1), x1=clampi(Math.ceil(ix+r),0,W-1);
  const y0=clampi(Math.floor(iy-r),0,H-1), y1=clampi(Math.ceil(iy+r),0,H-1);
  for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++){
    const dx=x-ix, dy=y-iy; if(dx*dx+dy*dy<=r*r) obj.bin[y*W+x]= add?1:0;
  }
  invalidateTint(obj);
}
function brushLine(x0,y0,x1,y1,add){
  const dist=Math.max(1,Math.hypot(x1-x0,y1-y0)); const steps=Math.max(2,Math.round(dist));
  for(let i=0;i<steps;i++){ const t=i/(steps-1); paintCircle(x0+t*(x1-x0), y0+t*(y1-y0), add); }
}

// ---------- post-processing ----------
async function applyPP(op){
  if(typeof C!=='undefined' && C.open){
    if(!C.refine.side){ toast('Select Refine A or Refine B first'); return; }
    await applyCmpPostprocess(op); return;
  }
  const obj=S.objects.get(S.currentId); if(!obj){ toast('Select an object'); return; }
  lockRaw(obj.id);   // freeze SAM2-raw before this correction
  const body={op, mask:binToPngB64(obj.bin), kernel: op==='gaussian'?S.gauss:S.morph, n:S.comp};
  const {ok,j}=await API.post('/api/postprocess',body);
  if(!ok){ toast('postprocess failed','err'); return; }
  snapshot(); obj.bin=await pngB64ToBin(j.mask); invalidateTint(obj); S.dirty=true; render();
  toast(op+' applied','ok');
}

// ---------- raw-mask capture (for SAM2-initial vs human-final Dice) ----------
function rawFrame(idx){ if(!S.rawMasks.has(idx)) S.rawMasks.set(idx,new Map()); return S.rawMasks.get(idx); }
function captureRaw(objId, bin, kind, lock){
  const m=rawFrame(S.idx); const cur=m.get(objId);
  if(cur && cur.locked) return;                 // frozen once a human edit began
  const obj=S.objects.get(objId);
  m.set(objId, {bin:bin.slice(0), kind, classId: obj? (obj.id>999?Math.floor(obj.id/1000):obj.id):objId, locked:!!lock});
}
function lockRaw(objId){
  const m=rawFrame(S.idx); const cur=m.get(objId);
  if(cur){ cur.locked=true; }
  else {  // human edited a mask SAM2 never produced -> raw is empty (max human work)
    const obj=S.objects.get(objId);
    m.set(objId, {bin:new Uint8Array(S.W*S.H), kind:'prompt',
                  classId: obj? (obj.id>999?Math.floor(obj.id/1000):obj.id):objId, locked:true});
  }
}
function clearRawAfter(frame){ for(const f of [...S.rawMasks.keys()]) if(f>frame) S.rawMasks.delete(f); }

// ---------- frames ----------
function commitFrame(idx){
  if(idx==null || idx<0 || S.objects.size===0) return;
  const m=new Map();
  for(const [id,obj] of S.objects) m.set(id, obj.bin.slice(0));
  S.frameMasks.set(idx, m);
}
function restoreFrame(idx){
  const m=S.frameMasks.get(idx)||new Map();
  // S.objects is global across frames, so a replace-import on a later frame would
  // otherwise erase this frame's objects too — rebuild any that this frame still has.
  for(const id of m.keys()){
    if(!S.objects.has(id)) ensureObject(id, id>999?Math.floor(id/1000):id, nameForObjId(id));
  }
  for(const [id,obj] of S.objects){
    const bin=m.get(id);
    obj.bin=(bin && bin.length===S.W*S.H)? bin.slice(0): new Uint8Array(S.W*S.H);
    invalidateTint(obj);
  }
}
function clearFrameMasks(){
  for(const obj of S.objects.values()){ obj.bin=new Uint8Array(S.W*S.H); invalidateTint(obj); }
}
// show a real progress bar for slow propagation jumps (polls the server)
function startPropProgress(){
  let shown=false, poll=null;
  const t=setTimeout(()=>{
    shown=true; $('overlayBar').classList.remove('hidden'); showOverlay('Propagating…');
    poll=setInterval(async ()=>{
      try{ const p=await API.get('/api/propagate/progress');
        if(p.active && p.target>p.start){
          const frac=Math.max(0,Math.min(1,(p.current-p.start)/(p.target-p.start)));
          $('overlayBarFill').style.width=(frac*100).toFixed(1)+'%';
          $('overlayText').textContent=`Propagating… frame ${p.current+1} / ${p.target+1}`;
        }
      }catch(_){}
    }, 180);
  }, 250);   // only appears if the jump actually takes a moment
  return ()=>{ clearTimeout(t); if(poll) clearInterval(poll);
    if(shown){ $('overlayBar').classList.add('hidden'); $('overlayBarFill').style.width='0%'; hideOverlay(); } };
}
// reseed the generator from `idx` with all current visible masks (carries new/edited objects forward)
async function reseedFrom(idx){
  const objects=[];
  for(const id of S.order){ const o=S.objects.get(id); if(o.visible && o.bin.some(v=>v)) objects.push({obj_id:id, mask:binToPngB64(o.bin)}); }
  if(!objects.length) return false;
  await API.post('/api/propagate/reseed',{frame_idx:idx, objects});
  for(const f of [...S.frameMasks.keys()]) if(f>idx) S.frameMasks.delete(f);
  return true;
}
async function propagateInto(idx){
  clearFrameMasks();   // hard-clear every object first, so no previous-frame mask can linger
  const stop=startPropProgress();
  const {ok,j}=await API.post('/api/propagate/frame',{frame_idx:idx});
  stop();
  if(ok && j.available && j.masks.length){
    for(const mk of j.masks){
      const obj=ensureObject(mk.obj_id, (mk.obj_id>999?Math.floor(mk.obj_id/1000):mk.obj_id), nameForObjId(mk.obj_id));
      obj.bin=await pngB64ToBin(mk.mask); invalidateTint(obj);
      captureRaw(obj.id, obj.bin, 'propagation', true);   // pure SAM2 tracking output, frozen
    }
  }
  commitFrame(idx);   // cache so moving back later restores this, not a re-propagation
}

async function loadFrame(newIdx, opts={}){
  newIdx=clampi(newIdx,0,S.count-1);
  const oldIdx=S.idx;
  if(CA.open&&CA.activeFrame!=null) CA.drafts.set(CA.activeFrame,{snapshot:contextSnapshot(),dirty:CA.dirty});
  const wasDirty=S.dirty;   // did the user add/edit masks on the frame we're leaving?
  if(newIdx===oldIdx && !opts.force) return;
  if(!opts.skipCommit) commitFrame(oldIdx);

  // load image + meta
  const meta=await API.get('/api/frame_meta/'+newIdx);
  S.W=meta.width; S.H=meta.height;
  await new Promise(res=>{ const im=new Image(); im.onload=()=>{S.img=im;res();}; im.src='/api/frame_image/'+newIdx+'?t='+Date.now(); });
  S.idx=newIdx;
  S.points.clear(); S.boxes.clear(); S.history=[]; S.flash=null;
  $('emptyHint').classList.add('hidden');
  $('frameName').textContent=meta.name;
  $('position').textContent=`${S.idx+1} / ${S.count}`;
  $('frameSlider').value=S.idx;
  if(V.open) positionContextVideo(S.idx,false);
  if(CA.open){
    CA.activeFrame=S.idx; const draft=CA.drafts.get(S.idx);
    if(draft){ restoreContextSnapshot(draft.snapshot); setContextStatus(draft.dirty?'edited':'draft',draft.dirty); }
    else clearContextForm();
  }

  const forward = newIdx > oldIdx;
  const firstVisit = !S.frameMasks.has(newIdx);
  if(S.frameMasks.has(newIdx)){
    // already visited (or already propagated) — show the work that's there
    restoreFrame(newIdx);
  } else if(forward && S.propagation && S.sam2 && !opts.noProp){
    // moving forward into a new frame — propagate (clears old masks first).
    // if the frame we left had edits (new/changed masks), reseed from it first so they carry forward.
    if(wasDirty && !S.refineSrc){ await reseedFrom(oldIdx); }
    await propagateInto(newIdx);
  } else {
    // moving back into an un-annotated frame, or propagation off — blank
    clearFrameMasks();
  }
  // refine mode: on first visit to a frame, seed with the annotator's saved mask
  if(S.refineSrc && firstVisit){ await importMaskInto(S.refineSrc, true); }
  rebuildObjList(); render();
  S.dirty=false;   // arriving at a frame is a clean slate until the user edits
}

// ---------- save ----------
let saveConfigured=false;
function collectSaveObjects(){
  const objects=[];
  for(const id of S.order){
    const obj=S.objects.get(id); if(!obj.visible) continue;
    if(!obj.bin.some(v=>v)) continue;
    const classId = id>999? Math.floor(id/1000): id;
    objects.push({class_id:classId, mask:binToPngB64(obj.bin)});
  }
  return objects;
}
async function saveMasks(){
  if(!S.count){ toast('Open a folder first'); return; }
  if(collectSaveObjects().length===0){ toast('No visible masks to save','err'); return; }
  // first save: let the user confirm/choose PNG then YOLO output folders
  if(!saveConfigured){
    const pngOnly=$('exportPngOnly').checked;
    openBrowser({title:'Choose PNG output folder', start:$('pngDir').value||S.defaultPath, onSelect:(p)=>{
      if(p) $('pngDir').value=p;
      if(pngOnly){ saveConfigured=true; doSave(); return; }
      openBrowser({title:'Choose YOLO output folder', start:$('yoloDir').value||S.defaultPath, onSelect:(p2)=>{
        if(p2) $('yoloDir').value=p2;
        saveConfigured=true; doSave();
      }});
    }});
    return;
  }
  doSave();
}
async function doSave(){
  const pngDir=$('pngDir').value.trim(), yoloDir=$('yoloDir').value.trim();
  const pngOnly=$('exportPngOnly').checked;
  if(!pngDir || (!pngOnly && !yoloDir)){ toast(pngOnly?'Set PNG output dir':'Set PNG + YOLO output dirs','err'); saveConfigured=false; return; }
  const objects=collectSaveObjects();
  // SAM2-raw for this frame (automatic) -> sibling <annotator>_sam dir
  let raw_objects=[], sam_dir='';
  if($('exportSamRaw').checked){
    const rawMap=S.rawMasks.get(S.idx);
    if(rawMap){ for(const [,r] of rawMap){ if(r.bin.some(v=>v)) raw_objects.push({class_id:r.classId, mask:binToPngB64(r.bin)}); } }
    if(raw_objects.length) sam_dir=deriveSamDir(pngDir);
  }
  showOverlay('Saving masks…');
  const {ok,j}=await API.post('/api/save',{frame_idx:S.idx, png_dir:pngDir, yolo_dir:yoloDir||pngDir, objects, yolo:!pngOnly, raw_objects, sam_dir});
  hideOverlay();
  if(!ok){ toast(j.detail||'save failed','err'); return; }
  S.dirty=false;
  flashScreen();
  const samNote = j.sam_path? ' + SAM-raw' : '';
  const yoloDetail = (j.yolo_err||'').replace(/\s+/g,' ').trim();
  const label = pngOnly? `Saved ✓  ${S.frames[S.idx]}  (PNG${samNote})`
              : (j.yolo_ok? `Saved ✓  ${S.frames[S.idx]}  (PNG + YOLO${samNote})`
                 : `Saved PNG (YOLO failed${yoloDetail?`: ${yoloDetail.slice(0,180)}`:''})`);
  toast(label, (pngOnly||j.yolo_ok)?'ok':'err');
  if(pendingFrame!=null){ const t=pendingFrame; pendingFrame=null; loadFrame(t); }
}
function deriveSamDir(pngDir){
  const segs=pngDir.replace(/\/+$/,'').split('/');
  const user=(S.user||'').trim();
  // 1) if the <user> segment is present, make its _sam sibling (…/Qixiang/… -> …/Qixiang_sam/…)
  if(user){ for(let i=segs.length-1;i>=0;i--){ if(segs[i]===user){ segs[i]=user+'_sam'; return segs.join('/'); } } }
  // 2) new layout <user>/<case>/masks -> _sam on the user level (segs[-3])
  if((segs[segs.length-1]==='masks'||segs[segs.length-1]==='labels') && segs.length>=3){ segs[segs.length-3]+='_sam'; return segs.join('/'); }
  // 3) flat <annotator>/<case> -> _sam on the annotator level (segs[-2])
  if(segs.length>=2){ segs[segs.length-2]+='_sam'; return segs.join('/'); }
  return pngDir.replace(/\/+$/,'')+'_sam';
}
function flashScreen(){
  const f=$('saveFlash'); if(!f) return;
  f.classList.remove('run'); void f.offsetWidth; f.classList.add('run');
}

// ---------- context video ----------
const contextVideo=$('contextVideo');
const VIDEO_PLAYBACK_RATES=[.5,1,1.5,2,2.5,3,3.5,4];
const VIDEO_CONTEXT_SECONDS=[10,30];
function setVideoPlaybackRate(value, persist=true){
  const rate=Number(value);
  V.playbackRate=VIDEO_PLAYBACK_RATES.includes(rate)?rate:1;
  contextVideo.defaultPlaybackRate=V.playbackRate;
  contextVideo.playbackRate=V.playbackRate;
  $('videoSpeed').value=String(V.playbackRate);
  if(persist){ try{ localStorage.setItem('issas.videoPlaybackRate',String(V.playbackRate)); }catch(_){} }
}
try{ setVideoPlaybackRate(localStorage.getItem('issas.videoPlaybackRate'),false); }
catch(_){ setVideoPlaybackRate(1,false); }
function setVideoContextSeconds(value, persist=true, reposition=false){
  const seconds=Number(value);
  V.contextSeconds=VIDEO_CONTEXT_SECONDS.includes(seconds)?seconds:10;
  document.querySelectorAll('[data-video-context]').forEach(btn=>{
    const selected=Number(btn.dataset.videoContext)===V.contextSeconds;
    btn.classList.toggle('on',selected);
    btn.setAttribute('aria-pressed',String(selected));
  });
  $('videoOpen').title=`Play ${V.contextSeconds} seconds before and after this frame (P)`;
  if(persist){ try{ localStorage.setItem('issas.videoContextSeconds',String(V.contextSeconds)); }catch(_){} }
  if(reposition&&V.open) positionContextVideo(V.frameIndex,!contextVideo.paused);
}
try{ setVideoContextSeconds(localStorage.getItem('issas.videoContextSeconds'),false); }
catch(_){ setVideoContextSeconds(10,false); }
function videoTime(seconds, decimals=0){
  seconds=Math.max(0, Number(seconds)||0);
  const factor=10**decimals, rounded=Math.round(seconds*factor)/factor;
  const whole=Math.floor(rounded), h=Math.floor(whole/3600), m=Math.floor((whole%3600)/60), s=whole%60;
  const fraction=decimals?'.'+String(Math.round((rounded-whole)*factor)).padStart(decimals,'0'):'';
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}${fraction}`;
}
function frameIdAt(index){
  const names=V.sourceFrames||S.frames;
  const name=names[index]||'';
  const stem=name.replace(/\.[^.]+$/,'');
  const parts=stem.match(/\d+/g);
  return parts&&parts.length? parseInt(parts[parts.length-1],10) : index;
}
function videoCenterAt(index){ return V.fps>0 ? frameIdAt(index)/V.fps : 0; }
function applyVideoStatus(j){
  j=j||{};
  V.configured=!!j.configured; V.available=!!j.available;
  V.fps=Number(j.fps)>0?Number(j.fps):0; V.fpsSource=j.fps_source||null; V.duration=Number(j.duration)||0;
  V.name=j.name||null; V.caseName=j.case||null;
  V.workflow={available:!!j.workflow?.available, phaseNames:j.workflow?.phase_names||{}, intervals:j.workflow?.intervals||[]};
  $('videoFps').value=V.fps?V.fps.toFixed(3):'';
  const badge=$('videoSourceBadge'), info=$('videoSourceInfo');
  badge.classList.toggle('ready',V.available); badge.classList.toggle('missing',V.configured&&!V.available);
  badge.textContent=V.available?'ready':(V.configured?'no match':'not set');
  if(j.directory && !$('videoPath').value) $('videoPath').value=j.directory;
  const playbackFps=Number(j.playback_fps)>0?Number(j.playback_fps):V.fps;
  const fpsNote=V.fpsSource==='unavailable'?' (unable to detect)':(V.fpsSource==='source-video'?' (source video)':' (auto)');
  info.textContent=V.available&&V.fps?`${j.name} | ${V.fps.toFixed(3)} FPS${fpsNote}`
    :(V.available?`${j.name} | FPS unavailable`:(j.expected?`Waiting for ${j.expected}`:'Matches <case>.mp4'));
  if(V.available&&V.fpsSource==='source-video'&&playbackFps!==V.fps){
    info.textContent+=` | playback ${playbackFps.toFixed(3)} FPS`;
  }
  info.title=info.textContent;
  $('videoOpen').disabled=!V.available||!V.fps||!S.count;
  if(CA.open) refreshContextAnnotationMeta();
  if(!V.available){ closeContextVideo(); contextVideo.removeAttribute('src'); V.sourceKey=null; return; }
  const key=`${j.directory||''}|${j.name||''}`;
  if(V.sourceKey!==key){
    V.seekToken++; V.seekPending=false;
    V.sourceKey=key;
    contextVideo.src='/api/video/file?key='+encodeURIComponent(key);
    contextVideo.load();
    setVideoPlaybackRate(V.playbackRate,false);
  }
}
async function configureVideoFolder(){
  const path=$('videoPath').value.trim();
  if(!path){ toast('Enter a video folder path','err'); return; }
  // FPS is always read from the matched video's metadata; never reuse a case
  // specific or browser-cached value.
  const {ok,j}=await API.post('/api/video/config',{path,fps:null});
  if(!ok){ toast(j.detail||'video folder could not be opened','err'); return; }
  try{ localStorage.setItem('issas.videoPath',path); localStorage.removeItem('issas.videoFps'); }catch(_){}
  applyVideoStatus(j);
  toast(j.available?`Matched ${j.name}`:`Folder set; ${j.expected||'case video'} was not found`,j.available?'ok':'err');
}
function rememberFloatRect(){
  if(V.mode!=='float'||!V.open) return;
  const rect=$('videoWindow').getBoundingClientRect();
  V.floatRect={left:rect.left,top:rect.top,width:rect.width,height:rect.height};
}
function restoreFloatRect(){
  const win=$('videoWindow'), saved=V.floatRect;
  if(!saved){ win.style.removeProperty('left'); win.style.removeProperty('width'); win.style.removeProperty('height'); win.style.removeProperty('right'); return; }
  const width=Math.min(saved.width,Math.max(280,window.innerWidth-24));
  const height=Math.min(saved.height,Math.max(220,window.innerHeight-70));
  const left=Math.max(0,Math.min(window.innerWidth-width,saved.left));
  const top=Math.max(54,Math.min(window.innerHeight-height,saved.top));
  Object.assign(win.style,{left:left+'px',top:top+'px',right:'auto',width:width+'px',height:height+'px'});
}
function clearDockedVideoGeometry(){
  const win=$('videoWindow');
  for(const prop of ['left','right','top','bottom','width','height']) win.style.removeProperty(prop);
}
function setVideoMode(mode){
  if(!['float','split','main'].includes(mode)) mode='float';
  if(V.mode==='float'&&mode!=='float') rememberFloatRect();
  V.mode=mode;
  const win=$('videoWindow'), stage=win.closest('.stage');
  win.classList.remove('mode-float','mode-split','mode-main'); win.classList.add('mode-'+mode);
  if(mode==='float') requestAnimationFrame(restoreFloatRect); else clearDockedVideoGeometry();
  stage.classList.toggle('video-split',mode==='split'&&V.open);
  stage.classList.toggle('video-main',mode==='main'&&V.open);
  syncVideoSplitDirection();
  document.querySelectorAll('.video-mode').forEach(b=>b.classList.toggle('on',b.dataset.videoMode===mode));
  if(CA.open){
    $('contextAnnotationPanel').classList.toggle('split-context',mode==='split');
    requestAnimationFrame(positionContextAnnotation);
  }
  requestAnimationFrame(resizeCanvas); setTimeout(resizeCanvas,80);
}
function syncVideoSplitDirection(){
  const stage=$('videoWindow').closest('.stage');
  stage.classList.toggle('video-narrow',V.open&&V.mode==='split'&&stage.clientWidth<720);
}
function closeContextVideo(){
  if(CA.open) closeContextAnnotation();
  V.open=false; V.seekToken++; V.seekPending=false; contextVideo.pause();
  $('videoLoading').classList.add('hidden');
  const win=$('videoWindow'); win.classList.add('hidden');
  if(V.compare) $('cmpVideoPane').classList.remove('on');
  const stage=win.closest('.stage'); stage.classList.remove('video-split','video-main','video-narrow');
  V.compare=false; V.sourceFrames=null;
  syncCmpVideoLayout();
  requestAnimationFrame(resizeCanvas);
}
function updateVideoControls(){
  const t=Number(contextVideo.currentTime)||V.clipStart;
  $('videoSeek').value=Math.min(V.clipEnd,Math.max(V.clipStart,t));
  $('videoTime').textContent=`${videoTime(t,1)} / ${videoTime(V.clipEnd,1)}`;
  $('videoPlayPause').textContent=contextVideo.paused?'\u25B6':'\u23F8';
}
function updateVideoFrameMark(){
  const span=Math.max(.01,V.clipEnd-V.clipStart);
  const pct=Math.max(0,Math.min(100,(V.center-V.clipStart)/span*100));
  $('videoSeekWrap').style.setProperty('--frame-mark-pos',pct+'%');
  $('videoFrameMark').title=`Observed frame: ${S.frames[V.frameIndex]||'frame'} at ${videoTime(V.center,2)}`;
}
function waitForVideoMetadata(token){
  if(contextVideo.readyState>=1 && Number.isFinite(contextVideo.duration)) return Promise.resolve(true);
  return new Promise(resolve=>{
    let timer=null;
    const done=ok=>{
      contextVideo.removeEventListener('loadedmetadata',loaded);
      contextVideo.removeEventListener('error',failed);
      if(timer) clearTimeout(timer);
      resolve(ok&&token===V.seekToken);
    };
    const loaded=()=>done(true), failed=()=>done(false);
    contextVideo.addEventListener('loadedmetadata',loaded);
    contextVideo.addEventListener('error',failed);
    timer=setTimeout(()=>done(false),12000);
  });
}
function waitForVideoSeek(target, token){
  return new Promise(resolve=>{
    let timer=null, settled=false;
    const done=ok=>{
      if(settled) return;
      settled=true;
      contextVideo.removeEventListener('seeked',seeked);
      contextVideo.removeEventListener('error',failed);
      if(timer) clearTimeout(timer);
      resolve(ok&&token===V.seekToken);
    };
    const tolerance=Math.max(.25,2/Math.max(1,V.fps));
    const seeked=()=>{ if(Math.abs(contextVideo.currentTime-target)<=tolerance) done(true); };
    const failed=()=>done(false);
    contextVideo.addEventListener('seeked',seeked);
    contextVideo.addEventListener('error',failed);
    timer=setTimeout(()=>done(Math.abs(contextVideo.currentTime-target)<=tolerance),12000);
    try{
      contextVideo.currentTime=target;
      if(!contextVideo.seeking && Math.abs(contextVideo.currentTime-target)<=tolerance){
        requestAnimationFrame(()=>done(true));
      }
    }catch(_){ done(false); }
  });
}
async function seekContextVideo(target, autoplay){
  const token=++V.seekToken;
  V.seekPending=true;
  const loading=$('videoLoading');
  loading.textContent=`Seeking ${videoTime(target)}...`;
  loading.classList.remove('hidden');

  // Calling play inside the original click/right-click gesture preserves Safari's
  // media authorization while metadata and the actual seek complete asynchronously.
  if(autoplay) contextVideo.play().catch(()=>{}); else contextVideo.pause();
  if(!await waitForVideoMetadata(token)){
    if(token===V.seekToken){ V.seekPending=false; contextVideo.pause(); loading.textContent='Video metadata unavailable'; toast('Could not read video metadata','err'); }
    return false;
  }
  if(token!==V.seekToken) return false;

  if(Number.isFinite(contextVideo.duration)) V.duration=contextVideo.duration;
  V.clipEnd=V.duration?Math.min(V.duration,V.center+V.contextSeconds):V.center+V.contextSeconds;
  if(V.clipEnd<=V.clipStart) V.clipEnd=V.clipStart+.01;
  target=Math.min(V.clipEnd,Math.max(V.clipStart,target));
  $('videoSeek').min=V.clipStart; $('videoSeek').max=V.clipEnd; $('videoSeek').value=target;
  updateVideoFrameMark();

  if(!await waitForVideoSeek(target,token)){
    if(token===V.seekToken){ V.seekPending=false; contextVideo.pause(); loading.textContent='Video seek failed'; toast(`Could not seek video to ${videoTime(target)}`,'err'); }
    return false;
  }
  if(token!==V.seekToken) return false;

  V.seekPending=false;
  loading.textContent='Loading video...';
  loading.classList.toggle('hidden',contextVideo.readyState>=2);
  updateVideoControls();
  if(autoplay) contextVideo.play().catch(()=>toast('Press play to continue','err'));
  return true;
}
function positionContextVideo(index, autoplay){
  V.frameIndex=index;
  V.center=videoCenterAt(index);
  V.clipStart=Math.max(0,V.center-V.contextSeconds);
  const duration=V.duration||(Number.isFinite(contextVideo.duration)?contextVideo.duration:0);
  V.clipEnd=duration?Math.min(duration,V.center+V.contextSeconds):V.center+V.contextSeconds;
  if(V.clipEnd<=V.clipStart) V.clipEnd=V.clipStart+.01;
  $('videoSeek').min=V.clipStart; $('videoSeek').max=V.clipEnd; $('videoSeek').value=V.clipStart;
  $('videoTitle').textContent=V.name||'Context video';
  const names=V.sourceFrames||S.frames;
  $('videoSubtitle').textContent=`${names[index]||'frame'} | ${videoTime(V.center)} | -${V.contextSeconds}s / +${V.contextSeconds}s`;
  updateVideoFrameMark();
  updateVideoControls();
  if(CA.open){ refreshContextAnnotationMeta(); positionContextAnnotation(); }
  seekContextVideo(V.clipStart,autoplay);
}
function openContextVideo(index=S.idx, autoplay=true){
  if(!V.available){ toast(V.configured?'No matching video for this case':'Set the video folder first','err'); return; }
  V.open=true;
  $('videoWindow').classList.remove('hidden'); setVideoMode(V.mode);
  V.sourceFrames=null; V.compare=false;
  positionContextVideo(clampi(index,0,S.count-1),autoplay);
}
function openCompareVideo(index=C.idx, autoplay=true){
  if(!V.available){ toast(V.configured?'No matching video for this case':'Set the video folder first','err'); return; }
  const names=C.frames||[];
  if(!names.length) return;
  V.sourceFrames=names; V.compare=true; V.open=true;
  const pane=$('cmpVideoPane'), win=$('videoWindow');
  if(win.parentElement!==pane) pane.appendChild(win);
  pane.classList.add('on'); win.classList.remove('hidden');
  syncCmpVideoLayout();
  setVideoMode('main');
  positionContextVideo(clampi(index,0,names.length-1),autoplay);
  requestAnimationFrame(()=>{ compareResize(); cmpRender(); });
}
function syncCmpVideoLayout(){
  const visuals=$('cmpVisuals');
  if(!visuals) return;
  visuals.classList.toggle('cmp-dual-video',!!V.compare&&C.mode==='dual');
}
async function toggleVideoPlay(){
  if(contextVideo.paused){
    if(contextVideo.currentTime>=V.clipEnd-.05){ await seekContextVideo(V.clipStart,true); return; }
    contextVideo.play().catch(()=>{});
  } else contextVideo.pause();
}
function stepVideo(direction){
  contextVideo.pause();
  const target=Math.min(V.clipEnd,Math.max(V.clipStart,(contextVideo.currentTime||V.center)+direction));
  seekContextVideo(target,false);
}
function setVideoLoop(value){
  V.loop=!!value;
  const button=$('videoLoop'); button.classList.toggle('on',V.loop); button.setAttribute('aria-pressed',String(V.loop));
  button.title=V.loop?'Loop clip: on':'Loop clip';
}
function videoClipTimestamp(seconds){ return contextTimeShort(Math.max(0,seconds-V.clipStart)); }
function showVideoSeekTimestamp(e){
  if(!CA.open) return;
  const seek=$('videoSeek'), rect=seek.getBoundingClientRect();
  const ratio=Math.max(0,Math.min(1,(e.clientX-rect.left)/Math.max(1,rect.width)));
  const seconds=V.clipStart+ratio*(V.clipEnd-V.clipStart), tip=$('videoSeekTimestamp');
  tip.textContent=videoClipTimestamp(seconds); tip.dataset.timestamp=tip.textContent;
  $('videoSeekWrap').style.setProperty('--seek-tip-pos',(ratio*100)+'%'); tip.classList.remove('hidden');
}
async function copyVideoSeekTimestamp(){
  const value=$('videoSeekTimestamp').dataset.timestamp||$('videoSeekTimestamp').textContent;
  try{ await navigator.clipboard.writeText(value); toast(`Copied timestamp ${value}`,'ok'); }
  catch(_){ const t=document.createElement('textarea'); t.value=value; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); toast(`Copied timestamp ${value}`,'ok'); }
}
function timelineIndex(e){
  const slider=$('frameSlider'), rect=slider.getBoundingClientRect();
  const ratio=Math.max(0,Math.min(1,(e.clientX-rect.left)/Math.max(1,rect.width)));
  return Math.round(ratio*Math.max(0,S.count-1));
}
function showVideoTimelineTip(e){
  if(!V.available||!S.count) return;
  const idx=timelineIndex(e), center=videoCenterAt(idx), start=Math.max(0,center-V.contextSeconds);
  const end=V.duration?Math.min(V.duration,center+V.contextSeconds):center+V.contextSeconds;
  const tip=$('videoTimelineTip');
  tip.innerHTML=`Frame ${frameIdAt(idx)} &nbsp; <strong>${videoTime(center)}</strong><br>${videoTime(start)} - ${videoTime(end)}`;
  tip.style.left=e.clientX+'px'; tip.style.top=(e.clientY-10)+'px'; tip.classList.remove('hidden');
}

// ---------- context annotation ----------
const CONTEXT_TEXT_FIELDS=['Action','Intent','TissueState','FreeText','Smoke','Bleeding','Occlusion'];
const CONTEXT_VIS_FIELDS=['Smoke','Bleeding','Occlusion'];
const SURGICAL_ACTIONS=[
  'aspirate','cauterize','clean','clip','coagulate','cut','dissect','divide','elevate','expose',
  'extract','grasp','hold','incise','insert','irrigate','ligate','mobilize','pack','peel','place',
  'probe','retract','seal','separate','staple','suction','suture','tie','transect','withdraw'
];
function contextEditor(name){ return $('context'+name); }
function contextClassKind(name){
  if(Object.prototype.hasOwnProperty.call(S.classGroups.instrument||{},name)) return 'instrument';
  if(['Pancreas','Duodenal stump','Liver','Gallbladder','Stomach'].includes(name)) return 'organ';
  if(/artery|vein|vessel|blood/i.test(name)) return 'vessel';
  return 'tissue';
}
function contextVocabulary(editor){
  const out=Object.keys(S.classMap).map(name=>({name,kind:contextClassKind(name)}));
  for(const name of Object.values(V.workflow.phaseNames||{})) out.push({name,kind:'phase'});
  if(editor&&editor.id==='contextAction') for(const name of SURGICAL_ACTIONS) out.push({name,kind:'action'});
  return out.sort((a,b)=>{
    if(editor&&editor.id==='contextAction'&&(a.kind==='action')!==(b.kind==='action')) return a.kind==='action'?-1:1;
    return b.name.length-a.name.length||a.name.localeCompare(b.name);
  });
}
function contextSelectionOffset(editor,node,offset){
  const range=document.createRange(); range.selectNodeContents(editor); range.setEnd(node,offset);
  return range.toString().length;
}
function contextSelectionSnapshot(){
  const sel=window.getSelection(); if(!sel||!sel.rangeCount) return null;
  const anchor=sel.anchorNode,focus=sel.focusNode;
  const source=anchor?.nodeType===Node.ELEMENT_NODE?anchor:anchor?.parentElement;
  const editor=source?.closest?.('.context-edit');
  if(!editor||!editor.contains(focus)) return null;
  return {field:editor.id.slice('context'.length),start:contextSelectionOffset(editor,anchor,sel.anchorOffset),end:contextSelectionOffset(editor,focus,sel.focusOffset)};
}
function contextSnapshot(){
  const text={},html={};
  for(const name of CONTEXT_TEXT_FIELDS){ const editor=contextEditor(name); text[name]=editor.innerText.replace(/\n+$/,''); html[name]=editor.innerHTML; }
  const visibility={}; for(const name of CONTEXT_VIS_FIELDS) visibility[name]=$('context'+name+'Check').checked;
  return {text,html,visibility,selection:contextSelectionSnapshot()};
}
function contextSnapshotKey(snap){ return JSON.stringify({text:snap.text,html:snap.html,visibility:snap.visibility}); }
function setContextStatus(text, dirty=false){
  CA.dirty=dirty; $('contextAnnotationStatus').textContent=text;
  $('contextAnnotationStatus').classList.toggle('dirty',dirty);
}
function pushContextHistory(){
  if(CA.restoring) return;
  const snap=contextSnapshot(), last=CA.history[CA.history.length-1];
  if(!last||contextSnapshotKey(last)!==contextSnapshotKey(snap)){
    CA.history.push(snap); if(CA.history.length>5) CA.history.shift();
  }
  CA.future=[];
}
function contextSelectionPoint(editor,target){
  const walker=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT);
  let node,remaining=Math.max(0,target||0),last=null;
  while((node=walker.nextNode())){ last=node; if(remaining<=node.nodeValue.length) return [node,remaining]; remaining-=node.nodeValue.length; }
  return last?[last,last.nodeValue.length]:[editor,editor.childNodes.length];
}
function restoreContextSelection(selection){
  if(!selection||!selection.field) return;
  const editor=contextEditor(selection.field); if(!editor) return;
  const [node,offset]=contextSelectionPoint(editor,Math.max(selection.start||0,selection.end||0));
  editor.focus();
  const sel=window.getSelection();
  if(sel.setBaseAndExtent) sel.setBaseAndExtent(node,offset,node,offset);
  else{
    const range=document.createRange(); range.setStart(node,offset); range.collapse(true);
    sel.removeAllRanges(); sel.addRange(range);
  }
}
function restoreContextSnapshot(snap){
  if(!snap) return;
  CA.restoring=true;
  for(const name of CONTEXT_TEXT_FIELDS){ const editor=contextEditor(name); if(snap.html&&name in snap.html) editor.innerHTML=snap.html[name]; else editor.textContent=snap.text?.[name]||''; }
  for(const name of CONTEXT_VIS_FIELDS) $('context'+name+'Check').checked=!!snap.visibility?.[name];
  CA.restoring=false; hideContextSuggestions(); setContextStatus('edited',true); restoreContextSelection(snap.selection);
}
function contextUndo(){
  if(!CA.history.length) return;
  CA.future.push(contextSnapshot()); if(CA.future.length>5) CA.future.shift();
  const snap=CA.history.pop(); restoreContextSnapshot(snap);
}
function contextRedo(){
  if(!CA.future.length) return;
  CA.history.push(contextSnapshot()); if(CA.history.length>5) CA.history.shift();
  restoreContextSnapshot(CA.future.pop());
}
function contextTimeShort(seconds){
  seconds=Math.max(0,Math.round(Number(seconds)||0));
  const h=Math.floor(seconds/3600),m=Math.floor((seconds%3600)/60),s=seconds%60;
  return h?`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
          :`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function contextClipPhases(){
  return ((V.workflow&&V.workflow.intervals)||[])
    .filter(p=>p.end>V.clipStart&&p.start<V.clipEnd)
    .map(p=>({
      phase_id:p.phase_id,
      phase_name:p.phase_name,
      start:Number((Math.max(p.start,V.clipStart)-V.clipStart).toFixed(3)),
      end:Number((Math.min(p.end,V.clipEnd)-V.clipStart).toFixed(3)),
    }));
}
function refreshContextPhase(){
  const box=$('contextPhase'), hits=contextClipPhases();
  box.innerHTML=''; box.classList.toggle('muted',!hits.length);
  if(!hits.length){ box.textContent=V.workflow?.available?'No phase assigned in this clip':'No workflow map found'; return; }
  hits.forEach((p,i)=>{
    if(i) box.append(document.createTextNode(', '));
    const name=document.createElement('span'); name.className='ctx-phase'; name.textContent=p.phase_name;
    box.append(name,document.createTextNode(` (${contextTimeShort(p.start)}-${contextTimeShort(p.end)})`));
  });
}
function contextAppearFromEditor(){
  return S.order.map(id=>S.objects.get(id)).filter(o=>o&&o.visible&&o.bin&&o.bin.some(v=>v))
    .map(o=>({object_id:o.id,class_id:o.classId,name:o.name||classNameForId(o.classId),kind:contextClassKind(classNameForId(o.classId))}));
}
function renderContextAppear(items){
  const groups={instrument:[],organ:[],vessel:[],tissue:[]};
  for(const item of (items||[])){
    const base=item.name||classNameForId(item.class_id), kind=item.kind||contextClassKind(base);
    groups[kind].push(base);
  }
  const labels={instrument:'Instruments',organ:'Organs',vessel:'Vessels',tissue:'Tissues'}, box=$('contextAppear');
  box.innerHTML=''; let any=false;
  for(const kind of ['instrument','organ','vessel','tissue']){
    if(!groups[kind].length) continue; any=true;
    if(box.childNodes.length) box.append(document.createElement('br'));
    const lead=document.createElement('strong'); lead.textContent=labels[kind]+': ';
    box.append(lead);
    groups[kind].forEach((name,i)=>{
      if(i) box.append(document.createTextNode(', '));
      const token=document.createElement('span'); token.className=`ctx-name ctx-${kind}`; token.textContent=name; box.append(token);
    });
  }
  box.classList.toggle('muted',!any); if(!any) box.textContent='No current GT classes';
}
async function refreshContextAppear(){
  if(!CA.open) return;
  const frame=S.idx, token=++CA.appearToken;
  const fallback=contextAppearFromEditor();
  const box=$('contextAppear');
  if(!CA.appear.length || CA.appearFrame!==frame){ box.textContent='Loading GT classes...'; box.classList.add('muted'); }
  try{
    const {ok,j}=await API.post('/api/context/appear',{frame_idx:frame});
    if(token!==CA.appearToken||!CA.open||frame!==S.idx) return;
    const remote=ok&&j.available ? (j.objects||[]).map(o=>({...o,kind:contextClassKind(o.name||classNameForId(o.class_id))})) : null;
    CA.appear=remote===null ? fallback : remote;
    CA.appearFrame=frame;
  }catch(_){
    if(token!==CA.appearToken||!CA.open||frame!==S.idx) return;
    CA.appear=fallback; CA.appearFrame=frame;
  }
  renderContextAppear(CA.appear);
}
function refreshContextAnnotationMeta(){
  if(!CA.open) return;
  $('contextFrameId').textContent=S.frames[S.idx]||'-';
  $('contextTimeRange').textContent=`${videoTime(V.clipStart)}-${videoTime(V.clipEnd)}`;
  $('contextFps').textContent=V.fps?V.fps.toFixed(3):'-';
  refreshContextPhase(); refreshContextAppear();
}
function clearContextForm(){
  CA.restoring=true;
  for(const name of CONTEXT_TEXT_FIELDS) contextEditor(name).textContent='';
  for(const name of CONTEXT_VIS_FIELDS) $('context'+name+'Check').checked=false;
  CA.restoring=false; CA.history=[]; CA.future=[]; setContextStatus('not saved',false);
}
function contextDefaultDir(){ return CA.defaultDir||S.defaultPath||''; }
function updateContextPath(){
  const path=CA.saveDir||CA.importDir;
  $('contextAnnotationPath').textContent=path||'No context folder selected';
  $('contextAnnotationPath').title=path||'';
}
function releaseContextDockedVideo(){
  const saved=CA.dockedVideoRect;
  if(!saved) return;
  const win=$('videoWindow');
  if(V.mode==='float'){
    Object.assign(win.style,{left:saved.left+'px',top:saved.top+'px',right:'auto',
      width:saved.width+'px',height:saved.height+'px'});
  }else clearDockedVideoGeometry();
  CA.dockedVideoRect=null;
}
function positionContextAnnotation(){
  if(!CA.open) return;
  const panel=$('contextAnnotationPanel');
  panel.classList.toggle('split-context',V.mode==='split');
  if(CA.mode==='dock'&&V.mode==='split'){
    const viewport=$('viewport').getBoundingClientRect();
    const w=Math.round(viewport.width*.9),h=Math.round(viewport.height*.9);
    Object.assign(panel.style,{left:(viewport.left+(viewport.width-w)/2)+'px',top:(viewport.top+(viewport.height-h)/2)+'px',
      width:w+'px',height:h+'px'});
    return;
  }
  if(CA.mode==='float'&&CA.floatRect){
    const w=Math.min(CA.floatRect.width,window.innerWidth-16),h=Math.min(CA.floatRect.height,window.innerHeight-70);
    Object.assign(panel.style,{left:clampi(CA.floatRect.left,8,window.innerWidth-w-8)+'px',top:clampi(CA.floatRect.top,58,window.innerHeight-h-8)+'px',width:w+'px',height:h+'px'});
    return;
  }
  if(CA.mode==='dock'&&V.mode==='float'&&window.innerWidth>=960){
    const win=$('videoWindow'), vr=win.getBoundingClientRect();
    if(!CA.dockedVideoRect) CA.dockedVideoRect={left:vr.left,top:vr.top,width:vr.width,height:vr.height};
    const margin=8,gap=8,available=window.innerWidth-margin*2-gap;
    const panelWidth=Math.min(680,Math.max(520,Math.round(available*.5)));
    const videoWidth=available-panelWidth;
    const top=clampi(CA.dockedVideoRect.top,58,window.innerHeight-220);
    const panelHeight=Math.min(Math.max(430,panel.getBoundingClientRect().height||560),window.innerHeight-top-8);
    Object.assign(win.style,{left:margin+'px',top:top+'px',right:'auto',width:videoWidth+'px',height:CA.dockedVideoRect.height+'px'});
    Object.assign(panel.style,{left:(margin+videoWidth+gap)+'px',top:top+'px',width:panelWidth+'px',height:panelHeight+'px'});
    return;
  }
  const vr=$('videoWindow').getBoundingClientRect(), pr=panel.getBoundingClientRect();
  const w=Math.min(Math.max(520,pr.width||680),window.innerWidth-16), h=Math.min(Math.max(430,pr.height||560),window.innerHeight-66);
  let left=vr.right+8;
  if(left+w>window.innerWidth-8) left=vr.left-w-8;
  if(left<8) left=clampi(vr.right-w,8,window.innerWidth-w-8);
  Object.assign(panel.style,{left:left+'px',top:clampi(vr.top,58,window.innerHeight-h-8)+'px',width:w+'px',height:h+'px'});
}
function setContextMode(mode){
  if(!['dock','float'].includes(mode)) mode='dock';
  const panel=$('contextAnnotationPanel');
  if(CA.mode==='float'){
    const r=panel.getBoundingClientRect(); CA.floatRect={left:r.left,top:r.top,width:r.width,height:r.height};
  }
  if(mode==='float') releaseContextDockedVideo();
  CA.mode=mode; panel.classList.toggle('mode-float',mode==='float'); panel.classList.toggle('mode-dock',mode==='dock');
  try{ localStorage.setItem('issas.contextMode',mode); }catch(_){}
  $('contextModeDock').classList.toggle('on',mode==='dock'); $('contextModeFloat').classList.toggle('on',mode==='float');
  requestAnimationFrame(positionContextAnnotation);
}
function openContextAnnotation(){
  if(!V.open){ toast('Open the context video first','err'); return; }
  CA.open=true; CA.activeFrame=S.idx; $('contextAnnotationPanel').classList.remove('hidden');
  const draft=CA.drafts.get(S.idx); if(draft){ restoreContextSnapshot(draft.snapshot); setContextStatus(draft.dirty?'edited':'draft',draft.dirty); }
  refreshContextAnnotationMeta(); updateContextPath(); setContextMode(V.mode==='split'?'dock':CA.mode);
}
function closeContextAnnotation(){
  if(CA.mode==='float'){
    const r=$('contextAnnotationPanel').getBoundingClientRect(); CA.floatRect={left:r.left,top:r.top,width:r.width,height:r.height};
  }
  releaseContextDockedVideo();
  CA.open=false; CA.appearToken++; hideContextSuggestions(); $('videoSeekTimestamp').classList.add('hidden'); $('contextAnnotationPanel').classList.add('hidden');
}
function contextPayload(){
  const snap=contextSnapshot();
  return {video:V.name,frame_id:S.frames[S.idx]||'',fps:V.fps,
    clip:{start:V.clipStart,end:V.clipEnd,center:V.center,context_seconds:V.contextSeconds},
    phases:contextClipPhases(),
    appear:(CA.appearFrame===S.idx?CA.appear:contextAppearFromEditor()),
    annotation:{action:snap.text.Action,intent:snap.text.Intent,tissue_state:snap.text.TissueState,
      free_text:snap.text.FreeText,visibility:{smoke:{checked:snap.visibility.Smoke,text:snap.text.Smoke},
      bleeding:{checked:snap.visibility.Bleeding,text:snap.text.Bleeding},occlusion:{checked:snap.visibility.Occlusion,text:snap.text.Occlusion}}}};
}
function contextStorageKey(kind){ return `issas.context${kind==='save'?'Save':'Import'}Dir:${CA.caseRoot||CA.defaultDir||''}`; }
function chooseContextDir(kind,runAfter,startOverride){
  openBrowser({title:kind==='save'?'Choose context output folder':'Choose context import folder',onSelect:p=>{
    if(!p) return;
    if(kind==='save'){ CA.saveDir=p; try{localStorage.setItem(contextStorageKey('save'),p);}catch(_){} }
    else { CA.importDir=p; try{localStorage.setItem(contextStorageKey('import'),p);}catch(_){} }
    updateContextPath(); if(runAfter) runAfter();
  },start:startOverride||(kind==='save'?CA.saveDir:CA.importDir)||contextDefaultDir()});
}
async function saveContextAnnotation(){
  if(!CA.open) return;
  if(CA.appearFrame!==S.idx) await refreshContextAppear();
  if(!CA.saveDir){
    const {ok,j}=await API.post('/api/context/default-directory',{});
    if(!ok){ toast(j.detail||'Could not create the context folder','err'); return; }
    CA.defaultDir=j.path; chooseContextDir('save',saveContextAnnotation,j.path); return;
  }
  const {ok,j}=await API.post('/api/context/save',{frame_idx:S.idx,directory:CA.saveDir,data:contextPayload()});
  if(!ok){ toast(j.detail||'Context save failed','err'); return; }
  setContextStatus('saved',false); CA.drafts.set(S.idx,{snapshot:contextSnapshot(),dirty:false}); updateContextPath(); flashScreen(); toast(`Context saved: ${S.frames[S.idx]}`,'ok');
}
function applyImportedContext(data){
  const ann=data?.annotation||{}, vis=ann.visibility||{};
  const values={Action:ann.action,Intent:ann.intent,TissueState:ann.tissue_state,FreeText:ann.free_text,
    Smoke:vis.smoke?.text,Bleeding:vis.bleeding?.text,Occlusion:vis.occlusion?.text};
  CA.restoring=true;
  for(const name of CONTEXT_TEXT_FIELDS) contextEditor(name).textContent=values[name]||'';
  for(const name of CONTEXT_VIS_FIELDS) $('context'+name+'Check').checked=!!vis[name.toLowerCase()]?.checked;
  CA.restoring=false; CA.history=[]; CA.future=[]; setContextStatus('imported',false);
}
async function importContextAnnotation(){
  if(!CA.open) return;
  if(!CA.importDir){ chooseContextDir('import',importContextAnnotation); return; }
  const {ok,j}=await API.post('/api/context/import',{dir:CA.importDir,frame_idx:S.idx});
  if(!ok){ toast(j.detail||'Context import failed','err'); return; }
  applyImportedContext(j.data); updateContextPath(); toast(`Context imported: ${S.frames[S.idx]}`,'ok');
}
function contextWordAtCaret(editor){
  const sel=window.getSelection(); if(!sel||!sel.rangeCount||!editor.contains(sel.anchorNode)) return null;
  const range=sel.getRangeAt(0), node=sel.anchorNode;
  if(node.nodeType!==Node.TEXT_NODE) return {query:'',range};
  const before=node.data.slice(0,sel.anchorOffset), starts=[0];
  for(let i=0;i<before.length;i++) if(/[\s,.;:()]/.test(before[i])) starts.push(i+1);
  const vocab=contextVocabulary(editor), matches=[];
  for(const start of starts){ const query=before.slice(start).trimStart(); if(query.length<2) continue;
    if(vocab.some(item=>item.name.toLowerCase().startsWith(query.toLowerCase()))) matches.push({start:sel.anchorOffset-query.length,query}); }
  if(!matches.length) return null;
  const best=matches.sort((a,b)=>b.query.length-a.query.length)[0], replace=document.createRange();
  replace.setStart(node,best.start); replace.setEnd(node,sel.anchorOffset);
  return {query:best.query,range:replace};
}
function hideContextSuggestions(){ $('contextSuggest').classList.add('hidden'); CA.suggestions=[]; }
function showContextSuggestions(editor){
  CA.activeEditor=editor; const word=contextWordAtCaret(editor);
  if(!word||word.query.length<2){ hideContextSuggestions(); return; }
  const q=word.query.toLowerCase().trim();
  CA.suggestions=contextVocabulary(editor).filter(x=>x.name.toLowerCase().includes(q)).slice(0,8);
  if(!CA.suggestions.length){ hideContextSuggestions(); return; }
  CA.suggestionIndex=0; const box=$('contextSuggest'); box.innerHTML='';
  CA.suggestions.forEach((item,i)=>{ const b=document.createElement('button'); b.type='button';
    b.className=(i===0?'active ':'')+`ctx-name ctx-${item.kind}`; b.textContent=item.name;
    b.addEventListener('mousedown',e=>{e.preventDefault();completeContextSuggestion(i);}); box.appendChild(b); });
  const r=editor.getBoundingClientRect(); box.style.left=clampi(r.left,8,window.innerWidth-Math.min(360,window.innerWidth*.42)-8)+'px';
  box.style.top=Math.min(window.innerHeight-180,r.bottom+4)+'px'; box.classList.remove('hidden');
}
function completeContextSuggestion(index=CA.suggestionIndex,trigger='Tab'){
  const item=CA.suggestions[index], editor=CA.activeEditor, word=editor&&contextWordAtCaret(editor); if(!item||!word) return;
  pushContextHistory(); const token=document.createElement('span'); token.className=`ctx-name ctx-${item.kind}`; token.textContent=item.name;
  token.dataset.term=item.name;
  word.range.deleteContents(); word.range.insertNode(token);
  const sel=window.getSelection(), range=document.createRange();
  if(item.kind==='action'&&trigger!==' '){
    range.selectNodeContents(token); range.collapse(false);
  }else{
    const space=document.createTextNode(' '); token.after(space); range.setStart(space,1); range.collapse(true);
  }
  sel.removeAllRanges(); sel.addRange(range);
  hideContextSuggestions(); setContextStatus('edited',true); editor.focus();
}

function contextActionForms(base){
  const forms=new Set([base,base+'s',base+'ed',base+'ing']);
  if(/e$/i.test(base)){ forms.add(base+'d'); forms.add(base.slice(0,-1)+'ing'); }
  if(/[^aeiou][aeiou][^aeiouwxy]$/i.test(base)){ const last=base.slice(-1); forms.add(base+last+'ed'); forms.add(base+last+'ing'); }
  if(/y$/i.test(base)){ forms.add(base.slice(0,-1)+'ies'); forms.add(base.slice(0,-1)+'ied'); }
  return [...forms];
}
function contextStyledPrefix(span){
  const text=span.textContent||'';
  let base=span.dataset.term||'';
  if(!base){
    const kind=[...span.classList].find(x=>x.startsWith('ctx-')&&x!=='ctx-name')?.slice(4);
    base=contextVocabulary(span.closest('.context-edit')).filter(x=>x.kind===kind&&text.toLowerCase().startsWith(x.name.toLowerCase()))
      .sort((a,b)=>b.name.length-a.name.length)[0]?.name||text;
    span.dataset.term=base;
  }
  if(!span.classList.contains('ctx-action')) return Math.min(base.length,text.length);
  const forms=contextActionForms(base), lower=text.toLowerCase();
  if(forms.some(form=>form.toLowerCase().startsWith(lower))) return text.length;
  return forms.filter(form=>lower.startsWith(form.toLowerCase())).sort((a,b)=>b.length-a.length)[0]?.length||Math.min(base.length,text.length);
}
function normalizeContextTokens(editor){
  const sel=window.getSelection();
  // contenteditable may synthesize <b>/<u> wrappers when typing at the edge of
  // a styled token. The panel has no free-form formatting, so remove those
  // wrappers and keep formatting exclusively on our semantic token spans.
  for(const wrapper of editor.querySelectorAll('b,u,strong,font')) wrapper.replaceWith(...wrapper.childNodes);
  for(const span of editor.querySelectorAll('.ctx-name')){
    const keep=contextStyledPrefix(span), text=span.textContent||'';
    if(keep>=text.length) continue;
    const overflow=text.slice(keep), plain=document.createTextNode(overflow), anchor=sel?.anchorNode, offset=sel?.anchorOffset||0;
    const anchorInside=!!(anchor&&span.contains(anchor));
    span.textContent=text.slice(0,keep); span.after(plain);
    if(sel&&anchorInside){
      const range=document.createRange(); range.setStart(plain,Math.max(0,Math.min(overflow.length,offset-keep))); range.collapse(true);
      sel.removeAllRanges(); sel.addRange(range);
    }
  }
}

CONTEXT_TEXT_FIELDS.forEach(name=>{
  const editor=contextEditor(name);
  editor.addEventListener('beforeinput',pushContextHistory);
  editor.addEventListener('input',()=>{ if(!CA.restoring){ normalizeContextTokens(editor); setContextStatus('edited',true); showContextSuggestions(editor); } });
  editor.addEventListener('keydown',e=>{
    if(!$('contextSuggest').classList.contains('hidden')){
      if(e.key==='ArrowDown'||e.key==='ArrowUp'){ e.preventDefault(); CA.suggestionIndex=(CA.suggestionIndex+(e.key==='ArrowDown'?1:-1)+CA.suggestions.length)%CA.suggestions.length;
        [...$('contextSuggest').children].forEach((b,i)=>b.classList.toggle('active',i===CA.suggestionIndex)); return; }
      if(e.key==='Tab'||e.key==='Enter'){ e.preventDefault(); completeContextSuggestion(CA.suggestionIndex,e.key); return; }
      if(e.key==='Escape'){ e.preventDefault(); hideContextSuggestions(); }
    }
  });
});
CONTEXT_VIS_FIELDS.forEach(name=>$('context'+name+'Check').addEventListener('change',()=>{pushContextHistory();setContextStatus('edited',true);contextEditor(name).focus();}));
$('contextAnnotationOpen').addEventListener('click',openContextAnnotation);
$('contextAnnotationClose').addEventListener('click',closeContextAnnotation);
$('contextModeDock').addEventListener('click',()=>setContextMode('dock'));
$('contextModeFloat').addEventListener('click',()=>setContextMode('float'));
$('contextSave').addEventListener('click',saveContextAnnotation);
$('contextImport').addEventListener('click',importContextAnnotation);
$('contextImportDir').addEventListener('click',()=>chooseContextDir('import'));
window.addEventListener('resize',positionContextAnnotation);
if(window.ResizeObserver) new ResizeObserver(()=>{ if(CA.open&&CA.mode==='float'){
  const r=$('contextAnnotationPanel').getBoundingClientRect(); CA.floatRect={left:r.left,top:r.top,width:r.width,height:r.height};
}}).observe($('contextAnnotationPanel'));

$('contextAnnotationDrag').addEventListener('pointerdown',e=>{
  if(e.button!==0||e.target.closest('button')) return;
  if(CA.mode==='dock') setContextMode('float');
  const panel=$('contextAnnotationPanel'),r=panel.getBoundingClientRect(),dx=e.clientX-r.left,dy=e.clientY-r.top,id=e.pointerId;
  const move=ev=>{ const w=panel.offsetWidth,h=panel.offsetHeight; panel.style.left=clampi(ev.clientX-dx,8,window.innerWidth-w-8)+'px'; panel.style.top=clampi(ev.clientY-dy,58,window.innerHeight-h-8)+'px'; };
  const up=()=>{ panel.releasePointerCapture?.(id); panel.removeEventListener('pointermove',move); panel.removeEventListener('pointerup',up); const q=panel.getBoundingClientRect(); CA.floatRect={left:q.left,top:q.top,width:q.width,height:q.height}; };
  panel.setPointerCapture(id); panel.addEventListener('pointermove',move); panel.addEventListener('pointerup',up);
});

// ============================ EVENTS ============================
let lastMouse=null;

// -- open folder --
$('openBtn').addEventListener('click', async ()=>{
  let path=$('folderPath').value.trim().replace(/\\/g,'/'); if(!path){ toast('Enter a folder path','err'); return; }
  if(await loadFolderIntoEditor(path)){ setDefaultExportDirs(path); S.idx=0; await loadFrame(0,{force:true, noProp:true}); fitViewSoon(); toast('Loaded '+S.count+' frames','ok'); }
});
// core loader — used by Open folder, the file tree, and refine. Fully resets SAM (new case).
async function loadFolderIntoEditor(path){
  path=(path||'').replace(/\\/g,'/'); if(!path){ toast('Enter a folder path','err'); return false; }
  $('folderPath').value=path;
  showOverlay('Loading frames…');
  const {ok,j}=await API.post('/api/open_folder',{path});
  if(!ok){ hideOverlay(); toast(j.detail||'open failed','err'); return false; }
  S.count=j.count; S.frames=j.names; S.sam2=j.sam2_available; S.device=j.device;
  applyVideoStatus(j.video);
  $('modeBadge').textContent = S.sam2? `SAM · ${S.device}` : 'simulation';
  $('modeBadge').className = 'badge '+(S.sam2?'badge-live':'badge-sim');
  $('frameSlider').max=S.count-1;
  S.objects.clear(); S.order=[]; S.currentId=null; S.frameMasks.clear(); S.rawMasks.clear();
  CA.drafts.clear(); CA.activeFrame=null; clearContextForm();
  saveConfigured=false; S.dirty=false; pendingFrame=null; S.refineSrc=null;
  // import folders are per-case: unbind them so the new case asks once instead of
  // silently importing the previous case's masks (frame numbering repeats across cases)
  setImportDir('mask', null); setImportDir('prompts', null);
  importedThisSession=false;        // let the first import of the new case set propagation again
  rebuildObjList();
  $('overlayText').textContent = S.sam2? 'Initializing SAM2… (new case — resetting model)' : 'Preparing…';
  await API.post('/api/init',{});   // fresh init_state = SAM memory cleared for the new case
  hideOverlay();
  return true;
}
function setDefaultExportDirs(imagesPath){
  // default save = sibling masks/ + labels/ of the images folder (user can override)
  const parent=imagesPath.replace(/\/+$/,'').replace(/\/[^\/]*$/,'');
  $('pngDir').value=parent+'/masks';
  $('yoloDir').value=parent+'/labels';
  CA.caseRoot=parent; CA.defaultDir=parent+'/context'; CA.saveDir=null; CA.importDir=null;
  try{
    CA.saveDir=localStorage.getItem(contextStorageKey('save'))||null;
    CA.importDir=localStorage.getItem(contextStorageKey('import'))||null;
  }catch(_){}
  updateContextPath();
}

// -- canvas mouse --
canvas.addEventListener('contextmenu', e=>e.preventDefault());
canvas.addEventListener('mousedown', (e)=>{
  if(!S.img) return;
  const rect=canvas.getBoundingClientRect(); const sx=e.clientX-rect.left, sy=e.clientY-rect.top;
  // pan: middle button or space held
  if(e.button===1 || S.spaceDown){ S.panning=true; S.panStart=[sx,sy,S.panX,S.panY]; canvas.style.cursor='grabbing'; e.preventDefault(); return; }

  const [ix,iy]=toImg(sx,sy);
  if(S.currentId==null){ toast('Add or select an object first'); return; }

  // brush mode
  if(S.brush){
    snapshot(); lockRaw(S.currentId); S.brushing=true; S.brushPositive=(e.button===0);
    paintCircle(ix,iy,S.brushPositive); render(); return;
  }
  // box: ctrl+drag
  if(e.ctrlKey && e.button===0){ S.dragBox=true; S.boxStart=[ix,iy]; S.tempBox=[ix,iy,ix,iy]; return; }
  // points
  if(ix<0||iy<0||ix>=S.W||iy>=S.H) return;
  const label = e.button===2? 0 : 1;
  if(e.button===2){ S.boxes.delete(S.currentId); }  // right-click also clears box (as in desktop)
  if(!S.points.has(S.currentId)) S.points.set(S.currentId,[]);
  S.points.get(S.currentId).push({x:ix,y:iy,label});
  render(); runPredict();
});
canvas.addEventListener('mousemove',(e)=>{
  const rect=canvas.getBoundingClientRect(); const sx=e.clientX-rect.left, sy=e.clientY-rect.top;
  lastMouse=[sx,sy];
  if(S.panning){ S.panX=S.panStart[2]+(sx-S.panStart[0]); S.panY=S.panStart[3]+(sy-S.panStart[1]); render(); return; }
  const [ix,iy]=toImg(sx,sy);
  if(S.brushing){ const [lx,ly]=S._lastImg||[ix,iy]; brushLine(lx,ly,ix,iy,S.brushPositive); S._lastImg=[ix,iy]; render(); return; }
  S._lastImg=[ix,iy];
  if(S.dragBox){ S.tempBox=[Math.min(S.boxStart[0],ix),Math.min(S.boxStart[1],iy),
                            Math.max(S.boxStart[0],ix),Math.max(S.boxStart[1],iy)]; render(); return; }
  if(S.brush) render();
});
window.addEventListener('mouseup',(e)=>{
  if(S.panning){ S.panning=false; canvas.style.cursor=S.brush?'none':'crosshair'; return; }
  if(S.brushing){ S.brushing=false; S._lastImg=null; S.dirty=true; rebuildObjList(); return; }
  if(S.dragBox){
    S.dragBox=false;
    if(S.tempBox && Math.abs(S.tempBox[2]-S.tempBox[0])>=5 && Math.abs(S.tempBox[3]-S.tempBox[1])>=5){
      S.boxes.set(S.currentId, S.tempBox.slice());
      S.boxFlash={box:S.tempBox.slice(), color:'#37e5a0', start:performance.now(), dur:500};
      S.tempBox=null; tickBoxFlash(); runPredict();
    } else { S.tempBox=null; render(); }
  }
});

// -- wheel: ctrl=zoom at cursor, plain=pan --
canvas.addEventListener('wheel',(e)=>{
  if(!S.img) return;
  e.preventDefault();
  const rect=canvas.getBoundingClientRect(); const cx=e.clientX-rect.left, cy=e.clientY-rect.top;
  if(e.ctrlKey || e.metaKey){
    const factor=Math.exp(-e.deltaY*0.0015); setZoom(S.scale*factor, cx, cy);
  } else if(e.shiftKey){ S.panX-=e.deltaY; render(); }
  else { S.panY-=e.deltaY; S.panX-=e.deltaX; render(); }
},{passive:false});

// -- minimap pan --
let miniDrag=false;
function miniPan(e){
  const rect=mini.getBoundingClientRect(); const mx=e.clientX-rect.left, my=e.clientY-rect.top;
  const p=miniToImage(mx,my); if(!p) return;
  const [vw,vh]=vpSize(); S.panX=vw/2-p[0]*S.scale; S.panY=vh/2-p[1]*S.scale; render();
}
mini.addEventListener('mousedown',(e)=>{miniDrag=true; miniPan(e);});
window.addEventListener('mousemove',(e)=>{ if(miniDrag) miniPan(e); });
window.addEventListener('mouseup',()=>{miniDrag=false;});

// -- zoom HUD --
$('zoomSlider').addEventListener('input', e=> setZoom(+e.target.value/100));
$('zoomIn').addEventListener('click', ()=>setZoom(S.scale*1.2));
$('zoomOut').addEventListener('click', ()=>setZoom(S.scale/1.2));
/* ---------- legend: keep it on exactly one line ----------
   A wrapped legend makes the bottom bar taller and shoves the canvas up, so
   instead of guessing breakpoints we measure and drop the lowest-priority
   chips (data-pri, higher = dropped first) until the row fits.            */
let legendChips=null;
function fitLegend(){
  const box=$('legend'); if(!box || !box.clientWidth) return;
  if(!legendChips){
    legendChips=[...box.querySelectorAll('.kc')]
      .map((el,i)=>({el, pri:+el.dataset.pri||0, i}))
      .sort((a,b)=> b.pri-a.pri || b.i-a.i)      // low priority first, rightmost first
      .map(o=>o.el);
  }
  for(const el of legendChips) el.classList.remove('kc-off');
  let n=0;
  while(box.scrollWidth > box.clientWidth+1 && n<legendChips.length){
    legendChips[n++].classList.add('kc-off');
  }
}
let legendRaf=0;
function fitLegendSoon(){
  cancelAnimationFrame(legendRaf);
  legendRaf=requestAnimationFrame(fitLegend);
}
if(window.ResizeObserver) new ResizeObserver(fitLegendSoon).observe($('legend'));

/* ---------- panel layout: hide + drag-resize ----------
   Widths and the bottom-bar height live in CSS vars; collapse states are body
   classes. Everything is persisted so an annotator keeps their layout.        */
const LAYOUT_KEY='issas.layout';
const LAYOUT_DEF={left:236, right:268, bottom:null, hideL:false, hideR:false, hideB:false};
const LAYOUT_MIN={left:170, right:190, bottom:46};
const LAYOUT_MAX={left:560, right:600, bottom:360};
let Layout=Object.assign({}, LAYOUT_DEF);
try{ const raw=localStorage.getItem(LAYOUT_KEY); if(raw) Layout=Object.assign(Layout, JSON.parse(raw)); }catch(_){}

function saveLayout(){ try{ localStorage.setItem(LAYOUT_KEY, JSON.stringify(Layout)); }catch(_){} }
function applyLayout(persist){
  const b=document.body;
  b.style.setProperty('--left-w',  Layout.left+'px');
  b.style.setProperty('--right-w', Layout.right+'px');
  b.style.setProperty('--bottom-h', Layout.bottom? Layout.bottom+'px' : 'auto');
  b.classList.toggle('no-left',   Layout.hideL);
  b.classList.toggle('no-right',  Layout.hideR);
  b.classList.toggle('no-bottom', Layout.hideB);
  $('tglLeft').classList.toggle('on',   !Layout.hideL);
  $('tglRight').classList.toggle('on',  !Layout.hideR);
  $('tglBottom').classList.toggle('on', !Layout.hideB);
  $('gutterL').setAttribute('aria-valuenow',String(Layout.left));
  if(persist!==false) saveLayout();
}
function togglePanel(which){
  const k = which==='left'?'hideL' : which==='right'?'hideR' : 'hideB';
  Layout[k]=!Layout[k]; applyLayout();
}
$('tglLeft').addEventListener('click',   ()=>togglePanel('left'));
$('tglRight').addEventListener('click',  ()=>togglePanel('right'));
$('tglBottom').addEventListener('click', ()=>togglePanel('bottom'));
$('collapseLeft').addEventListener('click',   ()=>togglePanel('left'));
$('collapseRight').addEventListener('click',  ()=>togglePanel('right'));
$('collapseBottom').addEventListener('click', ()=>togglePanel('bottom'));

// generic gutter drag; pointer capture keeps events coming when the cursor
// leaves the 11px handle, which it always does
function bindGutter(el, onMove, onReset){
  el.addEventListener('pointerdown', e=>{
    if(e.button!==0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging'); document.body.classList.add('resizing');
    const move=ev=>{ onMove(ev); applyLayout(false); };
    const up=()=>{
      el.classList.remove('dragging'); document.body.classList.remove('resizing');
      el.removeEventListener('pointermove',move);
      el.removeEventListener('pointerup',up);
      el.removeEventListener('pointercancel',up);
      saveLayout();
    };
    el.addEventListener('pointermove',move);
    el.addEventListener('pointerup',up);
    el.addEventListener('pointercancel',up);
  });
  el.addEventListener('dblclick', ()=>{ onReset(); applyLayout(); });
}
bindGutter($('gutterL'),
  ev=>{ const r=document.querySelector('.workspace').getBoundingClientRect();
        Layout.left = clampi(Math.round(ev.clientX - r.left - 12), LAYOUT_MIN.left, LAYOUT_MAX.left); },
  ()=>{ Layout.left = LAYOUT_DEF.left; });
$('gutterL').addEventListener('keydown',e=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
  e.preventDefault();
  if(e.key==='Home') Layout.left=LAYOUT_MIN.left;
  else if(e.key==='End') Layout.left=LAYOUT_MAX.left;
  else Layout.left=clampi(Layout.left+(e.key==='ArrowLeft'?-12:12),LAYOUT_MIN.left,LAYOUT_MAX.left);
  applyLayout();
});
bindGutter($('gutterR'),
  ev=>{ const r=document.querySelector('.workspace').getBoundingClientRect();
        Layout.right = clampi(Math.round(r.right - ev.clientX - 12), LAYOUT_MIN.right, LAYOUT_MAX.right); },
  ()=>{ Layout.right = LAYOUT_DEF.right; });
bindGutter($('gutterB'),
  ev=>{ Layout.bottom = clampi(Math.round(window.innerHeight - ev.clientY), LAYOUT_MIN.bottom, LAYOUT_MAX.bottom); },
  ()=>{ Layout.bottom = null; });

/* ---------- fullscreen ---------- */
function isFullscreen(){ return !!(document.fullscreenElement||document.webkitFullscreenElement); }
async function toggleFullscreen(){
  try{
    if(isFullscreen()){
      if(document.exitFullscreen) await document.exitFullscreen();
      else if(document.webkitExitFullscreen) document.webkitExitFullscreen();
    }else{
      const el=document.documentElement;
      if(el.requestFullscreen) await el.requestFullscreen();
      else if(el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      else { toast('Fullscreen not supported by this browser','err'); return; }
    }
  }catch(_){ toast('Fullscreen was blocked by the browser','err'); }
}
function syncFsBtn(){
  const on=isFullscreen();
  $('fsLabel').textContent = on? 'Exit' : 'Full';
  $('fsBtn').title = (on? 'Leave fullscreen' : 'Fullscreen') + ' (Ctrl+F)';
  $('fsBtn').classList.toggle('btn-accent', on);
}
$('fsBtn').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', syncFsBtn);
document.addEventListener('webkitfullscreenchange', syncFsBtn);

$('fitBtn').addEventListener('click', fitView);
$('oneToOneBtn').addEventListener('click', ()=>setZoom(1));

// -- visualization toggles --
const bindVis=(elId,key)=>{ $(elId).addEventListener('change',e=>{
  S.vis[key]=e.target.checked; if(key==='fill'||key==='boundary') invalidateAllTints(); render(); }); };
bindVis('visFill','fill'); bindVis('visBoundary','boundary'); bindVis('visIds','ids');
bindVis('visPoints','points'); bindVis('visBoxes','boxes');

// -- brush --
$('brushBtn').addEventListener('click',()=>{
  if(typeof C!=='undefined' && C.open){
    if(!C.refine.side){ toast('Select Refine A or Refine B first'); return; }
    C.refine.brush=!C.refine.brush;
    const on=C.refine.brush;
    $('cmpBrush').textContent='Brush: '+(on?'ON':'OFF');
    $('cmpBrush').classList.toggle('on',on);
    $('brushBtn').textContent='Brush: '+(on?'ON':'OFF'); $('brushBtn').classList.toggle('on',on);
    cmpCanvas.classList.toggle('cmp-brushing',on);
    if(!on) C.refine.brushCursor=null;
    syncCmpCursor();
    cmpRender();
    return;
  }
  S.brush=!S.brush; const b=$('brushBtn');
  b.textContent='Brush: '+(S.brush?'ON':'OFF'); b.classList.toggle('on',S.brush);
  canvas.style.cursor=S.brush?'none':'crosshair'; render();
});
$('brushSlider').addEventListener('input',e=>{
  if(typeof C!=='undefined' && C.open){
    if(!C.refine.side) return;
    C.refine.brushSize=+e.target.value;
    $('cmpBrushSize').value=C.refine.brushSize;
    $('brushLabel').textContent=C.refine.brushSize;
    cmpRender();
    return;
  }
  S.brushSize=+e.target.value; $('brushLabel').textContent=S.brushSize; render();
});
function adjustActiveBrushSize(delta){
  if(typeof C!=='undefined'&&C.open&&C.refine.side&&C.refine.brush){
    C.refine.brushSize=clampi(C.refine.brushSize+delta,5,120);
    $('cmpBrushSize').value=C.refine.brushSize; $('brushSlider').value=C.refine.brushSize;
    $('brushLabel').textContent=C.refine.brushSize; cmpRender(); return true;
  }
  if(typeof C!=='undefined'&&C.open) return false;
  if(S.brush){
    S.brushSize=clampi(S.brushSize+delta,5,120);
    $('brushSlider').value=S.brushSize; $('brushLabel').textContent=S.brushSize; render(); return true;
  }
  return false;
}

// -- post-processing steppers --
document.querySelectorAll('[data-pp]').forEach(btn=>btn.addEventListener('click',()=>{
  const op=btn.dataset.pp, d=+btn.dataset.d;
  if(op==='gaussian'){ S.gauss=Math.max(1,S.gauss+d); $('gaussVal').textContent=S.gauss; }
  if(op==='morph'){ S.morph=Math.max(1,S.morph+d); $('morphVal').textContent=S.morph; }
  if(op==='components'){ S.comp=Math.max(1,S.comp+d); $('compVal').textContent=S.comp; }
}));
document.querySelectorAll('[data-apply]').forEach(btn=>btn.addEventListener('click',()=>applyPP(btn.dataset.apply)));

// -- add object (styled class picker) --
let addObjTarget='annotation';
$('addObjBtn').addEventListener('click', ()=>openAddObj(C.open?'review':'annotation'));
$('addObjClose').addEventListener('click', closeAddObj);
$('addObj').addEventListener('click', e=>{ if(e.target.id==='addObj') closeAddObj(); });
$('classSearch').addEventListener('input', renderClassList);
$('classSearch').addEventListener('keydown', e=>{
  if(e.key==='Enter'){ const first=$('classList').querySelector('.class-row'); if(first) first.click(); }
  if(e.key==='Escape') closeAddObj();
});

function openAddObj(target='annotation'){
  if(target==='annotation'&&!S.count){ toast('Open a folder first'); return; }
  if(target==='review'&&(!C.open||!C.refine.side)){ toast('Select Refine A or Refine B first'); return; }
  addObjTarget=target;
  $('addObjTitle').textContent=target==='review'?`Add class to ${cmpRefineAnn()}`:'Add object';
  $('classSearch').value=''; renderClassList();
  $('addObj').classList.remove('hidden'); $('classSearch').focus();
}
function closeAddObj(){ $('addObj').classList.add('hidden'); }
function annotationColorForClass(classId){ return colorForObj(classId); }
function classDot(classId){ const [r,g,b]=annotationColorForClass(classId); return `rgb(${r},${g},${b})`; }
function addPickedClass(classId,name){
  closeAddObj();
  if(addObjTarget==='review') addCmpClass(classId,name);
  else addObject(classId,name);
}

function renderClassList(){
  const q=$('classSearch').value.trim().toLowerCase();
  const list=$('classList'); list.innerHTML='';
  const existingAnnotationClasses=addObjTarget==='annotation'
    ? new Set([...S.objects.values()].map(obj=>obj.classId)) : new Set();
  const known=new Set([...Object.keys(S.classGroups.tissue||{}), ...Object.keys(S.classGroups.instrument||{})]);
  const custom={}; for(const [n,i] of Object.entries(S.classMap)) if(!known.has(n)) custom[n]=i;
  const groups=[['Tissue & organs', S.classGroups.tissue||{}],
                ['Instruments', S.classGroups.instrument||{}]];
  if(Object.keys(custom).length) groups.push(['Custom', custom]);

  for(const [gname,gmap] of groups){
    const names=Object.keys(gmap).filter(n=>n.toLowerCase().includes(q));
    if(!names.length) continue;
    const gl=document.createElement('div'); gl.className='class-group'; gl.textContent=gname; list.appendChild(gl);
    for(const n of names){
      const row=document.createElement('div'); row.className='class-row';
      row.innerHTML=`<span class="obj-dot" style="background:${classDot(gmap[n])}"></span>
        <span class="class-name">${n}</span><span class="mono class-id">${existingAnnotationClasses.has(+gmap[n])?'add another':'#'+gmap[n]}</span>`;
      row.addEventListener('click',()=>addPickedClass(gmap[n],n));
      list.appendChild(row);
    }
  }
  // offer to create a custom class when the typed name isn't an exact match
  const raw=$('classSearch').value.trim();
  if(raw && !Object.keys(S.classMap).some(n=>n.toLowerCase()===raw.toLowerCase())){
    const norm=raw.charAt(0).toUpperCase()+raw.slice(1);
    const row=document.createElement('div'); row.className='class-row custom-row';
    row.innerHTML=`<span class="ico">＋</span><span class="class-name">Add custom class “${norm}”</span>`;
    row.addEventListener('click',()=>{
      const ids=Object.values(S.classMap); const cid=(ids.length?Math.max(...ids):0)+1;
      S.classMap[norm]=cid; addPickedClass(cid,norm);
    });
    list.appendChild(row);
  }
}

// -- propagation toggle --
$('propBtn').addEventListener('click',()=>{
  S.propagation=!S.propagation; const b=$('propBtn');
  b.textContent='Propagation: '+(S.propagation?'ON':'OFF'); b.classList.toggle('on',S.propagation);
});

// -- re-propagate from current frame (gated on Propagation ON) --
$('reseedBtn').addEventListener('click', reseedFromHere);
async function reseedFromHere(){
  if(!S.count){ toast('Open a folder first'); return; }
  if(!S.propagation){ toast('Turn Propagation ON to re-propagate','err'); return; }
  if(!S.sam2){ toast('Re-propagate needs SAM2 (not simulation)','err'); return; }
  const objects=[];
  for(const id of S.order){
    const obj=S.objects.get(id);
    if(obj.visible && obj.bin.some(v=>v)) objects.push({obj_id:id, mask:binToPngB64(obj.bin)});
  }
  if(objects.length===0){ toast('No visible masks on this frame to seed','err'); return; }
  showOverlay('Re-propagating from here…');
  const {ok,j}=await API.post('/api/propagate/reseed',{frame_idx:S.idx, objects});
  hideOverlay();
  if(!ok){ toast(j.detail||'re-propagate failed','err'); return; }
  commitFrame(S.idx);                 // this frame's corrected masks are the new seed
  // downstream frames must regenerate freshly on forward-step
  for(const f of [...S.frameMasks.keys()]) if(f>S.idx) S.frameMasks.delete(f);
  clearRawAfter(S.idx);
  if(S.refineSrc){ S.refineSrc=null; }   // propagation now drives forward, not the annotator's sparse masks
  flashScreen();
  toast(`Re-propagated from frame ${S.idx+1} · seeded ${j.seeded} (${j.seed_kind})`,'ok');
}

// -- Dice report: SAM2-initial vs human-final --
$('diceBtn').addEventListener('click', diceReport);
async function diceReport(){
  if(!S.count){ toast('Open a folder first'); return; }
  commitFrame(S.idx);                 // include the live frame's final masks
  // Multiple Annotation objects can share one class (for example two liver
  // regions). Agreement is class-level, so union those object masks per frame
  // and kind before asking the server for Dice.
  const grouped=new Map();
  for(const [frame, m] of S.rawMasks){
    const finals=S.frameMasks.get(frame);
    for(const [objId, raw] of m){
      const finBin = finals && finals.get(objId);
      if(!finBin && !raw.bin.some(v=>v)) continue;   // nothing on either side
      const key=`${frame}\n${raw.classId}\n${raw.kind}`;
      let item=grouped.get(key);
      if(!item){ item={frame_idx:frame,obj_id:raw.classId,class_id:raw.classId,kind:raw.kind,
        raw:new Uint8Array(S.W*S.H),final:new Uint8Array(S.W*S.H)}; grouped.set(key,item); }
      const fin=finBin||new Uint8Array(S.W*S.H);
      for(let i=0;i<item.raw.length;i++){ if(raw.bin[i]) item.raw[i]=1; if(fin[i]) item.final[i]=1; }
    }
  }
  const records=[...grouped.values()].map(item=>({...item,raw:binToPngB64(item.raw),final:binToPngB64(item.final)}));
  if(records.length===0){ toast('No SAM2 masks captured yet — annotate some frames first'); return; }
  showOverlay('Computing Dice…');
  const {ok,j}=await API.post('/api/dice',{records}); hideOverlay();
  if(!ok){ toast(j.detail||'dice failed','err'); return; }
  S.lastDice=j; renderDicePanel(j);
}
function fmtDice(v){ return v==null? '—' : v.toFixed(3); }
function renderDicePanel(j){
  const el=$('diceBody');
  const block=(title,s)=>{
    if(!s || s.n===0) return `<div class="dice-block"><div class="dice-h">${title}</div><div class="muted">no records</div></div>`;
    const rows=s.per_class.map(c=>`<tr><td>${c.class_name}</td><td class="mono">${c.n}</td>
      <td class="mono">${fmtDice(c.mean_dice)}</td><td class="mono">${c.empty_initial||''}</td></tr>`).join('');
    return `<div class="dice-block">
      <div class="dice-h">${title} <span class="mono dice-overall">mean ${fmtDice(s.overall_mean_dice)} · n=${s.n}</span></div>
      <table class="dice-table"><thead><tr><th>class</th><th>n</th><th>Dice</th><th>empty init</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  };
  el.innerHTML = block('Propagation frames', j.propagation)
              + block('Prompt frames', j.prompt)
              + block('All frames', j.all);
  $('diceModal').classList.remove('hidden');
}
$('diceClose').addEventListener('click',()=>$('diceModal').classList.add('hidden'));
$('diceModal').addEventListener('click',e=>{ if(e.target.id==='diceModal') $('diceModal').classList.add('hidden'); });
$('diceCsv').addEventListener('click',()=>downloadDice('csv'));
$('diceJson').addEventListener('click',()=>downloadDice('json'));
function downloadDice(fmt){
  if(!S.lastDice){ return; }
  let blob, name;
  if(fmt==='json'){ blob=new Blob([JSON.stringify(S.lastDice,null,2)],{type:'application/json'}); name='issas_dice.json'; }
  else {
    const head='frame,class_id,class_name,obj_id,kind,dice,initial_area,final_area,empty_initial,empty_final';
    const lines=S.lastDice.rows.map(r=>[r.frame_idx,r.class_id,`"${r.class_name}"`,r.obj_id,r.kind,
      r.dice,r.initial_area,r.final_area,r.empty_initial,r.empty_final].join(','));
    blob=new Blob([head+'\n'+lines.join('\n')],{type:'text/csv'}); name='issas_dice.csv';
  }
  const url=URL.createObjectURL(blob); const a=document.createElement('a');
  a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url);
}

// ---------- Review mode: multi-annotator agreement ----------
const R = {scan:null, data:null, kind:'inter', metric:'dice', sort:'value-desc', agg:'macro'};
$('reviewBtn').addEventListener('click',()=>{
  // Review is a workspace toggle: leave Compare/refine before opening the review panel.
  if(C.open){ closeCompareWorkspace(); return; }
  openReview();
});
$('reviewClose').addEventListener('click',()=>$('reviewModal').classList.add('hidden'));
$('reviewModal').addEventListener('click',e=>{ if(e.target.id==='reviewModal') $('reviewModal').classList.add('hidden'); });
$('reviewBrowse').addEventListener('click',()=>openBrowser({title:'Choose Results root', start:$('reviewRoot').value||R.defaultRoot, onSelect:p=>{ if(p){ $('reviewRoot').value=p; reviewScan(); } }}));
$('reviewScan').addEventListener('click', reviewScan);
$('refineFoldToggle').addEventListener('click', ()=>{
  $('refineFold').classList.toggle('open');
  $('refineFold').querySelector('.fold-body').classList.toggle('hidden');
});
$('reviewCompute').addEventListener('click', reviewCompute);
$('refineFramesBrowse').addEventListener('click',()=>openBrowser({title:'Choose frames folder (images) for this case', start:$('refineFrames').value||S.defaultPath, onSelect:p=>{ if(p) $('refineFrames').value=p; }}));
$('refineGo').addEventListener('click', ()=>refineInEditor(
  $('reviewRoot').value.trim(), $('reviewCase').value, $('refineAnn').value,
  $('refineFrames').value.trim(), $('refineReviewer').value.trim()||'reviewer'));
async function refineInEditor(root, cse, ann, framesDir, rid){
  if(!root||!cse||!ann){ toast('Scan and pick a case + annotator','err'); return; }
  if(!framesDir){ toast('Set the frames folder (the images)','err'); return; }
  showOverlay('Loading frames…');
  const {ok,j}=await API.post('/api/open_folder',{path:framesDir});
  if(!ok){ hideOverlay(); toast(j.detail||'open failed','err'); return; }
  S.count=j.count; S.frames=j.names; S.sam2=j.sam2_available; S.device=j.device;
  $('modeBadge').textContent = S.sam2? `SAM · ${S.device}` : 'simulation';
  $('modeBadge').className = 'badge '+(S.sam2?'badge-live':'badge-sim');
  $('frameSlider').max=S.count-1; $('folderPath').value=framesDir;
  S.objects.clear(); S.order=[]; S.currentId=null; S.frameMasks.clear(); S.rawMasks.clear();
  saveConfigured=false; S.dirty=false; pendingFrame=null; rebuildObjList();
  await API.post('/api/init',{}); hideOverlay();
  // reviewer output + auto-import source (works even with a single annotator)
  $('pngDir').value = `${root}/${rid}/${cse}/masks`;
  $('yoloDir').value = `${root}/${rid}/${cse}/labels`;
  $('exportPngOnly').checked = true;   // reviewer masks are for analysis → lossless
  S.refineSrc = `${root}/${ann}/${cse}`;
  S.propagation=false; $('propBtn').textContent='Propagation: OFF'; $('propBtn').classList.remove('on');
  $('reviewModal').classList.add('hidden');
  if(C.open) closeCompareWorkspace();
  await loadFrame(0,{force:true, noProp:true}); fitViewSoon();
  toast(`Refining ${ann} → saves to ${rid}/${cse} (PNG)`,'ok');
}
$('reviewCsv').addEventListener('click',()=>downloadReview('csv'));
$('reviewJson').addEventListener('click',()=>downloadReview('json'));
segBind('reviewKind','k',v=>{R.kind=v; renderReview();});
segBind('reviewMetric','m',v=>{R.metric=v; renderReview();});
segBind('reviewSort','s',v=>{R.sort=v; renderReview();});
segBind('reviewAgg','g',v=>{R.agg=v; renderReview();});
// collapsible result sections — delegated so binding never misses
$('reviewResults').addEventListener('click', e=>{
  const h=e.target.closest('.rsec-head'); if(!h) return;
  const sec=document.getElementById(h.dataset.sec); if(sec) sec.classList.toggle('collapsed');
});
function segBind(id,attr,cb){
  $(id).addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b) return;
    [...$(id).children].forEach(x=>x.classList.remove('on')); b.classList.add('on'); cb(b.dataset[attr]); });
}
async function openReview(){
  const wasOpen=!$('reviewModal').classList.contains('hidden');
  if(wasOpen){ $('reviewModal').classList.add('hidden'); return; }
  if(!$('reviewRoot').value){
    try{ const d=await API.get('/api/review/default_root'); R.defaultRoot=d.root; $('reviewRoot').value=d.root; }catch(_){}
  }
  $('reviewModal').classList.remove('hidden');
  const card=$('reviewModal').querySelector('.review-card');
  if(!card._dragInit){ makeDraggable(card, card.querySelector('.modal-head')); card._dragInit=true; }
  card._resetDrag && card._resetDrag();
}
async function reviewScan(){
  const root=$('reviewRoot').value.trim(); if(!root){ toast('Set a Results root','err'); return; }
  showOverlay('Scanning…');
  const {ok,j}=await API.post('/api/review/scan',{root}); hideOverlay();
  if(!ok){ toast(j.detail||'scan failed','err'); return; }
  R.scan=j;
  const sel=$('reviewCase');
  sel.innerHTML='<option value="ALL">— ALL cases —</option>'+j.cases.map(c=>`<option>${c}</option>`).join('');
  sel.onchange=renderAnnChecks; renderAnnChecks();
  if(!j.cases.length) toast('No cases found under that root','err');
}
function renderAnnChecks(){
  const c=$('reviewCase').value;
  const box=$('reviewAnns'); box.innerHTML='';
  const all=(c==='ALL');
  const withCase = all? R.scan.annotators.filter(a=>Object.keys(a.cases).length)
                      : R.scan.annotators.filter(a=>a.cases[c]);
  $('refineAnn').innerHTML=withCase.map(a=>`<option>${a.id}</option>`).join('');
  if(!all){
    const preferred=withCase.filter(a=>!a.is_sam).map(a=>a.id).slice(0,2);
    resolveFramesDir(c, preferred).then(d=>{ $('refineFrames').value=d; });
  }
  if(!withCase.length){ box.innerHTML='<span class="muted">No annotators here.</span>'; return; }
  for(const a of withCase){
    const el=document.createElement('label'); el.className='rcheck';
    const chk = a.is_sam? '' : 'checked';
    const tag = a.is_sam? ' <span class="flag" style="color:var(--amber)">SAM</span>' : '';
    const cnt = all? Object.keys(a.cases).length+'c' : a.cases[c]+'f';
    el.innerHTML=`<input type="checkbox" ${chk} value="${a.id}"><span>${a.id}${tag}</span><span class="cnt">${cnt}</span>`;
    box.appendChild(el);
  }
}
async function resolveFramesDir(cse, annotators){
  const root=$('reviewRoot').value.trim();
  const {ok,j}=await API.post('/api/review/resolve_frames',{
    root, case:cse, annotators:annotators||[],
  });
  if(ok && !j.found){
    toast('No images folder found for annotator A or B — set the frames folder manually','err');
  }
  return ok? (j.dir||'') : '';
}
async function reviewCompute(){
  const root=$('reviewRoot').value.trim(); const c=$('reviewCase').value;
  const anns=[...$('reviewAnns').querySelectorAll('input:checked')].map(x=>x.value);
  if(anns.length<2){ toast('Select at least 2 annotators','err'); return; }
  showOverlay(c==='ALL'? 'Computing agreement across all cases…' : 'Computing agreement…');
  const {ok,j}=await API.post('/api/review/agreement',{root, case:c, annotators:anns}); hideOverlay();
  if(!ok){ toast(j.detail||'agreement failed','err'); return; }
  R.data=j; $('reviewResults').classList.remove('hidden'); renderReview();
  toast(j.multi? `All cases (${j.cases.length}) · saved to _review_all/` : `Saved to ${j.case}/_review/`,'ok');
}
function reviewBar(name, v, higherBetter, maxv, extraTip, nlabel, isAvg, weightedVal){
  const w = (v==null?0 : (higherBetter? v*100 : v/maxv*100)).toFixed(1);
  const cls = (higherBetter?'bar-fill':'bar-fill warn');
  const valTxt = v==null?'—':(higherBetter?v.toFixed(3):v.toFixed(1));
  const wtd = (isAvg && weightedVal!=null)? `<span class="bar-weighted"> · wt ${higherBetter?weightedVal.toFixed(3):weightedVal.toFixed(1)}</span>`:'';
  return `<div class="bar-row${isAvg?' avg':''}" title="${(extraTip||name).replace(/"/g,'&quot;')}"><span class="bar-label">${name}</span>
    <div class="bar-track"><div class="${cls}" style="width:${w}%"></div></div>
    <span class="bar-val">${valTxt}${wtd}</span><span class="bar-n">${nlabel||''}</span></div>`;
}
function renderReview(){
  if(!R.data) return;
  const sub=R.data[R.kind]; const m=R.metric; const multi=R.data.multi;
  const kindLabel={inter:'Inter-observer', intra:'Intra-observer', all:'All pairs'}[R.kind];
  const pset=new Set();
  for(const r of R.data.rows){ if(R.kind==='all'||r.kind===R.kind) pset.add(`${r.ann_a} – ${r.ann_b}`); }
  const pairs=[...pset];
  const scope = multi? ` · across ${R.data.cases.length} cases (macro headline)` : '';
  $('reviewPairs').innerHTML = pairs.length
    ? `<b>${kindLabel}</b>${scope} · ${pairs.length} pair${pairs.length>1?'s':''}: ${pairs.join(' · ')}`
    : `<b>${kindLabel}</b> · no pairs (need ${R.kind==='intra'?'repeat passes of one annotator':'≥2 annotators'})`;
  const higherBetter = (m==='dice'||m==='iou');
  const useMicro = (R.agg==='micro');
  const pcVal = x => useMicro ? x[m+'_micro'] : x[m];      // headline metric per class
  $('reviewAgg').classList.toggle('hidden', !multi);        // macro==micro when single-case

  // ---- per-class chart ----
  let pc=[...sub.per_class];
  pc.sort((a,b)=>{
    if(R.sort==='name') return a.class_name.localeCompare(b.class_name);
    if(R.sort==='n') return b.n-a.n;
    const av=pcVal(a), bv=pcVal(b); if(av==null) return 1; if(bv==null) return -1;
    return R.sort==='value-asc'? av-bv : bv-av;
  });
  const aggLabel = useMicro? 'micro (pooled)' : 'macro (per-case avg)';
  const shown = pc.map(pcVal).filter(v=>v!=null);
  const classUnweighted = shown.length? shown.reduce((s,v)=>s+v,0)/shown.length : null;
  const maxPC=Math.max(0.0001,...pc.map(x=>pcVal(x)==null?0:pcVal(x)), classUnweighted||0);
  let html = pc.map(x=>{
    const tip = multi
      ? `${x.class_name}\nmacro (per-case avg): ${fmtn(x[m])}\nmicro (pooled): ${fmtn(x[m+'_micro'])}\nsamples n=${x.n} over ${x.n_cases} case(s)  ·  showing ${aggLabel}`
      : `${x.class_name} · ${x.n} pairs`;
    const nlab = multi? `n=${x.n}·${x.n_cases}c` : `n=${x.n}`;
    return reviewBar(x.class_name, pcVal(x), higherBetter, maxPC, tip, nlab, false);
  }).join('') || '<div class="muted">No overlapping classes for this split.</div>';
  if(pc.length){
    html += reviewBar('Average', classUnweighted, higherBetter, maxPC,
      `Unweighted mean of the ${aggLabel} class values above (n-weighted = pooled shown beside as "wt")`,
      '', true, sub.overall? sub.overall[m]: null);
  }
  $('reviewChart').innerHTML=html;

  // ---- per-case chart (ALL mode only) — also honors Macro/Micro ----
  $('rsecCase').classList.toggle('hidden', !multi);
  const caseAggLabel = useMicro? 'micro (pooled over samples)' : 'macro (per-class avg)';
  if(multi && sub.per_case){
    let cc=[...sub.per_case];
    cc.sort((a,b)=>{
      if(R.sort==='name') return a.case.localeCompare(b.case);
      if(R.sort==='n') return b.n-a.n;
      const av=pcVal(a), bv=pcVal(b); if(av==null) return 1; if(bv==null) return -1;
      return R.sort==='value-asc'? av-bv : bv-av;
    });
    const cShown=cc.map(pcVal).filter(v=>v!=null);
    const caseUnweighted=cShown.length? cShown.reduce((s,v)=>s+v,0)/cShown.length : null;
    const maxCC=Math.max(0.0001,...cc.map(x=>pcVal(x)==null?0:pcVal(x)), caseUnweighted||0);
    let ch=cc.map(x=>reviewBar(x.case, pcVal(x), higherBetter, maxCC,
      `${x.case}\nmacro (per-class avg): ${fmtn(x[m])}\nmicro (pooled): ${fmtn(x[m+'_micro'])}\nn=${x.n} samples  ·  showing ${caseAggLabel}`,
      `n=${x.n}`, false)).join('');
    ch+=reviewBar('Average', caseUnweighted, higherBetter, maxCC,
      `Unweighted mean across cases (every case counts equally) of the ${caseAggLabel} values; n-weighted pooled shown beside as "wt"`,
      '', true, sub.overall? sub.overall[m]:null);
    $('reviewCaseChart').innerHTML=ch;
  }

  const ov=sub.overall;
  $('reviewOverall').textContent = `${R.kind}${multi?' · all cases':''}: mean Dice ${fmtn(ov.dice)} · IoU ${fmtn(ov.iou)} · HD ${fmtn(ov.hd)} · HD95 ${fmtn(ov.hd95)} · ${sub.n} pairs · ${R.data.n_shared_frames} shared frames`;
  const mv=(x,k)=> useMicro? x[k+'_micro'] : x[k];
  const rows=pc.map(x=>`<tr><td>${x.class_name}</td><td class="mono">${x.n}</td>
    <td class="mono">${fmtn(mv(x,'dice'))}</td><td class="mono">${fmtn(mv(x,'iou'))}</td>
    <td class="mono">${fmtn(mv(x,'hd'))}</td><td class="mono">${fmtn(mv(x,'hd95'))}</td>
    <td class="mono">${x.one_sided||''}</td></tr>`).join('');
  const aggNote = multi? ` (${useMicro?'micro / pooled':'macro / per-case avg'})` : '';
  $('reviewTable').innerHTML=`<thead><tr><th>class</th><th title="Samples = pairs × frames where both annotators labelled the class">n</th><th title="showing ${useMicro?'micro (pooled)':'macro (per-case averaged)'} values">Dice${aggNote}</th><th>IoU</th><th>HD</th><th>HD95</th><th title="Count of samples where one annotator labelled the class but the other did not (presence disagreement). Included in Dice/IoU (compared to an empty mask, so those drop); excluded from HD/HD95.">1-sided</th></tr></thead><tbody>${rows}</tbody>`;
}
function fmtn(v){ return v==null?'—':(''+v); }
function downloadReview(fmt){
  if(!R.data){ return; }
  let blob,name;
  if(fmt==='json'){ blob=new Blob([JSON.stringify(R.data,null,2)],{type:'application/json'}); name=`agreement_${R.data.case}.json`; }
  else {
    const head='frame,class_id,class_name,ann_a,ann_b,kind,one_sided,dice,iou,hd,hd95';
    const lines=R.data.rows.map(r=>[r.frame,r.class_id,`"${r.class_name}"`,r.ann_a,r.ann_b,r.kind,
      r.one_sided,r.dice,r.iou,r.hd,r.hd95].join(','));
    blob=new Blob([head+'\n'+lines.join('\n')],{type:'text/csv'}); name=`agreement_${R.data.case}.csv`;
  }
  const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url);
}

// ---------- Compare: visual diff / dual-screen ----------
const C = {open:false, root:null, case:null, a:null, b:null, frames:[], idx:0,
           mode:'overlay', framesDir:'', showFrame:true, w:0, h:0, data:null, img:null,
           displayOrder:['a','b'],
           bins:{}, visible:{a:new Set(),b:new Set()}, knownClasses:new Set(), solo:null, classSort:{key:'dice',dir:-1},
           view:{scale:1,panX:0,panY:0},
           dualViews:{a:{scale:1,panX:0,panY:0,initialized:false},b:{scale:1,panX:0,panY:0,initialized:false}},
           viewSize:null, panning:false, panStart:null,
           layer:null, layerA:null, layerB:null, scores:[], scoreHover:null, scoreThreshold:.9, scoreRefreshBusy:false,
           panelState:null, pendingNav:null,
           refine:{side:null, selectedClassId:null, readyDir:null, sourceNames:[], busy:false,
                   prompts:new Map(), promptSeeds:new Map(), drafts:new Map(),
                   io:{a:{importDir:null,saveDir:null},b:{importDir:null,saveDir:null}},
                   brush:false, brushSize:20, brushing:false, brushPositive:true, brushLast:null, brushBefore:null,
                   brushCursor:null, brushRenderPending:false, brushTrail:null, brushBaseLayers:null, pendingPoints:[], flash:null,
                   activeSamObjId:null, metricTimers:new Map(), metricVersions:new Map(),
                   editors:{a:{classId:null,history:new Map(),future:new Map()},
                            b:{classId:null,history:new Map(),future:new Map()}}}};
const cmpCanvas=$('cmpCanvas'); const cctx=cmpCanvas.getContext('2d');
const CMP_AGREE=[55,229,160], CMP_AONLY=[80,180,255], CMP_BONLY=[255,90,170];
try{
  const savedThreshold=Number(localStorage.getItem('issas.review.diceThreshold'));
  if(Number.isFinite(savedThreshold)&&savedThreshold>=0&&savedThreshold<=1) C.scoreThreshold=savedThreshold;
}catch(_){}
function cmpBaseClassId(cid){
  const item=C.bins?.[cid];
  return Number(item?.baseClassId??item?.meta?.base_class_id??cid);
}
function classColorRGB(cid){ return annotationColorForClass(cmpBaseClassId(cid)); }
function syncCmpCursor(){
  cmpCanvas.style.cursor=C.refine.side?(C.refine.brush?'none':'crosshair'):'crosshair';
}

$('reviewCompareBtn').addEventListener('click', openCompare);
$('cmpRefineA').addEventListener('click',()=>startCmpRefine('a'));
$('cmpRefineB').addEventListener('click',()=>startCmpRefine('b'));
$('cmpSwapSides').addEventListener('click',swapCmpDisplaySides);
document.querySelectorAll('.cmp-zoom-hud').forEach(bar=>{
  const side=bar.dataset.cmpView==='shared'?null:bar.dataset.cmpView;
  bar.querySelector('[data-cmp-zoom="slider"]').addEventListener('input',e=>setCmpZoom(+e.target.value/100,side));
  bar.addEventListener('click',e=>{
    const action=e.target.closest('[data-cmp-zoom]')?.dataset.cmpZoom;
    if(!action||action==='slider') return;
    const view=cmpZoomView(side);
    if(action==='out') setCmpZoom(view.scale/1.2,side);
    else if(action==='in') setCmpZoom(view.scale*1.2,side);
    else if(action==='fit') fitCmp(side);
    else if(action==='actual') setCmpZoom(1,side);
  });
});
$('cmpAddClass').addEventListener('click',()=>openAddObj('review'));
$('reviewImportBtn').addEventListener('click',()=>importCmpMasks());
$('cmpBrush').addEventListener('click',()=>{
  C.refine.brush=!C.refine.brush;
  $('cmpBrush').textContent='Brush: '+(C.refine.brush?'ON':'OFF');
  $('cmpBrush').classList.toggle('on',C.refine.brush);
  $('brushBtn').textContent='Brush: '+(C.refine.brush?'ON':'OFF'); $('brushBtn').classList.toggle('on',C.refine.brush);
  cmpCanvas.classList.toggle('cmp-brushing',C.refine.brush);
  if(!C.refine.brush) C.refine.brushCursor=null;
  syncCmpCursor();
  cmpRender();
});
$('cmpBrushSize').addEventListener('input',e=>{
  C.refine.brushSize=+e.target.value; $('brushSlider').value=C.refine.brushSize;
  $('brushLabel').textContent=C.refine.brushSize; cmpRender();
});
$('cmpApplyGaussian').addEventListener('click',()=>applyCmpPostprocess('gaussian'));
$('cmpApplyMorph').addEventListener('click',()=>applyCmpPostprocess('morph'));
$('cmpApplyComponents').addEventListener('click',()=>applyCmpPostprocess('components'));
$('cmpRefineUndo').addEventListener('click', undoCmpRefine);
$('cmpRefineRedo').addEventListener('click', redoCmpRefine);
$('cmpRefineReset').addEventListener('click', resetCmpRefine);
$('cmpRefineSave').addEventListener('click', saveCmpRefine);
$('cmpClose').addEventListener('click',closeCompareWorkspace);
$('cmpFramesBrowse').addEventListener('click',()=>openBrowser({title:'Choose frames folder for this case', start:C.framesDir||S.defaultPath, onSelect:async p=>{ if(p&&await guardCmpUnsaved()){ C.framesDir=p; C.refine.readyDir=null; $('cmpFramesDir').value=p; loadCmpFrame(C.idx); } }}));
$('cmpFramesDir').addEventListener('change',async e=>{ if(!await guardCmpUnsaved()){ e.target.value=C.framesDir; return; } C.framesDir=e.target.value.trim(); C.refine.readyDir=null; loadCmpFrame(C.idx); });
$('cmpShowFrame').addEventListener('change',e=>{ C.showFrame=e.target.checked;
  if(C.showFrame && !C.framesDir) toast('Set a frames folder to show the background');
  cmpRender(); });
$('cmpPrev').addEventListener('click',()=>requestCmpFrame(C.idx-1));
$('cmpNext').addEventListener('click',()=>requestCmpFrame(C.idx+1));
$('cmpSlider').addEventListener('change',e=>requestCmpFrame(+e.target.value));
$('cmpSlider').addEventListener('contextmenu',e=>{
  e.preventDefault();
  const rect=e.target.getBoundingClientRect();
  const ratio=Math.max(0,Math.min(1,(e.clientX-rect.left)/Math.max(1,rect.width)));
  const index=Math.round(ratio*Math.max(0,C.frames.length-1));
  openCompareVideo(index,true);
});
$('cmpScoreThreshold').value=C.scoreThreshold.toFixed(2);
$('cmpScoreThreshold').addEventListener('input',e=>{
  const threshold=Number(e.target.value);
  if(!Number.isFinite(threshold)||threshold<0||threshold>1) return;
  C.scoreThreshold=threshold;
  try{ localStorage.setItem('issas.review.diceThreshold',String(threshold)); }catch(_){}
  drawScores();
});
$('cmpScoreThreshold').addEventListener('change',e=>{
  const threshold=Math.max(0,Math.min(1,Number(e.target.value)||0));
  C.scoreThreshold=threshold; e.target.value=threshold.toFixed(2); drawScores();
});
$('cmpScoreRefresh').addEventListener('click',refreshCmpScoresFromDisk);
$('cmpA').addEventListener('change',async()=>{ const next=$('cmpA').value, side=C.refine.side||'a'; $('cmpA').value=C.a; if(!await guardCmpUnsaved()) return; stopCmpRefine(); C.a=next; C.refine.readyDir=null; $('cmpA').value=next; syncCmpSideControls(); loadCmpIoPaths(); await setCompareFramesDir(); await reloadCmpFrames(); await startCmpRefine(side); });
$('cmpB').addEventListener('change',async()=>{ const next=$('cmpB').value, side=C.refine.side||'a'; $('cmpB').value=C.b; if(!await guardCmpUnsaved()) return; stopCmpRefine(); C.b=next; C.refine.readyDir=null; $('cmpB').value=next; syncCmpSideControls(); loadCmpIoPaths(); await setCompareFramesDir(); await reloadCmpFrames(); await startCmpRefine(side); });
segBind('cmpMode','cm',v=>{ C.mode=v; syncCmpVideoLayout(); compareResize(); if(C.data) fitCmp(); buildCmpLayers(); cmpRender(); updateLegend(); });
$('cmpSort').addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b) return;
  const key=b.dataset.cs;
  if(C.classSort.key===key){ C.classSort.dir*=-1; }
  else { C.classSort.key=key; C.classSort.dir = (key==='class_name'||key==='hd'||key==='hd95')? 1 : -1; }
  [...$('cmpSort').children].forEach(x=>x.classList.toggle('on',x.dataset.cs===key));
  renderCmpClasses(); });
$('cmpAll').addEventListener('change',e=>{
  C.solo=null;
  const sides=C.refine.side?[C.refine.side]:['a','b'];
  for(const side of sides) C.visible[side]=e.target.checked?new Set(C.data.classes.map(c=>c.class_id)):new Set();
  buildCmpLayers(); cmpRender(); renderCmpClasses();
});

function cmpRefineAnn(side=C.refine.side){ return side==='a'?C.a:C.b; }
function cmpDisplaySide(position){ return C.displayOrder[position]; }
function cmpDisplayPosition(side){ return C.displayOrder.indexOf(side); }
function syncCmpSideControls(){
  for(const side of ['a','b']){
    const label=side.toUpperCase(), ann=cmpRefineAnn(side)||'—', button=$(`cmpRefine${label}`);
    button.textContent=`Refine ${label} · ${ann}`;
    button.title=`Refine ${label} · ${ann}`;
  }
  const swap=$('cmpSwapSides'), parent=swap.parentElement;
  const first=$(`cmpRefine${cmpDisplaySide(0).toUpperCase()}`);
  const second=$(`cmpRefine${cmpDisplaySide(1).toUpperCase()}`);
  parent.insertBefore(first,swap); parent.insertBefore(second,swap.nextSibling);
}
function swapCmpDisplaySides(){
  C.displayOrder=[C.displayOrder[1],C.displayOrder[0]];
  syncCmpSideControls(); syncCmpZoomUI(); buildCmpLayers(); renderCmpClasses(); cmpRender(); updateLegend();
}
function cmpEditor(side=C.refine.side){ return C.refine.editors[side]; }
function cmpClassId(side=C.refine.side){ return C.refine.selectedClassId??cmpEditor(side)?.classId??null; }
function selectCmpClass(cid){
  C.refine.selectedClassId=cid==null?null:+cid;
  C.refine.editors.a.classId=C.refine.selectedClassId;
  C.refine.editors.b.classId=C.refine.selectedClassId;
}
function cmpDraftKey(side=C.refine.side, frame=C.frames[C.idx]){ return `${C.root}\n${C.case}\n${cmpRefineAnn(side)}\n${frame}`; }
function cmpPromptKey(cid, side=C.refine.side, frame=C.frames[C.idx]){ return `${cmpDraftKey(side,frame)}\n${cid}`; }
function cmpPromptSeedKey(cid, side=C.refine.side, frame=C.frames[C.idx]){ return cmpPromptKey(cid,side,frame); }
function invalidateCmpPromptSeed(side,cid,frame=C.frames[C.idx]){
  C.refine.promptSeeds.delete(cmpPromptSeedKey(cid,side,frame));
  // A manual mask change makes the predictor's retained logits stale. The
  // next point will reset the decoder and seed it from the edited mask.
  C.refine.activeSamObjId=null;
}
function cmpStack(kind,side=C.refine.side,frame=C.frames[C.idx]){
  const map=cmpEditor(side)[kind], key=cmpDraftKey(side,frame);
  if(!map.has(key)) map.set(key,[]);
  return map.get(key);
}
function clearCmpStacks(side=C.refine.side,frame=C.frames[C.idx]){
  const key=cmpDraftKey(side,frame); cmpEditor(side).history.delete(key); cmpEditor(side).future.delete(key);
}
function cmpIoStorageKey(side,kind){ return `issas.review.${kind}.${C.root}|${C.case}|${cmpRefineAnn(side)}`; }
function loadCmpIoPaths(){
  for(const side of ['a','b']) for(const kind of ['importDir','saveDir']){
    const storeKind=kind==='importDir'?'import':'save';
    C.refine.io[side][kind]=LS.get(cmpIoStorageKey(side,storeKind));
  }
}
function cmpDefaultMaskDir(side){ return `${C.root.replace(/\/+$/,'')}/${cmpRefineAnn(side)}/${C.case}/masks`; }
function chooseCmpSides(action, defaults){
  defaults=defaults&&defaults.length?defaults:(C.refine.side?[C.refine.side]:['a','b']);
  return new Promise(resolve=>{
    const modal=$('uiDialog'), ok=$('uiDialogOk'), cancel=$('uiDialogCancel');
    $('uiDialogTitle').textContent=`${action} Review masks`;
    $('uiDialogBody').innerHTML=`<div style="margin-bottom:10px">Choose the screens to ${action.toLowerCase()}.</div>
      <label class="switch"><span>A · ${C.a}</span><input id="cmpIoA" type="checkbox" ${defaults.includes('a')?'checked':''}><i></i></label>
      <label class="switch"><span>B · ${C.b}</span><input id="cmpIoB" type="checkbox" ${defaults.includes('b')?'checked':''}><i></i></label>
      <label class="switch"><span>Choose/change folders</span><input id="cmpIoChange" type="checkbox"><i></i></label>`;
    $('uiDialogOption').classList.add('hidden'); ok.textContent='Continue'; ok.className='btn btn-accent'; ok.style.cssText='';
    modal.classList.remove('hidden');
    const done=value=>{ modal.classList.add('hidden'); ok.onclick=cancel.onclick=modal.onclick=null; resolve(value); };
    ok.onclick=()=>{ const sides=[]; if($('cmpIoA').checked)sides.push('a'); if($('cmpIoB').checked)sides.push('b'); if(!sides.length){ toast('Choose A, B, or both','err'); return; } sides.forcePaths=$('cmpIoChange').checked; done(sides); };
    cancel.onclick=()=>done(null); modal.onclick=e=>{ if(e.target.id==='uiDialog') done(null); };
  });
}
function browseCmpDir(side,kind){
  const io=C.refine.io[side], key=kind==='import'?'importDir':'saveDir';
  return new Promise(resolve=>openBrowser({title:`Choose ${kind} masks folder for ${side.toUpperCase()} · ${cmpRefineAnn(side)}`,
    start:io[key]||cmpDefaultMaskDir(side), onSelect:dir=>{
      if(dir){ io[key]=dir; LS.set(cmpIoStorageKey(side,kind),dir); }
      resolve(dir||null);
    }}));
}
function cmpDirtySides(frame=C.frames[C.idx]){
  return ['a','b'].filter(side=>C.refine.drafts.has(cmpDraftKey(side,frame)));
}
function promptCmpUnsaved(sides){
  return new Promise(resolve=>{
    const names=sides.map(side=>`${side.toUpperCase()} · ${cmpRefineAnn(side)}`).join(', ');
    $('reviewUnsavedBody').textContent=`Unsaved masks were found for ${names} on ${C.frames[C.idx]}.`;
    $('reviewUnsaved').classList.remove('hidden');
    const done=value=>{ $('reviewUnsaved').classList.add('hidden'); $('reviewUnsavedCancel').onclick=$('reviewUnsavedLeave').onclick=$('reviewUnsavedSave').onclick=null; resolve(value); };
    $('reviewUnsavedCancel').onclick=()=>done('cancel'); $('reviewUnsavedLeave').onclick=()=>done('leave'); $('reviewUnsavedSave').onclick=()=>done('save');
  });
}
function discardCmpDrafts(frame,sides){
  for(const side of sides){
    C.refine.drafts.delete(cmpDraftKey(side,frame)); clearCmpStacks(side,frame);
    const prefix=cmpDraftKey(side,frame)+'\n';
    for(const key of [...C.refine.prompts.keys()]) if(key.startsWith(prefix)) C.refine.prompts.delete(key);
    for(const key of [...C.refine.promptSeeds.keys()]) if(key.startsWith(prefix)) C.refine.promptSeeds.delete(key);
  }
}
async function guardCmpUnsaved(){
  const sides=cmpDirtySides(); if(!sides.length) return true;
  const choice=await promptCmpUnsaved(sides); if(choice==='cancel') return false;
  if(choice==='save') return await saveCmpRefine(sides,{choose:false});
  discardCmpDrafts(C.frames[C.idx],sides); return true;
}
async function requestCmpFrame(index){
  index=clampi(index,0,C.frames.length-1); if(index===C.idx) return;
  if(!await guardCmpUnsaved()){ $('cmpSlider').value=C.idx; $('frameSlider').value=C.idx; return; }
  await loadCmpFrame(index);
}
function enterCompareWorkspace(){
  const modal=$('compareModal'), card=modal.querySelector('.compare-card')||document.querySelector('.compare-card');
  $('reviewModal').classList.add('hidden');
  card.style.transform='';
  document.querySelector('.stage').appendChild(card);
  modal.classList.add('hidden');
  C.panelState={left:document.body.classList.contains('no-left'),right:document.body.classList.contains('no-right'),bottom:document.body.classList.contains('no-bottom')};
  document.body.classList.remove('no-left','no-right','no-bottom');
  document.body.classList.add('review-compare');
  const sideHead=document.querySelector('.cmp-side-h'); document.querySelector('.panel-left').insertBefore(sideHead,$('objList'));
  $('addObjBtn').textContent='+ Add class';
  $('addObjBtn').disabled=true;
  $('leftPanelTitle').textContent='Classes';
  $('reviewBtn').classList.add('btn-accent');
  $('modeBadge').textContent='review compare'; $('modeBadge').className='badge badge-live';
}
async function closeCompareWorkspace(){
  if(!C.open) return;
  if(!await guardCmpUnsaved()) return;
  if(V.compare || $('videoWindow').parentElement===$('cmpVideoPane')){
    closeContextVideo();
    document.querySelector('.stage').appendChild($('videoWindow'));
  }
  stopCmpRefine();
  const modal=$('compareModal'), card=document.querySelector('.compare-card'), sideHead=document.querySelector('.cmp-side-h');
  document.querySelector('.cmp-side').prepend(sideHead);
  modal.appendChild(card); modal.classList.add('hidden');
  document.body.classList.remove('review-compare');
  if(C.panelState?.left) document.body.classList.add('no-left');
  if(C.panelState?.right) document.body.classList.add('no-right');
  if(C.panelState?.bottom) document.body.classList.add('no-bottom');
  C.panelState=null;
  $('addObjBtn').textContent='+ Add object'; $('addObjBtn').disabled=false;
  $('leftPanelTitle').textContent='Objects';
  $('reviewBtn').classList.remove('btn-accent');
  C.open=false; rebuildObjList(); render();
  $('frameSlider').max=Math.max(0,S.count-1); $('frameSlider').value=S.idx; $('position').textContent=`${S.count?S.idx+1:0} / ${S.count}`;
  $('modeBadge').textContent=S.count?'annotation':'no session';
  $('modeBadge').className='badge '+(S.count?'badge-live':'badge-muted');
}
function cmpFrameSourceIndex(){
  const base=(C.frames[C.idx]||'').replace(/\.[^.]+$/,'');
  return C.refine.sourceNames.findIndex(name=>name.replace(/\.[^.]+$/,'')===base);
}
function updateCmpRefineUI(){
  const active=!!C.refine.side, ann=active?cmpRefineAnn():'';
  $('cmpRefineBar').classList.toggle('hidden',!C.open);
  $('cmpRefineA').classList.toggle('on',C.refine.side==='a');
  $('cmpRefineB').classList.toggle('on',C.refine.side==='b');
  syncCmpZoomUI();
  cmpCanvas.classList.toggle('refining',active);
  syncCmpCursor();
  if(C.open) $('addObjBtn').disabled=!active||C.refine.busy;
  if(!active) return;
  const cl=C.data&&C.data.classes.find(x=>x.class_id===cmpClassId());
  $('cmpRefineStatus').textContent=`${ann} · ${cl?cl.class_name:'Select a class'} · ${C.frames[C.idx]||''} · ${C.refine.busy?'SAM2 updating mask…':'SAM2 shared'}`;
  const dirty=C.refine.drafts.has(cmpDraftKey());
  $('cmpRefineDirty').classList.toggle('hidden',!dirty);
  $('cmpRefineSave').disabled=!dirty||C.refine.busy;
  $('cmpRefineUndo').disabled=!cmpStack('history').length||C.refine.busy;
  $('cmpRefineRedo').disabled=!cmpStack('future').length||C.refine.busy;
  $('cmpAddClass').disabled=C.refine.busy;
  $('cmpRefineReset').disabled=C.refine.busy;
}
async function startCmpRefine(side){
  if(!C.framesDir) C.framesDir=$('cmpFramesDir').value.trim();
  if(!C.framesDir){ toast('Set the frames folder before refining','err'); return; }
  if(!C.data){ toast('Load a comparison frame before refining','err'); return; }
  // Selecting A/B is a UI action and must remain available while SAM2 is
  // finishing a request for the other side. The in-flight result retains its
  // explicit side/class identifiers and can safely finish in the background.
  C.refine.side=side;
  const editor=cmpEditor(side);
  const selected=C.data.classes.some(x=>x.class_id===C.refine.selectedClassId)
    ? C.refine.selectedClassId : (C.data.classes[0]?.class_id??null);
  selectCmpClass(selected); editor.classId=selected;
  if(editor.classId!=null) C.visible[side].add(editor.classId);
  updateCmpRefineUI(); renderCmpClasses(); cmpRender();
  if(C.refine.readyDir===C.framesDir) return;
  // Initialization is shared by A and B. If it is already running, the side
  // above is still switched immediately and that initialization may finish.
  if(C.refine.busy) return;
  C.refine.busy=true; updateCmpRefineUI(); showOverlay('Preparing SAM2 for Review refine…');
  const opened=await API.post('/api/open_folder',{path:C.framesDir});
  if(!opened.ok){ C.refine.busy=false; stopCmpRefine(); hideOverlay(); toast(opened.j.detail||'Could not open frames','err'); return; }
  try{ applyVideoStatus(await API.get('/api/video/status')); }catch(_){ /* video is optional */ }
  const initialized=await API.post('/api/init',{}); hideOverlay();
  C.refine.busy=false;
  if(!initialized.ok){ stopCmpRefine(); toast(initialized.j.detail||'SAM2 initialization failed','err'); return; }
  C.refine.activeSamObjId=null;
  C.refine.readyDir=C.framesDir; C.refine.sourceNames=opened.j.names||[];
  updateCmpRefineUI();
  toast(`Refining ${cmpRefineAnn()} in Review · shared SAM2 model`,'ok');
  // A click made while the shared predictor was initializing is queued by the
  // canvas handler; start it as soon as initialization releases the busy flag.
  runNextCmpRefinePoint();
}
function stopCmpRefine(){
  C.refine.side=null; C.refine.busy=false; C.refine.brush=false; C.refine.brushing=false;
  C.refine.brushCursor=null; C.refine.brushTrail=null; C.refine.brushBaseLayers=null; C.refine.pendingPoints=[]; C.refine.activeSamObjId=null;
  for(const timer of C.refine.metricTimers.values()) clearTimeout(timer);
  C.refine.metricTimers.clear();
  $('cmpBrush').textContent='Brush: OFF'; $('cmpBrush').classList.remove('on'); cmpCanvas.classList.remove('cmp-brushing');
  $('brushBtn').textContent='Brush: OFF'; $('brushBtn').classList.remove('on');
  updateCmpRefineUI(); if(C.data){ renderCmpClasses(); cmpRender(); }
}
function binToPngB64WH(bin,w,h){
  const c=document.createElement('canvas'); c.width=w; c.height=h; const cx=c.getContext('2d');
  const im=cx.createImageData(w,h); for(let i=0,p=0;i<bin.length;i++,p+=4){ const v=bin[i]?255:0; im.data[p]=im.data[p+1]=im.data[p+2]=v; im.data[p+3]=255; }
  cx.putImageData(im,0,0); return c.toDataURL('image/png').split(',')[1];
}
function cmpSideBins(side=C.refine.side){
  const key=side==='a'?'a':'b';
  return Object.entries(C.bins).map(([cid,value])=>({class_id:cmpBaseClassId(cid),bin:value[key]}));
}
async function importCmpMasks(sides=null){
  sides=sides||await chooseCmpSides('Import'); if(!sides) return false;
  C.refine.busy=true; updateCmpRefineUI();
  for(const side of sides){
    let dir=sides.forcePaths?null:C.refine.io[side].importDir;
    if(!dir) dir=await browseCmpDir(side,'import');
    if(!dir){ C.refine.busy=false; updateCmpRefineUI(); return false; }
    const response=await API.post('/api/review/import_refine',{root:C.root,case:C.case,annotator:cmpRefineAnn(side),frame:C.frames[C.idx],mask_dir:dir});
    if(!response.ok){ C.refine.busy=false; updateCmpRefineUI(); toast(`${side.toUpperCase()} import failed: ${response.j.detail||'unknown error'}`,'err'); return false; }
    if(response.j.width!==C.w||response.j.height!==C.h){ C.refine.busy=false; updateCmpRefineUI(); toast(`${side.toUpperCase()} mask dimensions do not match`,'err'); return false; }
    const imported=new Map();
    for(const obj of response.j.objects) imported.set(+obj.class_id,await pngB64ToBinWH(obj.mask,C.w,C.h));
    const ids=new Set([...Object.keys(C.bins).map(Number),...imported.keys()]);
    for(const cid of ids){
      const item=ensureCmpClass(cid,imported.has(cid)?response.j.objects.find(x=>+x.class_id===cid)?.name:classNameForId(cid));
      const before=item[side].slice(0), after=imported.get(cid)||new Uint8Array(C.w*C.h);
      if(before.some((value,index)=>value!==after[index])){ item[side]=after.slice(0); cmpMaskHistory(side,cid,before,after); }
    }
    for(const cid of ids) await refreshCmpLiveMetrics(cid);
  }
  C.refine.busy=false; buildCmpLayers(); renderCmpClasses(); cmpRender(); drawScores(); updateCmpRefineUI();
  toast(`Imported ${sides.map(x=>x.toUpperCase()).join(' + ')} masks`,'ok'); return true;
}
function cmpMaskHistory(side,cid,before,after,historySide=side){
  const draftKey=cmpDraftKey(side), draft=C.refine.drafts.get(draftKey);
  let hadDraft=!!draft&&draft.has(cid), beforeDraft=hadDraft?draft.get(cid).slice(0):null;
  let target=C.refine.drafts.get(draftKey); if(!target){ target=new Map(); C.refine.drafts.set(draftKey,target); }
  target.set(cid,after.slice(0));
  invalidateCmpPromptSeed(side,cid);
  cmpStack('history',historySide).push({side,historySide,frame:C.frames[C.idx],cid,before:before.slice(0),after:after.slice(0),beforePoints:null,afterPoints:null,hadDraft,beforeDraft});
  cmpStack('future',historySide).length=0;
}
async function applyCmpPostprocess(op){
  const side=C.refine.side, cid=cmpClassId(side); if(!side||cid==null||C.refine.busy) return;
  const item=C.bins[cid]; if(!item) return;
  const before=item[side].slice(0);
  const body={op,mask:binToPngB64WH(before,C.w,C.h),kernel:op==='gaussian'?S.gauss:S.morph,n:S.comp};
  C.refine.busy=true; updateCmpRefineUI();
  const response=await API.post('/api/postprocess',body); C.refine.busy=false;
  if(!response.ok){ updateCmpRefineUI(); toast(response.j.detail||'postprocess failed','err'); return; }
  const after=await pngB64ToBinWH(response.j.mask,C.w,C.h); item[side]=after; cmpMaskHistory(side,cid,before,after);
  buildCmpLayers(); renderCmpClasses(); cmpRender(); updateCmpRefineUI();
  scheduleCmpLiveMetrics(cid); toast(op+' applied','ok');
}
function paintCmpCircle(ix,iy,add){
  paintCmpLine(ix,iy,ix,iy,add);
}
function paintCmpLine(x0,y0,x1,y1,add){
  const side=C.refine.side, cid=cmpClassId(side), item=cid==null?null:C.bins[cid]; if(!item) return;
  const bin=item[side], r=Math.max(.5,C.refine.brushSize/2), {w,h}=C, r2=r*r;
  const minX=clampi(Math.floor(Math.min(x0,x1)-r),0,w-1), maxX=clampi(Math.ceil(Math.max(x0,x1)+r),0,w-1);
  const minY=clampi(Math.floor(Math.min(y0,y1)-r),0,h-1), maxY=clampi(Math.ceil(Math.max(y0,y1)+r),0,h-1);
  const vx=x1-x0, vy=y1-y0, len2=vx*vx+vy*vy;
  for(let y=minY;y<=maxY;y++) for(let x=minX;x<=maxX;x++){
    const t=len2?clampi(((x-x0)*vx+(y-y0)*vy)/len2,0,1):0;
    const dx=x-(x0+t*vx), dy=y-(y0+t*vy);
    if(dx*dx+dy*dy<=r2) bin[y*w+x]=add?1:0;
  }
}
function scheduleCmpBrushRender(){
  if(C.refine.brushRenderPending) return;
  C.refine.brushRenderPending=true;
  requestAnimationFrame(()=>{
    C.refine.brushRenderPending=false;
    if(!C.open||!C.data) return;
    // During a stroke the native masks are updated in memory, while a cheap
    // screen-space trail supplies immediate feedback. Rebuilding every full
    // resolution class layer here was the main source of brush jank.
    cmpRender();
  });
}
function classNameForId(cid){
  const base=cmpBaseClassId(cid);
  return Object.entries(S.classMap).find(([,id])=>+id===+base)?.[0]||`class_${base}`;
}
function ensureCmpClass(cid,name=classNameForId(cid),baseClassId=cid){
  cid=+cid;
  if(C.bins[cid]) return C.bins[cid];
  baseClassId=+baseClassId;
  const siblings=C.data.classes.filter(x=>+(x.base_class_id??x.class_id)===baseClassId);
  const meta={class_id:cid,base_class_id:baseClassId,class_name:name,instance_index:siblings.length+1,
    dice:null,iou:null,hd:null,hd95:null,only_a:false,only_b:false};
  C.data.classes.push(meta);
  C.bins[cid]={a:new Uint8Array(C.w*C.h),b:new Uint8Array(C.w*C.h),baseClassId,color:classColorRGB(baseClassId),meta};
  C.knownClasses.add(cid); C.visible.a.add(cid); C.visible.b.add(cid);
  return C.bins[cid];
}
async function addCmpClass(cid,name){
  if(!C.refine.side) return;
  cid=+cid;
  let instanceId=cid;
  if(C.bins[instanceId]){
    let suffix=2; instanceId=cid*1000+suffix;
    while(C.bins[instanceId]){ suffix++; instanceId=cid*1000+suffix; }
  }
  const siblingCount=C.data.classes.filter(x=>+(x.base_class_id??x.class_id)===cid).length;
  ensureCmpClass(instanceId, siblingCount?`${name} · ${siblingCount+1}`:name, cid);
  selectCmpClass(instanceId); C.visible[C.refine.side].add(instanceId); C.solo=null;
  buildCmpLayers(); renderCmpClasses(); cmpRender(); updateCmpRefineUI();
  scheduleCmpLiveMetrics(instanceId);
}
function cycleCmpClass(dir){
  if(!C.refine.side||!C.data?.classes.length) return;
  const classes=[...C.data.classes].sort((a,b)=>a.class_name.localeCompare(b.class_name));
  let i=classes.findIndex(x=>x.class_id===cmpClassId()); i=(i+dir+classes.length)%classes.length;
  selectCmpClass(classes[i].class_id); C.visible[C.refine.side].add(classes[i].class_id); C.solo=null;
  buildCmpLayers(); renderCmpClasses(); cmpRender(); updateCmpRefineUI();
}
function toggleCmpClassVisibility(side=C.refine.side,cid=cmpClassId(side)){
  if(!side||cid==null) return;
  if(C.visible[side].has(cid)) C.visible[side].delete(cid); else C.visible[side].add(cid);
  C.solo=null; buildCmpLayers(); renderCmpClasses(); cmpRender();
}
function toggleCmpAllVisibility(side=C.refine.side){
  const sides=side?[side]:['a','b'];
  for(const s of sides){
    const all=C.data.classes.length>0&&C.data.classes.every(cl=>C.visible[s].has(cl.class_id));
    C.visible[s]=all?new Set():new Set(C.data.classes.map(cl=>cl.class_id));
  }
  C.solo=null; buildCmpLayers(); renderCmpClasses(); cmpRender();
}
async function deleteCmpClassMask(side,cid){
  if(!C.bins[cid]||C.refine.busy) return;
  const before=C.bins[cid][side].slice(0), after=new Uint8Array(C.w*C.h);
  if(!before.some(Boolean)) return;
  C.bins[cid][side]=after; cmpMaskHistory(side,cid,before,after,C.refine.side||side);
  buildCmpLayers(); renderCmpClasses(); cmpRender(); updateCmpRefineUI(); scheduleCmpLiveMetrics(cid);
}
async function deleteCmpClass(side,cid){
  if(side==='all'){ await deleteCmpClassMask('a',cid); await deleteCmpClassMask('b',cid); }
  else await deleteCmpClassMask(side,cid);
  const item=C.bins[cid];
  if(item&&!item.a.some(Boolean)&&!item.b.some(Boolean)){
    C.data.classes=C.data.classes.filter(cl=>cl.class_id!==cid);
    C.visible.a.delete(cid); C.visible.b.delete(cid); C.knownClasses.delete(cid);
    if(cmpClassId()===cid) selectCmpClass(null);
    renderCmpClasses(); buildCmpLayers(); cmpRender(); updateCmpRefineUI();
  }
}
function runNextCmpRefinePoint(){
  if(C.refine.busy) return;
  while(C.refine.pendingPoints.length&&C.refine.pendingPoints[0].frame!==C.frames[C.idx]) C.refine.pendingPoints.shift();
  const next=C.refine.pendingPoints.shift(); if(!next) return;
  const batch=[next.point];
  // Coalesce clicks made while SAM2 was busy. One decoder call with the full
  // point set gives the same final constraints without forcing the user to
  // wait for a separate inference round-trip per click.
  const keep=[];
  for(const item of C.refine.pendingPoints){
    if(item.side===next.side&&item.cid===next.cid&&item.frame===next.frame) batch.push(item.point);
    else keep.push(item);
  }
  C.refine.pendingPoints=keep;
  runCmpRefinePoint(batch,next.side,next.cid);
}
async function runCmpRefinePoint(point,requestedSide=C.refine.side,requestedCid=cmpClassId(requestedSide)){
  const side=requestedSide, cid=requestedCid;
  if(cid==null||!side) return;
  const incoming=Array.isArray(point)?point:[point];
  if(C.refine.busy){
    for(const next of incoming) C.refine.pendingPoints.push({point:{...next},side,cid,frame:C.frames[C.idx]});
    cmpRender();
    return;
  }
  const frameIdx=cmpFrameSourceIndex();
  if(frameIdx<0){
    toast(`Frame ${C.frames[C.idx]} is not in the selected images folder`,'err');
    runNextCmpRefinePoint();
    return;
  }
  // Use the side captured when the click occurred. The operator may switch
  // A/B while this request is running, so defaults based on the current UI
  // side would otherwise write prompts into the wrong annotator.
  const key=cmpPromptKey(cid,side), points=C.refine.prompts.get(key)||[];
  const seedKey=cmpPromptSeedKey(cid,side);
  const beforePoints=points.map(p=>({...p})); points.push(...incoming.map(p=>({...p}))); C.refine.prompts.set(key,points);
  const target=C.bins[cid][side], before=target.slice(0);
  const oldDraft=C.refine.drafts.get(cmpDraftKey(side));
  const hadDraft=!!oldDraft&&oldDraft.has(cid), beforeDraft=hadDraft?oldDraft.get(cid).slice(0):null;
  C.refine.busy=true; updateCmpRefineUI(); cmpRender();
  // SAM2 keeps one prompt/logit state per object. Include frame in the id so
  // switching frames cannot accidentally reuse another frame's decoder state.
  const objId=cid*1000000+(C.idx+1)*100+(side==='a'?1:2);
  const resetState=C.refine.activeSamObjId!==objId;
  let response, after;
  try{
    response=await API.post('/api/predict',{frame_idx:frameIdx,obj_id:objId,
      // Match Annotation mode: resend the complete prompt set on every click.
      // SAM2 clears the old point tensor and rebuilds it while retaining the
      // previous mask logits, so positive/negative constraints stay consistent.
      points:points.map(p=>[p.x,p.y]),labels:points.map(p=>p.label),box:null,
      seed_mask:resetState&&before.some(Boolean)?binToPngB64WH(before,C.w,C.h):null,
      reset_state:resetState});
    if(!response.ok) throw new Error(response.j.detail||'SAM2 refine failed');
    after=await pngB64ToBinWH(response.j.mask,C.w,C.h);
  }catch(err){
    C.refine.busy=false; C.refine.activeSamObjId=null; C.refine.prompts.set(key,beforePoints);
    updateCmpRefineUI(); cmpRender(); toast(err?.message||'SAM2 refine failed','err'); runNextCmpRefinePoint(); return;
  }
  const afterPoints=points.map(p=>({...p}));
  C.refine.activeSamObjId=objId;
  if(resetState&&before.some(Boolean)) C.refine.promptSeeds.set(seedKey,true);
  C.bins[cid][side]=after;
  let draft=C.refine.drafts.get(cmpDraftKey(side));
  if(!draft){ draft=new Map(); C.refine.drafts.set(cmpDraftKey(side),draft); }
  draft.set(cid,after.slice(0));
  cmpStack('history',side).push({side,frame:C.frames[C.idx],cid,before,after:after.slice(0),beforePoints,afterPoints,hadDraft,beforeDraft});
  cmpStack('future',side).length=0;
  C.refine.busy=false;
  // Show the SAM2 mask before distance metrics (especially HD/HD95) run.
  buildCmpLayers(); renderCmpClasses(); cmpRender(); updateCmpRefineUI();
  scheduleCmpLiveMetrics(cid);
  runNextCmpRefinePoint();
}
function scheduleCmpLiveMetrics(cid,delay=220){
  const base=cmpBaseClassId(cid), frame=C.frames[C.idx];
  const key=`${C.root}\n${C.case}\n${frame}\n${base}`;
  const version=(C.refine.metricVersions.get(key)||0)+1;
  C.refine.metricVersions.set(key,version);
  clearTimeout(C.refine.metricTimers.get(key));
  const run=async()=>{
    if(C.frames[C.idx]!==frame||C.refine.metricVersions.get(key)!==version){
      C.refine.metricTimers.delete(key); return;
    }
    // Metrics include PNG encoding and Hausdorff distance. Keep that work out
    // of the critical path while point prompts are still arriving.
    if(C.refine.busy||C.refine.pendingPoints.length){
      C.refine.metricTimers.set(key,setTimeout(run,delay)); return;
    }
    C.refine.metricTimers.delete(key);
    const applied=await refreshCmpLiveMetrics(cid,{key,version,frame});
    if(applied){ renderCmpClasses(); drawScores(); updateCmpRefineUI(); }
  };
  C.refine.metricTimers.set(key,setTimeout(run,delay));
}
async function refreshCmpLiveMetrics(cid,guard=null){
  const item=C.bins[cid]; if(!item) return;
  const base=cmpBaseClassId(cid);
  const siblingEntries=Object.entries(C.bins).filter(([instanceId])=>cmpBaseClassId(instanceId)===base);
  const union={a:new Uint8Array(C.w*C.h),b:new Uint8Array(C.w*C.h)};
  for(const [,sibling] of siblingEntries){
    for(let i=0;i<union.a.length;i++){ if(sibling.a[i]) union.a[i]=1; if(sibling.b[i]) union.b[i]=1; }
  }
  const response=await API.post('/api/review/live_metrics',{
    mask_a:binToPngB64WH(union.a,C.w,C.h),mask_b:binToPngB64WH(union.b,C.w,C.h)});
  if(!response.ok) return false;
  if(guard&&(C.refine.metricVersions.get(guard.key)!==guard.version||C.frames[C.idx]!==guard.frame)) return false;
  // Every button is an independent instance, but agreement belongs to the
  // semantic class. Write the union metrics back to every instance record,
  // including the records used directly by renderCmpClasses().
  for(const [,sibling] of siblingEntries) Object.assign(sibling.meta,response.j);
  for(const cl of C.data.classes){
    if(+(cl.base_class_id??cl.class_id)===base) Object.assign(cl,response.j);
  }
  const baseClasses=[...new Set(C.data.classes.map(x=>+(x.base_class_id??x.class_id)))];
  const vals=baseClasses.map(baseId=>
    C.data.classes.find(x=>+(x.base_class_id??x.class_id)===baseId)?.dice).filter(x=>x!=null);
  const score=C.scores.find(x=>x.frame===C.frames[C.idx]);
  if(score) score.dice=vals.length?Math.round(vals.reduce((a,b)=>a+b,0)/vals.length*10000)/10000:null;
  updateReviewLiveRow(base,response.j,union.a.some(Boolean)!==union.b.some(Boolean));
  return true;
}
function reviewMean(values){ values=values.filter(v=>v!=null); return values.length?Math.round(values.reduce((a,b)=>a+b,0)/values.length*10000)/10000:null; }
function reviewAggLive(rows){
  const metrics=['dice','iou','sen','hd','hd95'], groups=new Map();
  for(const row of rows){ if(!groups.has(row.class_id)) groups.set(row.class_id,[]); groups.get(row.class_id).push(row); }
  const per_class=[...groups].map(([cid,rs])=>{
    const out={class_id:cid,class_name:rs[0].class_name,n:rs.length,n_hd:rs.filter(x=>x.hd!=null).length,n_cases:1,one_sided:rs.filter(x=>x.one_sided).length};
    for(const m of metrics) out[m]=out[m+'_micro']=reviewMean(rs.map(x=>x[m])); return out;
  });
  const overall={}; for(const m of metrics) overall[m]=reviewMean(rows.map(x=>x[m]));
  return {n:rows.length,per_class,per_case:[],overall,class_avg_unweighted:Object.fromEntries(metrics.map(m=>[m,reviewMean(per_class.map(x=>x[m]))])),class_avg_weighted:overall,case_avg_unweighted:null,case_avg_weighted:overall};
}
function updateReviewLiveRow(cid,metrics,oneSided){
  if(!R.data||R.data.multi) return;
  let row=R.data.rows.find(x=>x.frame===C.frames[C.idx]&&x.class_id===cid&&
    ((x.ann_a===C.a&&x.ann_b===C.b)||(x.ann_a===C.b&&x.ann_b===C.a)));
  const classItems=Object.entries(C.bins).filter(([instanceId])=>cmpBaseClassId(instanceId)===+cid).map(([,value])=>value);
  const present=classItems.some(value=>value.a.some(Boolean)||value.b.some(Boolean));
  if(row&&row._liveAdded&&!present){ R.data.rows.splice(R.data.rows.indexOf(row),1); row=null; }
  if(!row&&present){
    const cl=C.data.classes.find(x=>x.class_id===cid);
    row={frame:C.frames[C.idx],class_id:cid,class_name:cl?.class_name||`class_${cid}`,
      ann_a:C.a,ann_b:C.b,kind:C.a===C.b?'intra':'inter',one_sided:oneSided,...metrics,_liveAdded:true};
    R.data.rows.push(row);
  }
  if(!row){ renderReview(); return; }
  Object.assign(row,metrics,{one_sided:oneSided});
  R.data.inter=reviewAggLive(R.data.rows.filter(x=>x.kind==='inter'));
  R.data.intra=reviewAggLive(R.data.rows.filter(x=>x.kind==='intra'));
  R.data.all=reviewAggLive(R.data.rows);
  renderReview();
}
async function undoCmpRefine(){
  if(!C.refine.side||C.refine.busy) return;
  const history=cmpStack('history'), h=history.pop(); if(!h) return;
  ensureCmpClass(h.cid); C.bins[h.cid][h.side]=h.before; if(h.beforePoints) C.refine.prompts.set(cmpPromptKey(h.cid,h.side,h.frame),h.beforePoints);
  invalidateCmpPromptSeed(h.side,h.cid,h.frame);
  let draft=C.refine.drafts.get(cmpDraftKey(h.side,h.frame)); if(!draft){ draft=new Map(); C.refine.drafts.set(cmpDraftKey(h.side,h.frame),draft); }
  if(h.hadDraft) draft.set(h.cid,h.beforeDraft); else draft.delete(h.cid);
  if(!draft.size) C.refine.drafts.delete(cmpDraftKey(h.side,h.frame));
  cmpStack('future',h.historySide||C.refine.side,h.frame).push(h);
  await refreshCmpLiveMetrics(h.cid); buildCmpLayers(); renderCmpClasses(); cmpRender(); drawScores(); updateCmpRefineUI();
}
async function redoCmpRefine(){
  if(!C.refine.side||C.refine.busy) return;
  const future=cmpStack('future'), h=future.pop(); if(!h) return;
  C.bins[h.cid][h.side]=h.after.slice(0); if(h.afterPoints) C.refine.prompts.set(cmpPromptKey(h.cid,h.side,h.frame),h.afterPoints.map(p=>({...p})));
  invalidateCmpPromptSeed(h.side,h.cid,h.frame);
  let draft=C.refine.drafts.get(cmpDraftKey(h.side,h.frame)); if(!draft){ draft=new Map(); C.refine.drafts.set(cmpDraftKey(h.side,h.frame),draft); }
  draft.set(h.cid,h.after.slice(0)); cmpStack('history',h.historySide||C.refine.side,h.frame).push(h);
  await refreshCmpLiveMetrics(h.cid); buildCmpLayers(); renderCmpClasses(); cmpRender(); drawScores(); updateCmpRefineUI();
}
async function resetCmpRefine(){
  if(!C.refine.side) return; const prefix=cmpDraftKey();
  C.refine.drafts.delete(prefix); for(const key of [...C.refine.prompts.keys()]) if(key.startsWith(prefix+'\n')) C.refine.prompts.delete(key);
  for(const key of [...C.refine.promptSeeds.keys()]) if(key.startsWith(prefix+'\n')) C.refine.promptSeeds.delete(key);
  clearCmpStacks(); await loadCmpFrame(C.idx); updateCmpRefineUI();
}
async function resetCmpCurrentMask(){
  const side=C.refine.side, cid=cmpClassId(side); if(!side||cid==null||C.refine.busy) return;
  await deleteCmpClassMask(side,cid);
  toast(`Reset ${side.toUpperCase()} mask for ${classNameForId(cid)}`,'ok');
}
async function saveCmpRefine(sides=null,opts={}){
  if(!C.open||C.refine.busy) return false;
  if(!sides){ sides=await chooseCmpSides('Save',cmpDirtySides()); if(!sides) return false; }
  C.refine.busy=true; updateCmpRefineUI();
  for(const side of sides){
    let dir=sides.forcePaths?null:C.refine.io[side].saveDir;
    if(!dir) dir=await browseCmpDir(side,'save');
    if(!dir){ C.refine.busy=false; updateCmpRefineUI(); return false; }
    const ann=cmpRefineAnn(side), objects=cmpSideBins(side).filter(x=>x.bin.some(Boolean)).map(x=>({class_id:x.class_id,mask:binToPngB64WH(x.bin,C.w,C.h)}));
    const response=await API.post('/api/review/save_refine',{root:C.root,case:C.case,annotator:ann,frame:C.frames[C.idx],objects,mask_dir:dir});
    if(!response.ok){ C.refine.busy=false; updateCmpRefineUI(); toast(`${side.toUpperCase()} save failed: ${response.j.detail||'unknown error'}`,'err'); return false; }
    if(!response.j.yolo_ok){ C.refine.busy=false; updateCmpRefineUI(); toast(`${side.toUpperCase()} mask saved, but label failed: ${response.j.yolo_err||'unknown error'}`,'err'); return false; }
    C.refine.drafts.delete(cmpDraftKey(side)); clearCmpStacks(side);
  }
  C.refine.busy=false;
  for(const row of R.data?.rows||[]) if(row.frame===C.frames[C.idx]&&row.ann_a===C.a&&row.ann_b===C.b) delete row._liveAdded;
  updateCmpRefineUI(); flashScreen(); toast(`Saved ${sides.map(side=>`${side.toUpperCase()} · ${cmpRefineAnn(side)}`).join(' + ')}: mask + label`,'ok');
  return true;
}

async function openCompare(){
  if(!R.data){ toast('Compute agreement first'); return; }
  if(V.open) closeContextVideo();
  C.root=R.data.root; C.case=R.data.case;
  selectCmpClass(null);
  // A new Review session must not inherit decoder logits or prompt seeds from
  // an earlier session, even when it uses the same frames directory.
  C.refine.readyDir=null; C.refine.prompts.clear(); C.refine.promptSeeds.clear();
  const withCase=R.scan.annotators.filter(a=>a.cases[C.case]).map(a=>a.id);
  const opts=withCase.map(id=>`<option>${id}</option>`).join('');
  $('cmpA').innerHTML=opts; $('cmpB').innerHTML=opts;
  const sel=R.data.annotators;
  C.a=sel[0]; C.b=sel[1]||withCase.find(x=>x!==sel[0])||sel[0];
  $('cmpA').value=C.a; $('cmpB').value=C.b;
  syncCmpSideControls();
  loadCmpIoPaths();
  C.open=true; enterCompareWorkspace();
  // default frames folder for this case, so the background shows without extra steps
  C.framesDir = await resolveFramesDir(C.case, [C.a,C.b]);
  $('cmpFramesDir').value = C.framesDir; C.showFrame=true; $('cmpShowFrame').checked=true;
  const stage=$('cmpStage');
  if(!stage._resizeInit){
    new ResizeObserver(()=>{
      if(C.open){ compareResize(); cmpRender(); drawScores(); }
    }).observe(stage);
    stage._resizeInit=true;
  }
  compareResize();
  await reloadCmpFrames();
  if(C.open&&C.frames.length) await startCmpRefine('a');
}
async function setCompareFramesDir(){
  C.framesDir=await resolveFramesDir(C.case,[C.a,C.b]);
  $('cmpFramesDir').value=C.framesDir;
}
function makeDraggable(card, handle){
  let dx=0,dy=0,sx,sy,drag=false;
  handle.style.cursor='move';
  handle.addEventListener('mousedown',e=>{ if(document.body.classList.contains('review-compare')||e.target.closest('button,select,input,label')) return; drag=true; sx=e.clientX-dx; sy=e.clientY-dy; e.preventDefault(); });
  window.addEventListener('mousemove',e=>{ if(!drag) return; dx=e.clientX-sx; dy=e.clientY-sy; card.style.transform=`translate(${dx}px,${dy}px)`; });
  window.addEventListener('mouseup',()=>{ drag=false; });
  card._resetDrag=()=>{ dx=0; dy=0; card.style.transform=''; };
}
async function reloadCmpFrames(){
  if(C.a===C.b){ toast('Pick two different annotators','err'); return; }
  C.visible={a:new Set(),b:new Set()}; C.knownClasses=new Set(); C.solo=null;
  const {ok,j}=await API.post('/api/review/frames',{root:C.root, case:C.case, ann_a:C.a, ann_b:C.b});
  if(!ok){ toast(j.detail||'no frames','err'); return; }
  C.frames=j.frames; C.idx=0;
  $('cmpSlider').max=Math.max(0,C.frames.length-1);
  if(!C.frames.length){ toast('No frames shared by these two','err'); $('cmpClasses').innerHTML=''; if(document.body.classList.contains('review-compare')) $('objList').innerHTML=''; cctx.clearRect(0,0,cmpCanvas.width,cmpCanvas.height); C.scores=[]; drawScores(); return; }
  const sc=await API.post('/api/review/frame_scores',{root:C.root, case:C.case, ann_a:C.a, ann_b:C.b});
  C.scores = sc.ok? sc.j.scores : [];
  await loadCmpFrame(0);
}
function currentLiveScore(){
  if(!C.data?.classes?.length) return null;
  const values=[];
  for(const baseId of [...new Set(C.data.classes.map(x=>+(x.base_class_id??x.class_id)))]){
    const cl=C.data.classes.find(x=>+(x.base_class_id??x.class_id)===baseId);
    if(cl?.dice!=null) values.push(Number(cl.dice));
  }
  return values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
}
function scoreSummary(){
  const current=C.scores?.[C.idx];
  const live=currentLiveScore();
  if(current&&live!=null) current.dice=Math.round(live*10000)/10000;
  const values=(C.scores||[]).filter(s=>s.dice!=null).map(s=>Number(s.dice)).filter(Number.isFinite);
  const updatedMean=values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
  const below=values.filter(value=>value<C.scoreThreshold).length;
  return {mean:updatedMean,below,valid:values.length};
}
async function refreshCmpScoresFromDisk(){
  if(!C.open||!C.frames.length||C.scoreRefreshBusy) return;
  C.scoreRefreshBusy=true; $('cmpScoreRefresh').disabled=true;
  const currentFrame=C.frames[C.idx];
  const liveScores=new Map((C.scores||[])
    .filter(score=>cmpDirtySides(score.frame).length&&score.dice!=null)
    .map(score=>[score.frame,score.dice]));
  const response=await API.post('/api/review/frame_scores',{root:C.root,case:C.case,ann_a:C.a,ann_b:C.b});
  if(response.ok){
    C.scores=response.j.scores||[];
    for(const score of C.scores) if(liveScores.has(score.frame)) score.dice=liveScores.get(score.frame);
    const current=C.scores.find(score=>score.frame===currentFrame), live=currentLiveScore();
    if(current&&live!=null) current.dice=Math.round(live*10000)/10000;
    drawScores(); toast('Frame scores refreshed','ok');
  }else toast(response.j?.detail||'Could not refresh frame scores','err');
  C.scoreRefreshBusy=false; $('cmpScoreRefresh').disabled=false;
}
async function loadCmpFrame(i){
  if(!C.frames.length) return;
  const previousFrame=C.frames[C.idx];
  C.idx=clampi(i,0,C.frames.length-1);
  const frame=C.frames[C.idx];
  if(frame!==previousFrame) C.refine.activeSamObjId=null;
  if(V.compare){ V.sourceFrames=C.frames; positionContextVideo(C.idx,false); }
  const {ok,j}=await API.post('/api/review/frame_compare',{root:C.root, case:C.case, ann_a:C.a, ann_b:C.b, frame});
  if(!ok){ toast(j.detail||'compare failed','err'); return; }
  C.data=j; C.w=j.width; C.h=j.height;
  // decode masks
  C.bins={};
  for(const cl of j.classes){
    if(!C.knownClasses.has(cl.class_id)){ C.visible.a.add(cl.class_id); C.visible.b.add(cl.class_id); C.knownClasses.add(cl.class_id); }
    C.bins[cl.class_id]={
      a:await pngB64ToBinWH(cl.mask_a,C.w,C.h),
      b:await pngB64ToBinWH(cl.mask_b,C.w,C.h),
      baseClassId:cl.class_id, color:classColorRGB(cl.class_id), meta:{...cl,base_class_id:cl.class_id,instance_index:1} };
  }
  for(const cl of j.classes){
    const item=C.bins[cl.class_id];
    updateReviewLiveRow(cl.class_id,{dice:cl.dice,iou:cl.iou,hd:cl.hd,hd95:cl.hd95},
      item.a.some(Boolean)!==item.b.some(Boolean));
  }
  const savedVals=j.classes.map(x=>x.dice).filter(x=>x!=null);
  const savedScore=C.scores.find(x=>x.frame===frame);
  if(savedScore) savedScore.dice=savedVals.length?Math.round(savedVals.reduce((a,b)=>a+b,0)/savedVals.length*10000)/10000:null;
  const liveClasses=new Set();
  for(const side of ['a','b']){
    const draft=C.refine.drafts.get(cmpDraftKey(side,frame));
    if(!draft) continue;
    for(const [cid,bin] of draft){ ensureCmpClass(cid); C.bins[cid][side]=bin.slice(0); liveClasses.add(cid); }
  }
  for(const cid of liveClasses) await refreshCmpLiveMetrics(cid);
  if(C.refine.selectedClassId!=null&&!C.bins[C.refine.selectedClassId])
    selectCmpClass(C.data.classes[0]?.class_id??null);
  // background image
  C.img=null;
  if(C.framesDir){
    await new Promise(res=>{ const im=new Image(); im.onload=()=>{C.img=im;res();}; im.onerror=()=>res(); im.src='/api/review/image?dir='+encodeURIComponent(C.framesDir)+'&frame='+encodeURIComponent(frame); });
  }
  $('cmpSlider').value=C.idx; $('cmpPos').textContent=`${C.idx+1} / ${C.frames.length}`; $('cmpFrameName').textContent=frame;
  fitCmp(); buildCmpLayers(); renderCmpClasses(); cmpRender(); updateLegend(); drawScores();
  updateCmpRefineUI();
}
// per-frame Dice line plot (color = spectrum), click a point to jump
const scoresCanvas=$('cmpScores'); const sctx=scoresCanvas.getContext('2d');
function diceSpectrum(d){ const hue=Math.max(0,Math.min(130,d*130)); return `hsl(${hue.toFixed(0)},72%,55%)`; }
function scoreLayout(){
  const wrap=scoresCanvas.parentElement;
  const W=wrap.clientWidth-32, H=wrap.clientHeight-6;
  const n=(C.scores||[]).length;
  const padL=46, padR=14, padT=13, padB=15;
  const availW=Math.max(10, W-padL-padR);
  const step = n<=1? 0 : Math.min(46, availW/(n-1));   // capped => denser for few frames
  const dv=(C.scores||[]).filter(s=>s.dice!=null).map(s=>s.dice);
  if(Number.isFinite(C.scoreThreshold)) dv.push(C.scoreThreshold);
  let lo=dv.length?Math.min(...dv):0, hi=dv.length?Math.max(...dv):1;
  const pad=Math.max(0.02,(hi-lo)*0.15); lo=Math.max(0,lo-pad); hi=Math.min(1,hi+pad);
  if(hi-lo<0.04){ const c=(hi+lo)/2; lo=Math.max(0,c-0.02); hi=Math.min(1,c+0.02); }
  return {W,H,n,padL,padR,padT,padB,step,lo,hi};
}
const scoreX=(i,L)=> L.padL + i*L.step;
const scoreY=(d,L)=> (L.H-L.padB) - ((d-L.lo)/Math.max(1e-6,L.hi-L.lo))*(L.H-L.padT-L.padB);
function drawScores(){
  const summary=scoreSummary();
  const dp=window.devicePixelRatio||1; const L=scoreLayout(); const W=L.W,H=L.H;
  scoresCanvas.width=W*dp; scoresCanvas.height=H*dp; sctx.setTransform(dp,0,0,dp,0,0);
  sctx.clearRect(0,0,W,H);
  $('cmpMeanDice').textContent=`mDice ${summary.mean==null?'—':summary.mean.toFixed(4)}`;
  $('cmpScoreBelow').textContent=`${summary.below} below`;
  if(!L.n) return;
  // autoscaled y grid + labels (top = hi, bottom = lo)
  sctx.font='9px ui-monospace, monospace'; sctx.textAlign='right'; sctx.textBaseline='middle';
  [[L.hi,L.padT],[L.lo,H-L.padB]].forEach(([v,yy])=>{
    sctx.strokeStyle='rgba(255,255,255,.06)'; sctx.lineWidth=1; sctx.beginPath(); sctx.moveTo(L.padL,yy); sctx.lineTo(W-L.padR,yy); sctx.stroke();
    sctx.fillStyle='#79828d'; sctx.fillText(v.toFixed(3), L.padL-6, yy);
  });
  if(C.scoreThreshold>=L.lo&&C.scoreThreshold<=L.hi){
    const ty=scoreY(C.scoreThreshold,L);
    sctx.save(); sctx.strokeStyle='rgba(255,93,93,.65)'; sctx.lineWidth=1; sctx.setLineDash([4,3]);
    sctx.beginPath(); sctx.moveTo(L.padL,ty); sctx.lineTo(W-L.padR,ty); sctx.stroke(); sctx.restore();
  }
  // line
  sctx.strokeStyle='rgba(255,255,255,.25)'; sctx.lineWidth=1.5; sctx.beginPath(); let started=false;
  C.scores.forEach((s,i)=>{ if(s.dice==null) return; const px=scoreX(i,L),py=scoreY(s.dice,L); if(!started){sctx.moveTo(px,py);started=true;} else sctx.lineTo(px,py); });
  sctx.stroke();
  // dots (color = true dice, not the scaled axis)
  C.scores.forEach((s,i)=>{ const px=scoreX(i,L),py=scoreY(s.dice==null?L.lo:s.dice,L);
    sctx.fillStyle = s.dice==null? '#555' : (s.dice<C.scoreThreshold?'#ff5d5d':diceSpectrum(s.dice));
    const r = i===C.idx?5 : (i===C.scoreHover?5:3.5);
    sctx.beginPath(); sctx.arc(px,py,r,0,Math.PI*2); sctx.fill();
    if(i===C.idx){ sctx.strokeStyle='#fff'; sctx.lineWidth=1.5; sctx.stroke(); }
  });
  // hover tooltip
  if(C.scoreHover!=null && C.scores[C.scoreHover]){
    const s=C.scores[C.scoreHover]; const px=scoreX(C.scoreHover,L), py=scoreY(s.dice==null?L.lo:s.dice,L);
    const txt=`${s.frame}  ·  Dice ${s.dice==null?'—':s.dice.toFixed(4)}`;
    sctx.font='10px ui-monospace, monospace'; sctx.textAlign='left'; sctx.textBaseline='alphabetic';
    const tw=sctx.measureText(txt).width, bw=tw+12, bh=17;
    let bx=px+8; if(bx+bw>W-4) bx=px-8-bw; const by=Math.max(2,py-bh-6);
    sctx.fillStyle='rgba(12,15,18,.95)'; sctx.strokeStyle='#232a31'; sctx.lineWidth=1;
    sctx.beginPath(); sctx.roundRect? sctx.roundRect(bx,by,bw,bh,5): sctx.rect(bx,by,bw,bh); sctx.fill(); sctx.stroke();
    sctx.fillStyle='#dbe1e8'; sctx.fillText(txt, bx+6, by+12);
  }
}
function nearestScore(e){
  const L=scoreLayout(); if(!L.n) return -1;
  const mx=e.clientX-scoresCanvas.getBoundingClientRect().left;
  let best=0,bd=1e9; for(let i=0;i<L.n;i++){ const d=Math.abs(scoreX(i,L)-mx); if(d<bd){bd=d;best=i;} }
  return best;
}
scoresCanvas.addEventListener('click',async e=>{ const i=nearestScore(e); if(i>=0) await requestCmpFrame(i); });
scoresCanvas.addEventListener('contextmenu',e=>{ e.preventDefault(); const i=nearestScore(e); if(i>=0) openCompareVideo(i,true); });
scoresCanvas.addEventListener('mousemove',e=>{ const i=nearestScore(e); if(i!==C.scoreHover){ C.scoreHover=i; drawScores(); } });
scoresCanvas.addEventListener('mouseleave',()=>{ if(C.scoreHover!=null){ C.scoreHover=null; drawScores(); } });

// image serving via GET with query — add a tiny fetch-based loader since web_fetch not used here
function pngB64ToBinWH(b64,w,h){
  return new Promise((res,rej)=>{ const im=new Image(); im.onload=()=>{ try{ const c=document.createElement('canvas'); c.width=w;c.height=h; const cx=c.getContext('2d'); cx.drawImage(im,0,0,w,h); const d=cx.getImageData(0,0,w,h).data; const bin=new Uint8Array(w*h); for(let i=0,p=0;i<bin.length;i++,p+=4) bin[i]=d[p]>127?1:0; res(bin); }catch(err){ rej(err); } }; im.onerror=()=>rej(new Error('Invalid mask image returned by server')); im.src='data:image/png;base64,'+b64; });
}
function visClasses(side,exclude=null){
  return Object.keys(C.bins).map(Number).filter(cid=>
    (C.solo!=null?cid===C.solo:C.visible[side].has(cid)) && !(exclude?.side===side&&exclude.cid===cid));
}

function mkLayer(paint){ const c=document.createElement('canvas'); c.width=C.w; c.height=C.h; const cx=c.getContext('2d'); const im=cx.createImageData(C.w,C.h); paint(im.data); cx.putImageData(im,0,0); return c; }
function paintFill(d,bin,color,alpha){ for(let i=0,p=0;i<bin.length;i++,p+=4){ if(bin[i]){ d[p]=color[0]; d[p+1]=color[1]; d[p+2]=color[2]; d[p+3]=alpha; } } }
function paintBoundary(d,bin,color){ const w=C.w,h=C.h; for(let y=0;y<h;y++)for(let x=0;x<w;x++){ const i=y*w+x; if(!bin[i])continue; if(x===0||y===0||x===w-1||y===h-1||!bin[i-1]||!bin[i+1]||!bin[i-w]||!bin[i+w]){ const p=i*4; d[p]=color[0];d[p+1]=color[1];d[p+2]=color[2];d[p+3]=240; } } }
function paintAnnotationMask(d,bin,color,fillAlpha=115){ paintFill(d,bin,color,fillAlpha); paintBoundary(d,bin,color); }
function makeCmpLayers(exclude=null){
  if(!C.data) return {layer:null,layerA:null,layerB:null};
  const visA=visClasses('a',exclude), visB=visClasses('b',exclude), setA=new Set(visA), setB=new Set(visB);
  if(C.mode==='diff'){
    const first=cmpDisplaySide(0), firstOnly=CMP_AONLY, secondOnly=CMP_BONLY;
    const layer=mkLayer(d=>{ for(const cid of new Set([...visA,...visB])){ const {a,b}=C.bins[cid]; for(let i=0,p=0;i<a.length;i++,p+=4){ const A=setA.has(cid)&&a[i],B=setB.has(cid)&&b[i], firstHit=first==='a'?A:B, secondHit=first==='a'?B:A; if(A&&B){ d[p]=CMP_AGREE[0];d[p+1]=CMP_AGREE[1];d[p+2]=CMP_AGREE[2];d[p+3]=150; } else if(firstHit){ d[p]=firstOnly[0];d[p+1]=firstOnly[1];d[p+2]=firstOnly[2];d[p+3]=170; } else if(secondHit){ d[p]=secondOnly[0];d[p+1]=secondOnly[1];d[p+2]=secondOnly[2];d[p+3]=170; } } } });
    return {layer,layerA:null,layerB:null};
  } else if(C.mode==='overlay'){
    const front=cmpDisplaySide(0), back=cmpDisplaySide(1);
    const layer=mkLayer(d=>{
      for(const cid of visClasses(front,exclude)){ const bin=C.bins[cid][front]; paintAnnotationMask(d,bin,C.bins[cid].color,115); }
      for(const cid of visClasses(back,exclude)){ const bin=C.bins[cid][back]; paintBoundary(d,bin,C.bins[cid].color); }
    });
    return {layer,layerA:null,layerB:null};
  } else { // dual
    const layerA=mkLayer(d=>{ for(const cid of visA){ const {a,color}=C.bins[cid]; paintAnnotationMask(d,a,color,115); } });
    const layerB=mkLayer(d=>{ for(const cid of visB){ const {b,color}=C.bins[cid]; paintAnnotationMask(d,b,color,115); } });
    return {layer:null,layerA,layerB};
  }
}
function buildCmpLayers(){ Object.assign(C,makeCmpLayers()); }
function updateLegend(){
  const L=$('cmpLegend');
  if(C.mode==='diff'){ L.innerHTML=`<span class="lg"><span class="sw" style="background:rgb(${CMP_AGREE})"></span>agree</span><span class="lg"><span class="sw" style="background:rgb(${CMP_AONLY})"></span>${cmpRefineAnn(cmpDisplaySide(0))} only</span><span class="lg"><span class="sw" style="background:rgb(${CMP_BONLY})"></span>${cmpRefineAnn(cmpDisplaySide(1))} only</span>`; }
  else if(C.mode==='overlay'){ L.innerHTML=`<span class="lg">fill = <b>${cmpRefineAnn(cmpDisplaySide(0))}</b> · outline = <b>${cmpRefineAnn(cmpDisplaySide(1))}</b> · Annotation class colors</span>`; }
  else { L.innerHTML=`<span class="lg">left = <b>${cmpRefineAnn(cmpDisplaySide(0))}</b> · right = <b>${cmpRefineAnn(cmpDisplaySide(1))}</b></span>`; }
}
function compareResize(){
  const st=$('cmpStage'), vw=st.clientWidth, vh=st.clientHeight, dp=window.devicePixelRatio||1;
  const old=C.viewSize;
  if(old&&C.data){
    if(C.mode==='dual'){
      const oldPw=old[0]/2, newPw=vw/2;
      for(const side of ['a','b']){
        const view=C.dualViews[side]; if(!view.initialized) continue;
        const ix=(oldPw/2-view.panX)/view.scale, iy=(old[1]/2-view.panY)/view.scale;
        view.panX=newPw/2-ix*view.scale; view.panY=vh/2-iy*view.scale;
      }
    }else{
      const ix=(old[0]/2-C.view.panX)/C.view.scale, iy=(old[1]/2-C.view.panY)/C.view.scale;
      C.view.panX=vw/2-ix*C.view.scale; C.view.panY=vh/2-iy*C.view.scale;
    }
  }
  C.viewSize=[vw,vh];
  cmpCanvas.width=vw*dp; cmpCanvas.height=vh*dp;
  cctx.setTransform(dp,0,0,dp,0,0);
  syncCmpZoomUI();
}
function cmpZoomView(side=null){ return side?C.dualViews[side]:C.view; }
function setCmpZoom(newScale,side=null,cx=null,cy=null){
  if(!C.data||!C.w||!C.h) return;
  const st=$('cmpStage'), view=cmpZoomView(side);
  let vw=st.clientWidth, vh=st.clientHeight;
  if(side) vw/=2;
  if(cx==null){ cx=vw/2; cy=vh/2; }
  newScale=clampi(newScale,.1,8);
  const ix=(cx-view.panX)/view.scale, iy=(cy-view.panY)/view.scale;
  view.scale=newScale; view.panX=cx-ix*newScale; view.panY=cy-iy*newScale;
  if(side) view.initialized=true;
  syncCmpZoomUI(); cmpRender();
}
function fitCmp(side=null){
  if(!C.w||!C.h) return;
  const st=$('cmpStage'), vh=st.clientHeight;
  if(C.mode==='dual'){
    const pw=st.clientWidth/2, targets=side?[side]:['a','b'];
    for(const target of targets){
      const s=Math.min((pw-14)/C.w,(vh-24)/C.h), view=C.dualViews[target];
      view.scale=s; view.panX=(pw-C.w*s)/2; view.panY=(vh-C.h*s)/2; view.initialized=true;
    }
  }else{
    const vw=st.clientWidth, s=Math.min((vw-20)/C.w,(vh-20)/C.h);
    C.view={scale:s,panX:(vw-C.w*s)/2,panY:(vh-C.h*s)/2};
  }
  syncCmpZoomUI(); cmpRender();
}
function syncCmpZoomBar(bar,view){
  const pct=Math.round(view.scale*100);
  bar.querySelector('[data-cmp-zoom="slider"]').value=clampi(pct,10,800);
  bar.querySelector('[data-cmp-zoom="label"]').textContent=pct+'%';
}
function syncCmpZoomUI(){
  const dual=C.mode==='dual', shared=$('cmpZoomShared');
  shared.classList.toggle('hidden',dual); syncCmpZoomBar(shared,C.view);
  for(const side of ['a','b']){
    const bar=$(`cmpZoom${side.toUpperCase()}`);
    bar.classList.toggle('hidden',!dual);
    bar.style.left=cmpDisplayPosition(side)===0?'12px':'calc(50% + 12px)';
    bar.classList.toggle('on',C.refine.side===side);
    syncCmpZoomBar(bar,C.dualViews[side]);
  }
}
function cmpRender(){
  const st=$('cmpStage'); const vw=st.clientWidth, vh=st.clientHeight;
  // Mode switches can change the stage dimensions (especially embedded Review).
  // Clear in device pixels so no previous Overlay frame can remain below Dual.
  cctx.save(); cctx.setTransform(1,0,0,1,0,0); cctx.clearRect(0,0,cmpCanvas.width,cmpCanvas.height); cctx.restore();
  if(!C.data) return;
  if(C.mode==='dual'){
    const hw=vw/2;
    const left=cmpDisplaySide(0), right=cmpDisplaySide(1);
    drawPanel(0,hw,vh,left==='a'?C.layerA:C.layerB,cmpRefineAnn(left),left);
    drawPanel(hw,hw,vh,right==='a'?C.layerA:C.layerB,cmpRefineAnn(right),right);
    drawCmpErasePreview();
    cctx.strokeStyle='#232a31'; cctx.lineWidth=1; cctx.beginPath(); cctx.moveTo(hw,0); cctx.lineTo(hw,vh); cctx.stroke();
    drawCmpRefinePoints();
    drawCmpFlash();
    drawCmpBrushTrail();
    drawCmpBrushCursor();
    return;
  }
  cctx.save(); cctx.translate(C.view.panX,C.view.panY); cctx.scale(C.view.scale,C.view.scale);
  const showImg = C.showFrame && C.img;
  if(showImg){ cctx.imageSmoothingEnabled=true; cctx.drawImage(C.img,0,0,C.w,C.h); }
  cctx.imageSmoothingEnabled=false; cctx.globalAlpha = 1;
  if(C.layer) cctx.drawImage(C.layer,0,0,C.w,C.h);
  cctx.globalAlpha=1; cctx.restore();
  drawCmpErasePreview();
  drawCmpRefinePoints();
  drawCmpFlash();
  drawCmpBrushTrail();
  drawCmpBrushCursor();
}
function drawCmpFlash(){
  const f=C.refine.flash; if(!f||!C.bins[f.cid]) return;
  const t=(performance.now()-f.start)/(f.dur||500); if(t>=1) return;
  cctx.save(); cctx.globalAlpha=.25+.6*Math.sin(t*Math.PI);
  for(const side of f.sides||[C.refine.side||'a']){
    const flashLayer=mkLayer(d=>paintFill(d,C.bins[f.cid][side],[255,255,255],170));
    if(C.mode==='dual'){
      const g=cmpDualGeometry(side);
      cctx.drawImage(flashLayer,g.ox,g.oy,C.w*g.scale,C.h*g.scale);
    }else{
      cctx.save(); cctx.translate(C.view.panX,C.view.panY); cctx.scale(C.view.scale,C.view.scale);
      cctx.drawImage(flashLayer,0,0,C.w,C.h); cctx.restore();
    }
  }
  cctx.restore(); requestAnimationFrame(()=>{ if(C.refine.flash===f) cmpRender(); });
}
function drawPanel(x0,pw,vh,layer,label,side){
  const g=cmpDualGeometry(side); x0=g.x0; pw=g.pw;
  const s=g.scale, iw=C.w*s, ih=C.h*s, ox=g.ox, oy=g.oy;
  cctx.save(); cctx.beginPath(); cctx.rect(x0,0,pw,vh); cctx.clip();
  const showImg = C.showFrame && C.img;
  if(showImg){ cctx.imageSmoothingEnabled=true; cctx.drawImage(C.img,ox,oy,iw,ih); }
  cctx.imageSmoothingEnabled=false; cctx.globalAlpha = 1;
  if(layer) cctx.drawImage(layer,ox,oy,iw,ih);
  cctx.globalAlpha=1;
  const active=C.refine.side===side;
  cctx.fillStyle=active?'rgba(31,143,102,.88)':'rgba(10,12,15,.75)'; cctx.fillRect(x0+8,8,10+label.length*7,18);
  cctx.fillStyle=active?'#d8ffef':'#dbe1e8'; cctx.font='600 11px Inter, system-ui'; cctx.textAlign='left'; cctx.fillText(label,x0+13,21);
  if(active){ cctx.strokeStyle='#37e5a0'; cctx.lineWidth=3; cctx.strokeRect(x0+1.5,1.5,pw-3,vh-3); }
  cctx.restore();
}
function renderCmpClasses(){
  const embedded=document.body.classList.contains('review-compare');
  const box=embedded?$('objList'):$('cmpClasses'); box.innerHTML='';
  if(embedded) $('cmpClasses').innerHTML='';
  const checkSides=C.refine.side?[C.refine.side]:['a','b'];
  $('cmpAll').checked=C.solo==null&&C.data.classes.length>0&&checkSides.every(side=>C.data.classes.every(c=>C.visible[side].has(c.class_id)));
  const k=C.classSort.key, dir=C.classSort.dir;
  const cls=[...C.data.classes].sort((a,b)=>{
    if(k==='class_name') return dir*a.class_name.localeCompare(b.class_name);
    const av=a[k], bv=b[k];
    if(av==null) return 1; if(bv==null) return -1;
    return dir*(av-bv);
  });
  for(const cl of cls){
    const onA=C.solo!=null?C.solo===cl.class_id:C.visible.a.has(cl.class_id);
    const onB=C.solo!=null?C.solo===cl.class_id:C.visible.b.has(cl.class_id);
    const item=C.bins[cl.class_id], hasA=!!item&&item.a.some(Boolean), hasB=!!item&&item.b.some(Boolean);
    const el=document.createElement('div'); el.dataset.cid=cl.class_id; el.className='cmp-crow'+(C.solo===cl.class_id?' solo':'')+(C.refine.side&&cmpClassId()===cl.class_id?' refine-active':'');
    const only=hasA&&!hasB?'A Only':hasB&&!hasA?'B Only':'';
    const maskBar=side=>`<div class="cmp-mask-bar${(side==='a'?onA:onB)?' on':''}${(side==='a'?hasA:hasB)?'':' empty'}" data-side="${side}" title="Toggle ${side.toUpperCase()} mask" role="button" tabindex="0"><span class="cmp-mask-side">${side.toUpperCase()}</span><span class="cmp-mask-name">${side==='a'?C.a:C.b}</span><button class="cmp-mask-delete" data-del="${side}" title="Delete ${side.toUpperCase()} mask">X</button></div>`;
    el.innerHTML=`<div class="cmp-class-head"><span class="obj-dot" style="background:rgb(${classColorRGB(cl.class_id)})"></span><span class="cname">${cl.class_name}</span></div>
      <div class="cmp-metrics"><span>Dice <b>${fmtn(cl.dice)}</b></span><span>SEN <b>${fmtn(cl.sen)}</b></span><span>HD <b>${fmtn(cl.hd)}</b></span></div>
      <div class="cmp-mask-bars">
        ${maskBar(cmpDisplaySide(0))}${maskBar(cmpDisplaySide(1))}
      </div>${only?`<div class="cmp-only">${only}</div>`:''}`;
    el.querySelectorAll('.cmp-mask-bar').forEach(btn=>btn.addEventListener('click',e=>{
      e.stopPropagation(); if(e.target.closest('.cmp-mask-delete')) return;
      clearTimeout(btn._toggleTimer);
      if(e.detail===1) btn._toggleTimer=setTimeout(()=>toggleCmpClassVisibility(btn.dataset.side,cl.class_id),220);
    }));
    el.querySelectorAll('.cmp-mask-delete').forEach(btn=>btn.addEventListener('click',e=>{ e.stopPropagation(); deleteCmpClass(btn.dataset.del,cl.class_id); }));
    el.addEventListener('click',()=>{
      if(C.refine.side){
        selectCmpClass(cl.class_id); C.solo=null;
        box.querySelectorAll('.cmp-crow').forEach(row=>row.classList.toggle('refine-active',+row.dataset.cid===cl.class_id));
        updateCmpRefineUI(); cmpRender(); return;
      }
      const hide=onA||onB; for(const side of ['a','b']) hide?C.visible[side].delete(cl.class_id):C.visible[side].add(cl.class_id);
      C.solo=null; buildCmpLayers(); cmpRender(); renderCmpClasses(); });
    el.addEventListener('dblclick',e=>{
      if(C.refine.side){
        const maskBar=e.target.closest('.cmp-mask-bar');
        if(maskBar){ clearTimeout(maskBar._toggleTimer); return; }
        clearTimeout(el._selectTimer);
        selectCmpClass(cl.class_id);
        C.refine.flash={cid:cl.class_id,sides:maskBar?[maskBar.dataset.side]:['a','b'],start:performance.now(),dur:500};
        updateCmpRefineUI(); cmpRender();
        setTimeout(()=>{ if(C.refine.flash?.cid===cl.class_id){ C.refine.flash=null; cmpRender(); } },500); return;
      }
      C.solo = C.solo===cl.class_id? null : cl.class_id; buildCmpLayers(); cmpRender(); renderCmpClasses();
    });
    box.appendChild(el);
  }
}
function cmpRefinePointPosition(x,y,side=C.refine.side){
  if(C.mode!=='dual') return [C.view.panX+x*C.view.scale,C.view.panY+y*C.view.scale];
  const g=cmpDualGeometry(side); return [g.ox+x*g.scale,g.oy+y*g.scale];
}
function cmpDualGeometry(side=C.refine.side){
  const st=$('cmpStage'), vw=st.clientWidth, vh=st.clientHeight, pw=vw/2;
  const x0=cmpDisplayPosition(side)===0?0:pw, view=C.dualViews[side];
  if(!view.initialized&&C.w&&C.h){
    view.scale=Math.min((pw-14)/C.w,(vh-24)/C.h);
    view.panX=(pw-C.w*view.scale)/2; view.panY=(vh-C.h*view.scale)/2; view.initialized=true;
  }
  return {x0,pw,scale:view.scale,ox:x0+view.panX,oy:view.panY};
}
function drawCmpRefinePoints(){
  const cid=cmpClassId(); if(!C.refine.side||cid==null) return;
  const points=C.refine.prompts.get(cmpPromptKey(cid))||[];
  const pending=C.refine.pendingPoints
    .filter(item=>item.side===C.refine.side&&item.cid===cid&&(!item.frame||item.frame===C.frames[C.idx]))
    .map(item=>item.point);
  for(const point of [...points,...pending]){
    const [x,y]=cmpRefinePointPosition(point.x,point.y); cctx.lineWidth=2.5;
    cctx.strokeStyle=point.label===1?'#37e5a0':'#ff5d5d'; cctx.beginPath();
    if(point.label===1){ cctx.moveTo(x-6,y);cctx.lineTo(x+6,y);cctx.moveTo(x,y-6);cctx.lineTo(x,y+6); }
    else { cctx.moveTo(x-6,y);cctx.lineTo(x+6,y); }
    cctx.stroke();
  }
}
function drawCmpBrushCursor(){
  const point=C.refine.brushCursor;
  if(!C.refine.side||!C.refine.brush||!point) return;
  const [x,y]=cmpRefinePointPosition(point.x,point.y);
  const scale=C.mode==='dual'?cmpDualGeometry(C.refine.side).scale:C.view.scale;
  const radius=Math.max(2,(C.refine.brushSize/2)*scale);
  cctx.save(); cctx.beginPath(); cctx.arc(x,y,radius,0,Math.PI*2);
  cctx.fillStyle='rgba(255,255,0,.08)'; cctx.fill();
  cctx.strokeStyle='rgba(255,255,0,.95)'; cctx.lineWidth=1.25; cctx.stroke(); cctx.restore();
}
function drawCmpBrushTrail(){
  const trail=C.refine.brushTrail; if(!trail?.points?.length) return;
  // Negative strokes use a live erasure preview instead of a red paint trace.
  if(!trail.positive) return;
  const scale=C.mode==='dual'?cmpDualGeometry(trail.side).scale:C.view.scale;
  const points=trail.points.map(point=>cmpRefinePointPosition(point.x,point.y,trail.side));
  const color=C.bins[trail.cid]?.color||[55,229,160];
  cctx.save(); cctx.lineCap='round'; cctx.lineJoin='round';
  cctx.lineWidth=Math.max(2,C.refine.brushSize*scale);
  cctx.strokeStyle=`rgba(${color.join(',')},.72)`;
  cctx.beginPath(); cctx.moveTo(points[0][0],points[0][1]);
  for(let i=1;i<points.length;i++) cctx.lineTo(points[i][0],points[i][1]);
  if(points.length===1) cctx.lineTo(points[0][0]+.01,points[0][1]);
  cctx.stroke(); cctx.restore();
}
function drawCmpErasePreview(){
  const trail=C.refine.brushTrail, base=C.refine.brushBaseLayers;
  if(trail?.positive!==false||!trail.points?.length||!base) return;
  const scale=C.mode==='dual'?cmpDualGeometry(trail.side).scale:C.view.scale;
  const points=trail.points.map(point=>cmpRefinePointPosition(point.x,point.y,trail.side));

  // Punch the brush path out of the stale composite, then redraw the same
  // scene without the edited mask behind it. This makes right-drag visually
  // erase on every animation frame without rebuilding all mask layers.
  cctx.save(); cctx.globalCompositeOperation='destination-out';
  cctx.lineCap='round'; cctx.lineJoin='round'; cctx.lineWidth=Math.max(2,C.refine.brushSize*scale);
  cctx.strokeStyle='#000'; cctx.beginPath(); cctx.moveTo(points[0][0],points[0][1]);
  for(let i=1;i<points.length;i++) cctx.lineTo(points[i][0],points[i][1]);
  if(points.length===1) cctx.lineTo(points[0][0]+.01,points[0][1]);
  cctx.stroke(); cctx.restore();

  cctx.save(); cctx.globalCompositeOperation='destination-over';
  if(C.mode==='dual'){
    const st=$('cmpStage'), g=cmpDualGeometry(trail.side);
    const layer=trail.side==='a'?base.layerA:base.layerB;
    drawPanel(g.x0,g.pw,st.clientHeight,layer,cmpRefineAnn(trail.side),trail.side);
  }else{
    cctx.translate(C.view.panX,C.view.panY); cctx.scale(C.view.scale,C.view.scale);
    if(C.showFrame&&C.img){ cctx.imageSmoothingEnabled=true; cctx.drawImage(C.img,0,0,C.w,C.h); }
    cctx.imageSmoothingEnabled=false;
    if(base.layer) cctx.drawImage(base.layer,0,0,C.w,C.h);
  }
  cctx.restore();
}
function cmpImagePoint(e){
  const st=$('cmpStage'), rect=st.getBoundingClientRect();
  const sx=(e.clientX-rect.left)*(st.clientWidth/Math.max(1,rect.width));
  const sy=(e.clientY-rect.top)*(st.clientHeight/Math.max(1,rect.height));
  let x,y;
  if(C.mode==='dual'){
    const g=cmpDualGeometry(C.refine.side); if(sx<g.x0||sx>=g.x0+g.pw) return null;
    x=(sx-g.ox)/g.scale; y=(sy-g.oy)/g.scale;
  }else{ x=(sx-C.view.panX)/C.view.scale; y=(sy-C.view.panY)/C.view.scale; }
  return x>=0&&y>=0&&x<C.w&&y<C.h?{x,y}:null;
}
// Annotation-style navigation: Ctrl/Cmd-wheel zooms at the pointer; a plain
// wheel pans. In Dual, the panel below the pointer owns its independent view.
cmpCanvas.addEventListener('wheel',e=>{ if(!C.data) return; e.preventDefault();
  const r=cmpCanvas.getBoundingClientRect(), cx=e.clientX-r.left, cy=e.clientY-r.top;
  let side=null, localX=cx;
  if(C.mode==='dual'){
    const position=cx<$('cmpStage').clientWidth/2?0:1;
    side=cmpDisplaySide(position); localX=cx-cmpDualGeometry(side).x0;
  }
  const view=cmpZoomView(side);
  if(e.ctrlKey||e.metaKey) setCmpZoom(view.scale*Math.exp(-e.deltaY*.0015),side,localX,cy);
  else{
    if(e.shiftKey) view.panX-=e.deltaY;
    else { view.panY-=e.deltaY; view.panX-=e.deltaX; }
    cmpRender();
  }
},{passive:false});
cmpCanvas.addEventListener('contextmenu',e=>e.preventDefault());
cmpCanvas.addEventListener('mousedown',e=>{
  if(C.data&&(e.button===1||S.spaceDown)){
    e.preventDefault();
    const r=cmpCanvas.getBoundingClientRect(), sx=e.clientX-r.left, sy=e.clientY-r.top;
    const side=C.mode==='dual'?cmpDisplaySide(sx<$('cmpStage').clientWidth/2?0:1):null;
    const view=cmpZoomView(side);
    C.panning=true; C.panStart={x:sx,y:sy,panX:view.panX,panY:view.panY,side};
    cmpCanvas.style.cursor='grabbing'; return;
  }
  if(C.refine.side&&C.refine.brush&&e.button!==1){
    const point=cmpImagePoint(e); if(point){
      e.preventDefault(); const cid=cmpClassId(), side=C.refine.side;
      C.refine.brushCursor=point; C.refine.brushBefore=cid!=null&&C.bins[cid]?C.bins[cid][side].slice(0):null;
      C.refine.brushing=true; C.refine.brushPositive=e.button===0; C.refine.brushLast=[point.x,point.y];
      C.refine.brushTrail={side,cid,positive:C.refine.brushPositive,points:[point]};
      C.refine.brushBaseLayers=C.refine.brushPositive?null:makeCmpLayers({side,cid});
      paintCmpCircle(point.x,point.y,C.refine.brushPositive); scheduleCmpBrushRender();
    }
    return;
  }
  if(C.refine.side&&e.button!==1){ const point=cmpImagePoint(e); if(point){ e.preventDefault(); runCmpRefinePoint({...point,label:e.button===2?0:1}); } return; }
  if(C.mode==='dual') return;
  C.panning=true; const r=cmpCanvas.getBoundingClientRect();
  C.panStart={x:e.clientX-r.left,y:e.clientY-r.top,panX:C.view.panX,panY:C.view.panY,side:null};
  cmpCanvas.style.cursor='grabbing';
});
window.addEventListener('mousemove',e=>{
  if(C.open&&C.refine.side&&C.refine.brush){
    const point=cmpImagePoint(e); C.refine.brushCursor=point;
    if(C.refine.brushing&&point){
      const last=C.refine.brushLast||[point.x,point.y]; paintCmpLine(last[0],last[1],point.x,point.y,C.refine.brushPositive);
      C.refine.brushLast=[point.x,point.y]; C.refine.brushTrail?.points.push(point); scheduleCmpBrushRender();
    }
    else cmpRender();
    if(C.refine.brushing) return;
  }
  if(!C.panning) return;
  const r=cmpCanvas.getBoundingClientRect(), view=cmpZoomView(C.panStart.side);
  view.panX=C.panStart.panX+(e.clientX-r.left-C.panStart.x);
  view.panY=C.panStart.panY+(e.clientY-r.top-C.panStart.y);
  cmpRender();
});
window.addEventListener('mouseup',()=>{
  if(C.refine.brushing){
    C.refine.brushing=false; C.refine.brushLast=null;
    const cid=cmpClassId(), side=C.refine.side;
    if(cid!=null&&side){
      const item=C.bins[cid], after=item[side].slice(0), before=C.refine.brushBefore||after.slice(0);
      cmpMaskHistory(side,cid,before,after); C.refine.brushBefore=null; C.refine.brushTrail=null; C.refine.brushBaseLayers=null;
      buildCmpLayers(); renderCmpClasses(); cmpRender(); updateCmpRefineUI(); scheduleCmpLiveMetrics(cid);
    }else{ C.refine.brushTrail=null; C.refine.brushBaseLayers=null; cmpRender(); }
  }
  if(C.panning){ C.panning=false; syncCmpCursor(); }
});
window.addEventListener('resize',()=>{ if(C.open){ compareResize(); cmpRender(); } });

// -- import mask / prompts (folder browser, defaults to the configured path) --
/* ---------- sticky import folders ----------
   First use asks for a folder; every later press reuses it silently.
   The folder icon fused into each button re-opens the picker to change it.        */
const LS = {
  get(k){ try{ return localStorage.getItem(k) || null; }catch(_){ return null; } },
  set(k,v){ try{ v? localStorage.setItem(k,v) : localStorage.removeItem(k); }catch(_){} },
};
const IMPORT_KIND = {
  mask:    {key:'issas.maskDir',    state:'maskDir',    btn:'importMaskBtn',
            label:'Import mask',    title:'Choose mask folder (<frame>.png / .txt)'},
  prompts: {key:'issas.promptsDir', state:'promptsDir', btn:'importPromptsBtn',
            label:'Import prompts', title:'Choose Supervisely prompts folder'},
};
S.maskDir    = LS.get(IMPORT_KIND.mask.key);
S.promptsDir = LS.get(IMPORT_KIND.prompts.key);

function setImportDir(kind, dir){
  const K = IMPORT_KIND[kind];
  S[K.state] = dir || null;
  LS.set(K.key, dir || null);
  updateImportBtn(kind);
}
function updateImportBtn(kind){
  const K = IMPORT_KIND[kind], b = $(K.btn); if(!b) return;
  const dir = S[K.state];
  b.classList.toggle('has-dir', !!dir);
  b.title = dir ? `${K.label} from:\n${dir}\n\nPress again to reuse this folder · folder icon to change`
                : `${K.label} — pick a folder the first time, then it is reused`;
}
function updateImportBtns(){ updateImportBtn('mask'); updateImportBtn('prompts'); }

// open the picker; on select remember the folder and (optionally) import straight away
async function chooseImportDir(kind, thenImport){
  const K = IMPORT_KIND[kind];
  let start=S[K.state];
  if(!start && kind==='mask'){
    try{ const d=await API.get('/api/import_mask/default_dir'); start=d.dir||null; }catch(_){}
  }
  openBrowser({
    title: K.title,
    start: start || $('folderPath').value.trim() || S.defaultPath,
    onSelect: (dir)=>{
      if(!dir) return;
      setImportDir(kind, dir);
      if(thenImport) (kind==='mask'? doImportMask : doImportPrompts)(dir);
      else toast((kind==='mask'?'Mask':'Prompts')+' folder set','ok');
    },
  });
}
function runImport(kind){
  if(!S.count){ toast('Open a folder first'); return; }
  const dir = S[IMPORT_KIND[kind].state];
  if(dir) (kind==='mask'? doImportMask : doImportPrompts)(dir);   // remembered — go straight in
  else chooseImportDir(kind, true);                               // first time — ask, then import
}

$('importMaskBtn').addEventListener('click', ()=>runImport('mask'));
$('importMaskDirBtn').addEventListener('click', e=>{ e.stopPropagation(); chooseImportDir('mask', false); });
$('importPromptsDirBtn').addEventListener('click', e=>{ e.stopPropagation(); chooseImportDir('prompts', false); });

// Drop every object on the current frame: list entries, masks and pending prompts.
function clearAllObjects(){
  S.objects.clear(); S.order=[]; S.currentId=null;
  S.points.clear(); S.boxes.clear();
}
async function importMaskInto(dir, replace){
  const {ok,j}=await API.post('/api/import_mask',{dir, frame_idx:S.idx});
  if(!ok) return {ok:false, n:0, detail:j.detail};   // failed fetch clears nothing
  if(replace){
    clearAllObjects();
    S.rawMasks.delete(S.idx);   // these masks came from disk, so there is no SAM2 proposal behind them
  }
  for(const o of j.objects){ const obj=ensureObject(o.obj_id,o.class_id,o.name,o.color); obj.bin=await pngB64ToBin(o.mask); invalidateTint(obj); }
  if(replace && S.order.length){ rebuildObjList(); selectObject(S.order[0]); }
  return {ok:true, n:j.objects.length};
}
// Importing masks means the frames are already annotated, so propagation would
// overwrite them — but only the FIRST import of a case flips the switch. After that
// the user's own Propagation ON/OFF choice is respected on every repeat import.
async function doImportMask(dir){
  if(!dir) return;
  setImportDir('mask', dir);          // remember whatever folder actually got used
  const before=captureFull();         // pushed only if the import actually replaces anything
  showOverlay('Importing mask…');
  const r=await importMaskInto(dir, true);   // replace: imported mask becomes the whole frame
  hideOverlay();
  if(!r.ok){ toast((r.detail||'import failed')+' — use the folder icon to change','err'); return; }
  pushHistory(before);                // Ctrl+Z now restores the pre-import frame
  if(!importedThisSession){
    importedThisSession=true;
    S.propagation=false; $('propBtn').textContent='Propagation: OFF'; $('propBtn').classList.remove('on');
  }
  // A disk import is a clean baseline. Any dirty flag that already existed is
  // preserved, but importing alone must not trigger the unsaved-edit reminder.
  rebuildObjList(); render(); toast('Imported '+r.n+' masks','ok');
}

$('importPromptsBtn').addEventListener('click', ()=>runImport('prompts'));
async function doImportPrompts(dir){
  if(!dir) return;
  setImportDir('prompts', dir);
  showOverlay('Importing prompts…');
  const {ok,j}=await API.post('/api/import_prompts',{dir, frame_idx:S.idx}); hideOverlay();
  if(!ok){ toast((j.detail||'import failed')+' — use the folder icon to change','err'); return; }
  for(const o of j.current){ const obj=ensureObject(o.obj_id,o.class_id,o.name,o.color); obj.bin=await pngB64ToBin(o.mask); invalidateTint(obj); captureRaw(obj.id, obj.bin, 'prompt', true); }
  rebuildObjList(); render();
  const pend=j.pending_frames&&j.pending_frames.length? ` · ${j.pending_frames.length} frames pending`:'';
  toast(`Imported ${j.current.length} prompts${pend}`,'ok');
}

// -- save --
$('saveBtn').addEventListener('click',()=>{
  if(C.open){ if(C.refine.side) saveCmpRefine(); else toast('Select Refine A or Refine B first'); return; }
  saveMasks();
});
$('exportSamRaw').addEventListener('change', async e=>{
  if(!e.target.checked){
    const okd=await uiConfirm('SAM-raw masks will no longer be saved to the _sam folder. This removes the SAM-vs-human comparison data. Continue?', {title:'Disable SAM-raw saving', okText:'Disable', danger:true});
    if(!okd){ e.target.checked=true; } else { toast('SAM-raw saving disabled','err'); }
  } else { toast('SAM-raw saving enabled','ok'); }
});
$('pngBrowse').addEventListener('click', ()=>openBrowser({title:'Choose PNG output folder', start:$('pngDir').value||S.defaultPath, onSelect:p=>{ if(p) $('pngDir').value=p; }}));
$('yoloBrowse').addEventListener('click', ()=>openBrowser({title:'Choose YOLO output folder', start:$('yoloDir').value||S.defaultPath, onSelect:p=>{ if(p) $('yoloDir').value=p; }}));

// -- frame nav --
$('prevBtn').addEventListener('click',()=>requestFrame(S.idx-1));
$('nextBtn').addEventListener('click',()=>requestFrame(S.idx+1));
$('frameSlider').addEventListener('change',e=>requestFrame(+e.target.value));
$('frameSlider').addEventListener('input',e=>{ $('position').textContent=`${(+e.target.value)+1} / ${S.count}`; });
$('frameSlider').addEventListener('pointermove',showVideoTimelineTip);
$('frameSlider').addEventListener('pointerleave',()=>$('videoTimelineTip').classList.add('hidden'));
$('frameSlider').addEventListener('contextmenu',e=>{
  e.preventDefault(); $('videoTimelineTip').classList.add('hidden'); openContextVideo(timelineIndex(e),true);
});
$('videoOpen').addEventListener('click',()=>openContextVideo(S.idx,true));
$('videoSet').addEventListener('click',configureVideoFolder);
$('videoPath').addEventListener('keydown',e=>{ if(e.key==='Enter') configureVideoFolder(); });
$('videoBrowse').addEventListener('click',()=>openBrowser({title:'Choose context video folder',start:$('videoPath').value||S.defaultPath,onSelect:p=>{ if(p){ $('videoPath').value=p; configureVideoFolder(); } }}));
$('videoClose').addEventListener('click',closeContextVideo);
$('videoPlayPause').addEventListener('click',toggleVideoPlay);
$('videoReplay').addEventListener('click',()=>seekContextVideo(V.clipStart,true));
$('videoLoop').addEventListener('click',()=>setVideoLoop(!V.loop));
$('videoPrevFrame').addEventListener('click',()=>stepVideo(-1));
$('videoNextFrame').addEventListener('click',()=>stepVideo(1));
$('videoCenter').addEventListener('click',()=>seekContextVideo(V.center,false));
$('videoSeek').addEventListener('input',e=>{ contextVideo.pause(); contextVideo.currentTime=Number(e.target.value); updateVideoControls(); });
$('videoSeek').addEventListener('pointerdown',showVideoSeekTimestamp);
$('videoSeek').addEventListener('click',showVideoSeekTimestamp);
$('videoSeekTimestamp').addEventListener('click',copyVideoSeekTimestamp);
$('videoSpeed').addEventListener('change',e=>setVideoPlaybackRate(e.target.value));
$('videoContext10').addEventListener('click',()=>setVideoContextSeconds(10,true,true));
$('videoContext30').addEventListener('click',()=>setVideoContextSeconds(30,true,true));
contextVideo.addEventListener('click',toggleVideoPlay);
contextVideo.addEventListener('loadedmetadata',()=>{
  setVideoPlaybackRate(V.playbackRate,false);
  if(Number.isFinite(contextVideo.duration)){ V.duration=contextVideo.duration; V.clipEnd=Math.min(V.duration,V.center+V.contextSeconds); $('videoSeek').max=V.clipEnd; }
  updateVideoFrameMark();
  if(!V.seekPending) $('videoLoading').classList.add('hidden');
  updateVideoControls();
});
contextVideo.addEventListener('canplay',()=>{ if(!V.seekPending) $('videoLoading').classList.add('hidden'); });
contextVideo.addEventListener('waiting',()=>$('videoLoading').classList.remove('hidden'));
contextVideo.addEventListener('playing',()=>{ if(!V.seekPending) $('videoLoading').classList.add('hidden'); updateVideoControls(); });
contextVideo.addEventListener('pause',updateVideoControls);
contextVideo.addEventListener('timeupdate',()=>{
  if(contextVideo.currentTime>=V.clipEnd-.02 && !contextVideo.paused && !V.seekPending){
    if(V.loop) seekContextVideo(V.clipStart,true);
    else { contextVideo.pause(); contextVideo.currentTime=V.clipEnd; }
  }
  updateVideoControls();
});
contextVideo.addEventListener('error',()=>{ $('videoLoading').classList.add('hidden'); toast('The context video could not be decoded','err'); });
document.querySelectorAll('.video-mode').forEach(btn=>btn.addEventListener('click',()=>setVideoMode(btn.dataset.videoMode)));
if(window.ResizeObserver) new ResizeObserver(syncVideoSplitDirection).observe($('videoWindow').closest('.stage'));

// The title bar moves only the floating player. Resize is provided by the window's lower-right edge.
$('videoDragHandle').addEventListener('pointerdown',e=>{
  if(e.button!==0||V.mode!=='float'||e.target.closest('button')) return;
  e.preventDefault();
  const handle=e.currentTarget, pointerId=e.pointerId;
  const win=$('videoWindow'), rect=win.getBoundingClientRect(), dx=e.clientX-rect.left, dy=e.clientY-rect.top;
  let finished=false;
  const finish=()=>{
    if(finished) return;
    finished=true;
    handle.classList.remove('dragging');
    handle.removeEventListener('pointermove',move);
    handle.removeEventListener('pointerup',finish);
    handle.removeEventListener('pointercancel',finish);
    handle.removeEventListener('lostpointercapture',finish);
    window.removeEventListener('pointerup',finish,true);
    window.removeEventListener('blur',finish);
    if(handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
  };
  const move=ev=>{
    if(ev.pointerId!==pointerId) return;
    // Recover even if pointerup happened outside the browser and was never delivered.
    if((ev.buttons&1)===0){ finish(); return; }
    const x=Math.max(0,Math.min(window.innerWidth-win.offsetWidth,ev.clientX-dx));
    const y=Math.max(54,Math.min(window.innerHeight-win.offsetHeight,ev.clientY-dy));
    win.style.left=x+'px'; win.style.top=y+'px'; win.style.right='auto';
    if(CA.open&&CA.mode==='dock') positionContextAnnotation();
  };
  handle.classList.add('dragging');
  handle.setPointerCapture(pointerId);
  handle.addEventListener('pointermove',move);
  handle.addEventListener('pointerup',finish);
  handle.addEventListener('pointercancel',finish);
  handle.addEventListener('lostpointercapture',finish);
  window.addEventListener('pointerup',finish,true);
  window.addEventListener('blur',finish);
});
$('jumpBtn').addEventListener('click',jump);
$('jumpInput').addEventListener('keydown',e=>{ if(e.key==='Enter') jump(); });
function jump(){
  const v=$('jumpInput').value.trim(); if(!v) return;
  let idx=parseInt(v,10)-1;
  if(isNaN(idx)) idx=S.frames.findIndex(n=>n.startsWith(v)||n.split('.')[0]===v);
  if(idx>=0&&idx<S.count) requestFrame(idx); else toast('Frame not found','err');
}

// unsaved-changes guard on frame change
let pendingFrame=null;
function requestFrame(idx){
  idx=clampi(idx,0,S.count-1);
  if(idx===S.idx) return;
  if(S.dirty){
    if(!$('saveReminder').classList.contains('hidden')) return;  // reminder already open
    pendingFrame=idx; $('frameSlider').value=S.idx;
    $('saveReminder').classList.remove('hidden'); return;
  }
  loadFrame(idx);
}
$('remCancel').addEventListener('click',()=>{ pendingFrame=null; $('frameSlider').value=S.idx; $('saveReminder').classList.add('hidden'); });
$('remIgnore').addEventListener('click',()=>{
  $('saveReminder').classList.add('hidden'); S.dirty=false;
  const t=pendingFrame; pendingFrame=null; if(t!=null) loadFrame(t);
});
$('remSave').addEventListener('click',()=>{ $('saveReminder').classList.add('hidden'); saveMasks(); });

// -- keyboard --
window.addEventListener('keydown',(e)=>{
  // fullscreen first: it must work even while a path field has focus, and the
  // browser's own Ctrl+F find bar is useless in this tool
  if((e.ctrlKey||e.metaKey) && (e.key==='f'||e.key==='F')){ e.preventDefault(); toggleFullscreen(); return; }
  if(CA.open){
    const key=e.key.toLowerCase();
    const contextTyping=!!document.activeElement.closest?.('.context-edit');
    if((e.ctrlKey||e.metaKey)&&key==='s'){ e.preventDefault(); saveContextAnnotation(); return; }
    if((e.ctrlKey||e.metaKey)&&key==='z'){ e.preventDefault(); contextUndo(); return; }
    if((e.ctrlKey||e.metaKey)&&key==='y'){ e.preventDefault(); contextRedo(); return; }
    if(contextTyping) return;
    if(!(e.ctrlKey||e.metaKey||e.altKey)&&key==='q'){ e.preventDefault(); importContextAnnotation(); return; }
    if(!(e.ctrlKey||e.metaKey||e.altKey)&&key==='o'){ e.preventDefault(); closeContextAnnotation(); return; }
  } else if(V.open&&!(e.ctrlKey||e.metaKey||e.altKey)&&e.key.toLowerCase()==='o'){
    e.preventDefault(); openContextAnnotation(); return;
  }
  if(e.code==='Space'){ S.spaceDown=true; if(!S.brushing&&!S.dragBox) canvas.style.cursor='grab'; }
  const plainKey=!(e.ctrlKey||e.metaKey||e.altKey);
  const sizeKey=e.key.toLowerCase();
  if(plainKey&&(sizeKey==='x'||sizeKey==='c')&&adjustActiveBrushSize(sizeKey==='x'?-2:2)){
    e.preventDefault(); return;
  }
  const activeEl=document.activeElement, tag=activeEl.tagName;
  const inputType=(activeEl.type||'').toLowerCase();
  const textEntry=activeEl.isContentEditable||tag==='TEXTAREA'||
    (tag==='INPUT'&&!['range','checkbox','radio','button'].includes(inputType));
  // Range sliders keep keyboard focus after use. They should not disable the
  // global Review A/B shortcuts; text/number fields still retain normal digit
  // entry semantics.
  if(C.open&&!textEntry&&plainKey&&(e.code==='Digit1'||e.code==='Numpad1')){ e.preventDefault(); startCmpRefine('a'); return; }
  if(C.open&&!textEntry&&plainKey&&(e.code==='Digit2'||e.code==='Numpad2')){ e.preventDefault(); startCmpRefine('b'); return; }
  if(textEntry) return;
  // when the Compare window is open, A/D drive its frames
  if(C.open){
    const k=e.key.toLowerCase();
    if((e.ctrlKey||e.metaKey)&&k==='s'){ e.preventDefault(); saveCmpRefine(); return; }
    if((e.ctrlKey||e.metaKey)&&k==='z'){ e.preventDefault(); undoCmpRefine(); return; }
    if((e.ctrlKey||e.metaKey)&&k==='y'){ e.preventDefault(); redoCmpRefine(); return; }
    if(!(e.ctrlKey||e.metaKey||e.altKey)&&k==='b'){ e.preventDefault(); $('brushBtn').click(); return; }
    if(!(e.ctrlKey||e.metaKey||e.altKey)&&k==='g'){ e.preventDefault(); applyPP('gaussian'); return; }
    if(!(e.ctrlKey||e.metaKey||e.altKey)&&k==='f'){ e.preventDefault(); applyPP('morph'); return; }
    if(!(e.ctrlKey||e.metaKey||e.altKey)&&k==='h'){ e.preventDefault(); applyPP('components'); return; }
    if(!(e.ctrlKey||e.metaKey||e.altKey)&&(k==='q'||e.code==='Digit0')){ e.preventDefault(); importCmpMasks(); return; }
    if(!(e.ctrlKey||e.metaKey||e.altKey)&&k==='r'){ e.preventDefault(); resetCmpCurrentMask(); return; }
    if(!(e.ctrlKey||e.metaKey||e.altKey)&&k==='p'){ e.preventDefault(); openContextVideo(S.idx,true); return; }
    if(!(e.ctrlKey||e.metaKey||e.altKey)&&k==='['){ e.preventDefault(); togglePanel('left'); return; }
    if(!(e.ctrlKey||e.metaKey||e.altKey)&&k===']'){ e.preventDefault(); togglePanel('right'); return; }
    if(!(e.ctrlKey||e.metaKey||e.altKey)&&k==='\\'){ e.preventDefault(); togglePanel('bottom'); return; }
    if(e.code==='Space'){ S.spaceDown=true; cmpCanvas.style.cursor='grab'; return; }
    if(k==='a'){ requestCmpFrame(C.idx-1); e.preventDefault(); return; }
    if(k==='d'){ requestCmpFrame(C.idx+1); e.preventDefault(); return; }
    if(C.refine.side&&k==='w'){ cycleCmpClass(-1); e.preventDefault(); return; }
    if(C.refine.side&&k==='s'){ cycleCmpClass(1); e.preventDefault(); return; }
    if(C.refine.side&&k==='t'){ toggleCmpClassVisibility(); e.preventDefault(); return; }
    if(C.refine.side&&k==='y'){ toggleCmpAllVisibility(); e.preventDefault(); return; }
    if(e.key==='Escape'){ closeCompareWorkspace(); return; }
    return;
  }
  if(e.ctrlKey||e.metaKey){
    if(e.key==='z'){ e.preventDefault(); undo(); return; }
    if(e.key==='s'){ e.preventDefault(); saveMasks(); return; }
  }
  switch(e.key.toLowerCase()){
    case 'a': requestFrame(S.idx-1); break;
    case 'd': requestFrame(S.idx+1); break;
    case 'w': cycleObject(-1); break;
    case 's': cycleObject(1); break;
    case 'q': $('importMaskBtn').click(); break;
    case 'g': applyPP('gaussian'); break;
    case 'f': applyPP('morph'); break;
    case 'h': applyPP('components'); break;
    case 'b': $('brushBtn').click(); break;
    case 't': { const o=S.objects.get(S.currentId); if(o){o.visible=!o.visible; rebuildObjList(); render();} break; }
    case 'y': S.vis.all=!S.vis.all; render(); break;
    case 'p': openContextVideo(S.idx,true); break;
    case '[': togglePanel('left'); break;
    case ']': togglePanel('right'); break;
    case '\\': togglePanel('bottom'); break;
    case 'r': { const id=S.currentId; if(id!=null){ snapshot(); S.points.delete(id); S.boxes.delete(id);
                const o=S.objects.get(id); o.bin=new Uint8Array(S.W*S.H); invalidateTint(o); S.dirty=true; render(); } break; }
  }
});
window.addEventListener('keyup',(e)=>{ if(e.code==='Space'){ S.spaceDown=false; canvas.style.cursor=S.brush?'none':'crosshair'; if(C.open) syncCmpCursor(); } });

// ---------- folder browser (server-side directory picker) ----------
let browseCurrent=null, browseOnSelect=null, browseExts=null;
async function openBrowser(opts){
  opts=opts||{};
  browseOnSelect=opts.onSelect||null;
  browseExts=opts.exts||null;                 // when set, files are listed and pickable
  $('browserTitle').textContent=opts.title||'Select frame folder';
  $('browserSelect').style.display = browseExts? 'none' : '';   // file mode: pick a file, not the folder
  const start=('start' in opts)? opts.start : ($('folderPath').value.trim()||null);
  await loadBrowse(start);
  $('browser').classList.remove('hidden');
  // must run AFTER the modal is visible: while it is display:none the textarea's
  // scrollHeight is 0, which would collapse the field and clip the path
  autoSizePath();
}
async function loadBrowse(path){
  const {ok,j}=await API.post('/api/browse',{path, exts:browseExts});
  if(!ok){ toast(j.detail||'cannot open path','err'); return; }
  browseCurrent=j.path;
  $('browserPath').value=j.path;
  $('browserPath').title=j.path;
  autoSizePath();
  const info=$('browserInfo');
  if(browseExts){ const n=(j.files||[]).length; info.textContent=`${n} matching file${n===1?'':'s'} · click one to pick`; info.classList.toggle('browser-info-ok', n>0); }
  else if(j.image_count>0){ info.textContent=`${j.image_count} images in this folder`; info.classList.add('browser-info-ok'); }
  else { info.textContent='no images in this folder'; info.classList.remove('browser-info-ok'); }
  const list=$('browserList'); list.innerHTML='';
  if(j.parent){
    const up=document.createElement('div'); up.className='browser-row up';
    up.innerHTML='<span class="ico">↑</span><span>..</span>';
    up.addEventListener('click',()=>loadBrowse(j.parent)); list.appendChild(up);
  }
  for(const d of j.dirs){
    const row=document.createElement('div'); row.className='browser-row';
    row.innerHTML=`<span class="ico">▸</span><span>${d}</span>`;
    const child=(j.path.replace(/\/+$/,''))+'/'+d;
    row.addEventListener('click',()=>loadBrowse(child));
    list.appendChild(row);
  }
  for(const f of (j.files||[])){
    const row=document.createElement('div'); row.className='browser-row file';
    row.innerHTML=`<span class="ico">📄</span><span>${f}</span>`;
    const fp=(j.path.replace(/\/+$/,''))+'/'+f;
    row.addEventListener('click',()=>{ $('browser').classList.add('hidden'); const cb=browseOnSelect; browseOnSelect=null; if(cb) cb(fp); });
    list.appendChild(row);
  }
}
$('browseBtn').addEventListener('click', ()=>openBrowser());
// the path field is a textarea so long paths wrap; grow it to fit (capped by CSS max-height)
function autoSizePath(){
  const el=$('browserPath'); if(!el) return;
  if(!el.offsetParent) return;          // hidden: scrollHeight would be 0 and collapse the field
  el.style.height='auto';
  el.style.height=el.scrollHeight+'px';
}
$('browserPath').addEventListener('input', autoSizePath);
function browserGoToTyped(){
  const p=$('browserPath').value.replace(/[\r\n]+/g,'').trim().replace(/\\/g,'/');
  if(p) loadBrowse(p);
}
$('browserPath').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); browserGoToTyped(); } });
$('browserPathGo').addEventListener('click', browserGoToTyped);
$('browserPathCopy').addEventListener('click', ()=>{
  const p=(browseCurrent||'').replace(/\\/g,'/'); if(!p) return;
  (navigator.clipboard? navigator.clipboard.writeText(p) : Promise.reject())
    .then(()=>toast('Path copied','ok'))
    .catch(()=>{ const t=document.createElement('textarea'); t.value=p; document.body.appendChild(t); t.select(); try{document.execCommand('copy'); toast('Path copied','ok');}catch(_){toast('Copy failed','err');} t.remove(); });
});
$('browserNewFolder').addEventListener('click', async ()=>{
  if(!browseCurrent){ return; }
  const name=await uiPrompt('New folder name (created inside the current folder):', {title:'New folder', okText:'Create'});
  if(!name) return;
  const {ok,j}=await API.post('/api/mkdir',{parent:browseCurrent, name});
  if(!ok){ toast(j.detail||'could not create folder','err'); return; }
  loadBrowse(j.path);   // navigate into the new folder
  toast('Created '+name,'ok');
});
$('browserClose').addEventListener('click',()=>$('browser').classList.add('hidden'));
$('browser').addEventListener('click',e=>{ if(e.target.id==='browser') $('browser').classList.add('hidden'); });
$('browserSelect').addEventListener('click',()=>{
  const path=browseCurrent;
  $('browser').classList.add('hidden');
  if(browseOnSelect){ const cb=browseOnSelect; browseOnSelect=null; cb(path); }
  else { if(path) $('folderPath').value=path; toast('Path set — click Open folder','ok'); }
});

// ---------- File-tree drawer ----------
function setDrawer(folded){
  const d=$('fileDrawer'); d.classList.toggle('folded', folded);
  if(!folded && !$('fdTree').dataset.loaded) loadTreeRoot();
  // reflow the canvas to the new width (mid + end of the width transition)
  requestAnimationFrame(resizeCanvas);
  setTimeout(resizeCanvas, 160);
}
$('filesToggle').addEventListener('click', ()=>setDrawer(!$('fileDrawer').classList.contains('folded')));
$('fdFold').addEventListener('click', ()=>setDrawer(true));
$('fdTab').addEventListener('click', ()=>setDrawer(false));
$('fdUp').addEventListener('click', ()=>{
  const r=$('fdRoot').value.trim().replace(/\/+$/,''); const p=r.replace(/\/[^\/]*$/,'')||'/';
  $('fdRoot').value=p; $('fdTree').dataset.loaded=''; renderTreeRoot(p);
});
$('fdRootBrowse').addEventListener('click', ()=>openBrowser({title:'Choose data root', start:$('fdRoot').value||null, onSelect:p=>{ if(p){ $('fdRoot').value=p; $('fdTree').dataset.loaded=''; renderTreeRoot(p); } }}));
$('fdRootSet').addEventListener('click', ()=>{ $('fdTree').dataset.loaded=''; renderTreeRoot($('fdRoot').value.trim()); });
$('userField').addEventListener('change', e=>{ S.user=e.target.value.trim()||'ISSAS_USER'; });

// ---------- Setup panel: classes + model ----------
$('setupToggle').addEventListener('click', ()=>{ $('setupToggle').classList.toggle('open'); $('setupBody').classList.toggle('hidden'); });
function resetAnnotationState(){
  S.objects.clear(); S.order=[]; S.currentId=null; S.frameMasks.clear(); S.rawMasks.clear();
  S.dirty=false; rebuildObjList(); render();
}
function applyClasses(j, source){
  S.classMap={...(j.class_map||{})};
  S.classGroups={tissue:j.tissue||{}, instrument:j.instrument||{}};
  if(source!==undefined) S.classSource=source;
  updateClassBadge();
  resetAnnotationState();
}
function updateClassBadge(){
  const names=Object.keys(S.classMap); const n=names.length;
  $('classInfo').textContent=`${n} classes`;
  const b=$('setupClasses'); if(b){
    b.textContent=`${S.classSource||'classes'} · ${n}`;
    b.title=`Active class set: ${S.classSource||'—'} (${n} classes)\n`+names.join(', ');
  }
}
$('classFileBtn').addEventListener('click', ()=>$('classFile').click());
$('classBrowseBtn').addEventListener('click', ()=>openBrowser({title:'Choose class file (.json / .yaml)', exts:['.json','.yaml','.yml'], start:$('fdRoot').value||S.defaultPath, onSelect:async p=>{
  const {ok,j}=await API.post('/api/classes/load',{path:p});
  if(!ok){ toast(j.detail||'class load failed','err'); return; }
  applyClasses(j, p.replace(/\\/g,'/').split('/').pop()); toast(`Loaded ${j.n} classes — annotations reset`,'ok');
}}));
$('modelBrowseBtn').addEventListener('click', ()=>{ const cur=$('modelPath').value.trim(); const start=cur? cur.replace(/\/[^\/]*$/,''):(S.defaultPath); openBrowser({title:'Choose SAM checkpoint (.pt)', exts:['.pt','.pth'], start, onSelect:p=>{ $('modelPath').value=p; }}); });
$('modelCfgBrowseBtn').addEventListener('click', ()=>{ const cur=$('modelCfg').value.trim(); const start=cur? cur.replace(/\/[^\/]*$/,''):(S.defaultPath); openBrowser({title:'Choose model config (.yaml)', exts:['.yaml','.yml'], start, onSelect:p=>{ $('modelCfg').value=p; }}); });
$('classFile').addEventListener('change', async e=>{
  const f=e.target.files[0]; if(!f) return;
  const text=await f.text();
  const fmt=/\.ya?ml$/i.test(f.name)?'yaml':'json';
  const {ok,j}=await API.post('/api/classes/load',{text, format:fmt});
  e.target.value='';
  if(!ok){ toast(j.detail||'class load failed','err'); return; }
  applyClasses(j, f.name); toast(`Loaded ${j.n} classes — annotations reset`,'ok');
});
$('classResetBtn').addEventListener('click', async ()=>{
  const {ok,j}=await API.post('/api/classes/reset',{});
  if(!ok){ toast('reset failed','err'); return; }
  applyClasses(j, 'Gastro28 (default)'); toast('Classes reset to default','ok');
});
$('modelLoadBtn').addEventListener('click', async ()=>{
  const ckpt=$('modelPath').value.trim().replace(/\\/g,'/'); if(!ckpt){ toast('Enter a checkpoint path','err'); return; }
  const config=$('modelCfg').value.trim().replace(/\\/g,'/')||null;
  if(!await uiConfirm('Load a new SAM model? This clears SAM memory and resets the current annotations.', {title:'Load model', okText:'Load'})) return;
  showOverlay('Loading model…');
  const {ok,j}=await API.post('/api/model/load',{ckpt, config});
  if(!ok){ hideOverlay(); toast(j.detail||'model load failed','err'); return; }
  if(S.count>0){ $('overlayText').textContent='Re-initializing on current frames…'; await API.post('/api/init',{}); }
  hideOverlay();
  S.sam2=true; $('modeBadge').textContent=`SAM · ${S.device||'cuda'}`; $('modeBadge').className='badge badge-live';
  $('modelInfo').textContent='loaded';
  resetAnnotationState();
  toast('Model loaded — annotations reset','ok');
});

async function loadTreeRoot(){
  let root=$('fdRoot').value.trim();
  if(!root){ try{ const r=await API.get('/api/tree_root'); root=r.root; $('fdRoot').value=root; }catch(_){} }
  renderTreeRoot(root);
}
async function renderTreeRoot(root){
  if(!root) return;
  const box=$('fdTree'); box.innerHTML=''; box.dataset.loaded='1';
  const node=await buildTreeNode(root, (root.replace(/\/+$/,'').split('/').pop()||root), 0);
  box.appendChild(node);
  const arrow=node.querySelector('.tree-arrow'); if(arrow) arrow.click();  // auto-expand root
}
async function buildTreeNode(path, name, depth){
  const node=document.createElement('div'); node.className='tree-node';
  const row=document.createElement('div'); row.className='tree-row';
  row.innerHTML=`<span class="tree-arrow">▶</span><span class="tree-ico">📁</span><span class="tree-name" title="${name}">${name}</span><span class="tree-load" title="Load images from this folder">load</span>`;
  const children=document.createElement('div'); children.className='tree-children hidden';
  node.appendChild(row); node.appendChild(children);
  const arrow=row.querySelector('.tree-arrow');
  let loaded=false;
  async function expand(){
    if(!loaded){
      loaded=true;
      const {ok,j}=await API.post('/api/tree',{path});
      if(!ok){ toast(j.detail||'cannot read folder','err'); return; }
      if(!j.dirs.length && !j.images.length){ children.innerHTML='<div class="tree-row leaf"><span class="tree-ico">·</span><span class="tree-name">(empty)</span></div>'; }
      for(const d of j.dirs){ children.appendChild(await buildTreeNode(d.path, d.name, depth+1)); }
      for(const im of j.images.slice(0,200)){ const l=document.createElement('div'); l.className='tree-row leaf'; l.innerHTML=`<span class="tree-arrow"></span><span class="tree-ico">🖼</span><span class="tree-name">${im}</span>`; children.appendChild(l); }
      if(j.images.length>200){ const more=document.createElement('div'); more.className='tree-row leaf'; more.innerHTML=`<span class="tree-arrow"></span><span class="tree-ico">…</span><span class="tree-name">+${j.images.length-200} more images</span>`; children.appendChild(more); }
    }
    children.classList.toggle('hidden'); arrow.classList.toggle('open', !children.classList.contains('hidden'));
  }
  arrow.addEventListener('click', e=>{ e.stopPropagation(); expand(); });
  row.addEventListener('dblclick', ()=>expand());   // double-click just folds/unfolds children
  row.querySelector('.tree-load').addEventListener('click', e=>{ e.stopPropagation(); confirmLoad(path); });
  row.addEventListener('contextmenu', e=>{ e.preventDefault(); showTreeCtx(e.clientX, e.clientY, path); });
  return node;
}
let skipLoadConfirm=(()=>{
  try{ return sessionStorage.getItem('issas.skipLoadConfirm')==='1'; }
  catch(_){ return false; }
})();
async function confirmLoad(path){
  if(skipLoadConfirm){ loadImagesHere(path); return; }
  const warn = S.dirty? ' You have unsaved edits that will be discarded.' : '';
  const decision=await uiConfirm(
    `Load images from: ${path}. This clears SAM memory and starts a new case.${warn}`,
    {title:'Load images', okText:'Load', checkboxLabel:"Don't ask again"});
  if(decision.confirmed){
    if(decision.checked){
      skipLoadConfirm=true;
      try{ sessionStorage.setItem('issas.skipLoadConfirm','1'); }catch(_){}
    }
    loadImagesHere(path);
  }
}
function showTreeCtx(x,y,path){
  const m=$('fdContextMenu');
  m.innerHTML=`<button id="ctxLoad">Load images here</button><button id="ctxNew">New folder…</button>`;
  m.style.left=x+'px'; m.style.top=y+'px'; m.classList.remove('hidden');
  $('ctxLoad').onclick=()=>{ m.classList.add('hidden'); confirmLoad(path); };
  $('ctxNew').onclick=async ()=>{ m.classList.add('hidden'); const name=await uiPrompt('New folder name:', {title:'New folder', okText:'Create'}); if(!name) return;
    const {ok,j}=await API.post('/api/mkdir',{parent:path, name}); if(ok){ $('fdTree').dataset.loaded=''; renderTreeRoot($('fdRoot').value.trim()); toast('Created '+name,'ok'); } else toast(j.detail||'failed','err'); };
}
document.addEventListener('click', ()=>$('fdContextMenu').classList.add('hidden'));

async function loadImagesHere(path){
  if(await loadFolderIntoEditor(path)){
    setDefaultExportDirs(path);
    S.idx=0; await loadFrame(0,{force:true, noProp:true}); fitViewSoon();
    setDrawer(true);
    toast('Loaded '+S.count+' frames (SAM reset)','ok');
  }
}

// ---------- init ----------
(async function init(){
  applyLayout(false);          // restore saved panel widths / collapse state first
  syncFsBtn();
  fitLegendSoon();
  if(document.fonts && document.fonts.ready) document.fonts.ready.then(fitLegendSoon);
  resizeCanvas();
  updateImportBtns();          // restore remembered mask / prompts folders
  try{ const c=await API.get('/api/classes');
    S.classMap={...(c.class_map||{})};
    S.classGroups={tissue:c.tissue||{}, instrument:c.instrument||{}};
    S.classSource='Gastro28 (default)'; updateClassBadge();
  }catch(_){}
  try{ const m=await API.get('/api/model/current');
    if(m.ckpt) $('modelPath').value=m.ckpt;
    if(m.config) $('modelCfg').value=m.config;
    $('modelInfo').textContent = m.available? 'active' : (m.torch?'not loaded':'no torch');
  }catch(_){}
  try{ const d=await API.get('/api/default_path');
    S.defaultPath=d.path||null;
    if(d.path && !$('folderPath').value) $('folderPath').value=d.path;
  }catch(_){}
  try{ const u=await API.get('/api/user'); S.user=u.user||'ISSAS_USER'; $('userField').value=S.user; }catch(_){ $('userField').value=S.user; }
  try{ const r=await API.get('/api/tree_root'); if(!$('fdRoot').value) $('fdRoot').value=r.root; }catch(_){}
  try{
    const savedPath=localStorage.getItem('issas.videoPath')||'';
    localStorage.removeItem('issas.videoFps');
    if(savedPath){
      $('videoPath').value=savedPath; $('videoFps').value='';
      const {ok,j}=await API.post('/api/video/config',{path:savedPath,fps:null});
      if(ok) applyVideoStatus(j); else applyVideoStatus(await API.get('/api/video/status'));
    } else applyVideoStatus(await API.get('/api/video/status'));
  }catch(_){}
})();
